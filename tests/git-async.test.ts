import { expect, jest, test } from "bun:test";
import fs from "node:fs";
import * as gitModule from "../src/server/platform/git/git.js";
import { gitArchiveCheck, resolveWorkerBaseRef } from "../src/server/platform/git/git-archive-check.js";
import type { CommandResult, CommandRunner } from "../src/server/platform/process/command-runner.js";
import { tmuxHasWindow, tmuxNewSession } from "../src/server/platform/tmux/tmux.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { WorkerService } from "../src/server/modules/workers/worker-service.js";
import { buildArchiveWorkerTool } from "../src/server/modules/workers/tools/archive-worker.js";
import { buildRestoreWorkerTool } from "../src/server/modules/workers/tools/restore-worker.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { freshProjectEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { fakeClock } from "./helpers/fake-clock.js";
import { tempDir } from "./helpers/temp.js";
import { buildWorkersTestApp, buildProjectsTestApp, deleteJson, getJson, patchJson, postJson } from "./helpers/test-app.js";

// Every git command runs while the server goes on: a worker's create, archive
// or restore, a project's folder change, a dream's look at the branches. With
// commands no longer holding the server's one thread, two requests can
// interleave between asking git and acting on the answer, so work that
// changes a project's workers runs one at a time per project.

const ok = (stdout = ""): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });
const no = (stderr = ""): CommandResult => ({ status: 1, signal: null, stdout: "", stderr });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** git whose every call waits until released; a call that would hold the
 *  server's thread throws. */
function queuedGit(answer: (args: string[]) => CommandResult) {
  const waiting: Array<{ args: string[]; go: () => void }> = [];
  const asked: string[][] = [];
  const runner: CommandRunner = {
    run: async (_command, args) => new Promise((resolve) => { asked.push(args); waiting.push({ args, go: () => resolve(answer(args)) }); })
  };
  /** Answers the oldest (or newest) waiting call, then lets its work go on. */
  const release = async (which: "oldest" | "newest") => {
    while (waiting.length === 0) await settle();
    (which === "oldest" ? waiting.shift()! : waiting.pop()!).go();
    await settle();
  };
  /** Answers calls, newest first, until `done` settles. */
  const drain = async <T>(done: Promise<T>, which: "oldest" | "newest" = "newest"): Promise<T> => {
    let finished = false;
    done.then(() => { finished = true; }, () => { finished = true; });
    for (let turns = 0; turns < 200 && !finished; turns++) {
      if (waiting.length > 0) (which === "oldest" ? waiting.shift()! : waiting.pop()!).go();
      await settle();
    }
    return done;
  };
  return { runner, waiting, asked, release, drain };
}

test("every git question and change runs without holding the server", async () => {
  const asked: string[][] = [];
  const git = {
    runner: {
      run: async (_command: string, args: string[]) => { asked.push(args); return ok(); }
    } satisfies CommandRunner
  };
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["repository kind", () => gitModule.gitRepositoryKind("/r", git)],
    ["symbolic ref", () => gitModule.gitSymbolicRef("/r", "HEAD", git)],
    ["ref tips", () => gitModule.gitRefTips("/r", ["refs/heads/main"], git)],
    ["last commit day", () => gitModule.gitLastCommitDay("/r", "HEAD", git)],
    ["branch exists", () => gitModule.gitBranchExists("/r", "main", git)],
    ["branches made in a worktree", () => gitModule.gitBranchesCreatedInWorktree("/r", git)],
    ["branch is still", () => gitModule.gitBranchIsStill("/r", { name: "x", reflog: [] }, git)],
    ["current branch", () => gitModule.gitCurrentBranch("/r", git)],
    ["origin head", () => gitModule.gitOriginHeadRef("/r", git)],
    ["head commit", () => gitModule.gitHeadCommit("/r", git)],
    ["last rebase target", () => gitModule.gitLastRebaseTarget("/r", git)],
    ["default base", () => gitModule.gitResolveDefaultBaseRef("/r", git)],
    ["ref exists", () => gitModule.gitRefExists("/r", "main", git)],
    ["detect repository", () => gitModule.gitDetectRepository("/r", git)],
    ["common dir", () => gitModule.gitCommonDir("/r", git)],
    ["worktree paths", () => gitModule.gitWorktreePaths("/r", git)],
    ["worktree repair", () => gitModule.gitWorktreeRepair("/r", ["/w"], git)],
    ["worktree add", () => gitModule.gitWorktreeAdd("/r", "/w", "x", { newBranch: true }, git)],
    ["worktree remove", () => gitModule.gitWorktreeRemove("/w", "/r", {}, git)],
    ["branch delete", () => gitModule.gitBranchDelete("/r", "x", {}, git)],
    ["worker base", () => resolveWorkerBaseRef({ repoDir: "/r", workingDir: "/r", baseRefHint: null }, git)],
    ["archive check", () => gitArchiveCheck({ worktreePath: "/w", repoDir: "/r", workingDir: "/r", branch: "x", baseRefHint: "main" }, git)]
  ];
  for (const [name, call] of calls) {
    const before = asked.length;
    const answer = call();
    expect([name, answer instanceof Promise]).toEqual([name, true]);
    await answer;
    expect([name, asked.length > before]).toEqual([name, true]);
  }
});

const LOCKED = no([
  "fatal: Unable to create '/r/.git/index.lock': File exists.",
  "",
  "Another git process seems to be running in this repository, e.g.",
  "an editor opened by 'git commit'. Please make sure all processes",
  "are terminated then try again. If it still fails, a git process",
  "may have crashed in this repository earlier:",
  "remove the file manually to continue."
].join("\n"));

/** Answers each call with the next of `answers` (the last one again once
 *  they run out), noting when on the clock it was asked. */
function answering(answers: CommandResult[]) {
  const askedAt: number[] = [];
  const runner: CommandRunner = {
    run: async () => { askedAt.push(Date.now()); return answers[Math.min(askedAt.length - 1, answers.length - 1)]!; }
  };
  return { runner, askedAt };
}

/** The fake clock moved on 10 ms at a time until `work` settles (at most a
 *  minute): it never settles on its own while the clock stands still. */
async function onTheClock<T>(work: Promise<T>): Promise<T> {
  let finished = false;
  work.then(() => { finished = true; }, () => { finished = true; });
  for (let turns = 0; turns < 6000 && !finished; turns++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    jest.advanceTimersByTime(10);
  }
  if (!finished) throw new Error("still waiting after a minute on the clock");
  return work;
}

test("a git command that meets another git's lock on the repository is asked again, a little later each time", async () => {
  fakeClock();
  const git = answering([LOCKED, LOCKED, ok("main\n")]);
  const start = Date.now();
  expect(await onTheClock(gitModule.gitCurrentBranch("/r", { runner: git.runner }))).toBe("main");
  // It waits attempt² × 50 ms before each try again.
  expect(git.askedAt.map((at) => at - start)).toEqual([0, 50, 250]);
});

test("a lock that does not clear is given up on after ten more tries, and said as git said it", async () => {
  fakeClock();
  const git = answering([LOCKED]);
  await expect(onTheClock(gitModule.gitWorktreeAdd("/r", "/w", "x", { newBranch: true }, { runner: git.runner })))
    .rejects.toThrow("Another git process seems to be running");
  expect(git.askedAt).toHaveLength(11);
});

test("a failure other than a lock is not asked again", async () => {
  const git = answering([no("fatal: invalid reference: x"), ok()]);
  await expect(gitModule.gitWorktreeAdd("/r", "/w", "x", { newBranch: false }, { runner: git.runner })).rejects.toThrow("invalid reference");
  expect(git.askedAt).toHaveLength(1);
});

function apps(runner: CommandRunner) {
  const env = freshProjectEnv("md-git-async-");
  const archived: string[] = [];
  const deps = {
    projects: env.projects, workers: env.workers, agentStore: env.agentStore, tmuxClient: env.tmux.client,
    gitClient: { runner }, broadcast: () => {},
    tmuxRuntime: new TmuxRuntime({ tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers }),
    beforeWorkerArchive: (id: string) => { archived.push(id); }
  };
  const workersApp = buildWorkersTestApp(deps);
  workersApp.get("/ping", (c) => c.text("pong"));
  return { ...env, deps, archived, workersApp, projectsApp: buildProjectsTestApp(deps) };
}

/** git as a repository whose branches all exist; a worktree it adds is a
 *  folder on disk. */
const repository = (args: string[]): CommandResult => {
  if (args.includes("worktree") && args.includes("add")) {
    fs.mkdirSync(args[args.indexOf("add") + 1]!, { recursive: true });
    return ok();
  }
  if (args.includes("show-ref")) return ok("abc123 refs/heads/x\n");
  if (args.includes("rev-parse")) return ok(args.includes("--git-dir") ? ".git\n" : "abc123\n");
  if (args.includes("rev-list")) return ok("0\n");
  return ok();
};

test("the server answers other requests while a worker's create and archive check wait on git", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-ga" });
  await tmuxNewSession("md-ga", wd, s.tmux.client);
  const created = postJson(s.workersApp, `/api/projects/${projectId}/workers`, { name: "F", mode: "existing-branch-new-worktree", branch: "x" });
  while (git.waiting.length === 0) await settle();
  expect(await (await s.workersApp.request("/ping")).text()).toBe("pong");
  const made = await git.drain(created);
  expect(made.status).toBe(200);

  const check = getJson(s.workersApp, `/api/workers/${made.body.id}/archive-check`);
  while (git.waiting.length === 0) await settle();
  expect(await (await s.workersApp.request("/ping")).text()).toBe("pong");
  expect((await git.drain(check)).status).toBe(200);
});

test("two workers made at once whose names make one window name each get a window of their own", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gb" });
  await tmuxNewSession("md-gb", wd, s.tmux.client);
  const make = (name: string, branch: string) =>
    postJson(s.workersApp, `/api/projects/${projectId}/workers`, { name, mode: "existing-branch-new-worktree", branch });
  const both = Promise.all([make("Fix login", "x"), make("fix login", "y")]);
  const [first, second] = await git.drain(both, "oldest");
  expect([first.status, second.status]).toEqual([200, 200]);
  expect(new Set(s.workers.listActiveByProject(projectId).map((f) => f.tmuxWindowName)).size).toBe(2);
});

test("a worker archived twice at once has its archive hook run once", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gc" });
  const workerId = seedWorker(s.workers, projectId, { mode: "existing-branch-existing-worktree", branch: "x", worktreePath: wd });
  const both = Promise.all([0, 1].map(() => deleteJson(s.workersApp, `/api/workers/${workerId}?confirmed=1`)));
  const results = await git.drain(both, "oldest");
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  expect(s.archived).toEqual([workerId]);
});

test("a worker restored twice at once is restored once; the second is told it is not archived", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-ge" });
  await tmuxNewSession("md-ge", wd, s.tmux.client);
  const workerId = seedWorker(s.workers, projectId, { mode: "existing-branch-existing-worktree", branch: "x", worktreePath: wd });
  s.workers.archive(workerId);
  const service = new WorkerService(s.deps);
  const both = Promise.all([0, 1].map(() => service.restore({ id: workerId })));
  const results = await git.drain(both, "oldest");
  expect(results.map((r) => r.ok ? "restored" : r.error).sort()).toEqual(["restored", "worker is not archived"]);
  expect(s.workers.getById(workerId)!.archivedAt).toBeNull();
});

test("a project's folder change made while one of its workers is being made weighs that worker too", async () => {
  // Another repository's worktree may not stay with a project moved to this one.
  const oldRepo = tempDir("md-old-");
  const newRepo = tempDir("md-new-");
  // git answers at once, except the worker's worktree, held until released.
  let addWorktree: (() => void) | null = null;
  const answer = (args: string[]): CommandResult => {
    const dir = args[args.indexOf("-C") + 1]!;
    if (args.includes("--git-common-dir")) return ok(dir === newRepo ? "/repos/new.git\n" : "/repos/old.git\n");
    if (args.includes("worktree") && args.includes("list")) return ok("");
    if (args.includes("config")) return no();
    return repository(args);
  };
  const runner: CommandRunner = {
    run: async (_command, args) => {
      if (args.includes("worktree") && args.includes("add")) await new Promise<void>((resolve) => { addWorktree = resolve; });
      return answer(args);
    }
  };
  const s = apps(runner);
  const projectId = seedProject(s.projects, { isGit: true, workingDir: oldRepo, tmuxSessionName: "md-gd" });
  await tmuxNewSession("md-gd", oldRepo, s.tmux.client);
  const made = postJson(s.workersApp, `/api/projects/${projectId}/workers`, { name: "F", mode: "existing-branch-new-worktree", branch: "x" });
  while (!addWorktree) await settle();
  // The worker is recorded, its worktree not yet on disk. A folder change
  // free to go now would find no worktree to weigh and be done in a few turns.
  let movedEarly = false;
  const moved = patchJson(s.projectsApp, `/api/projects/${projectId}`, { workingDir: newRepo });
  void moved.then(() => { movedEarly = true; });
  for (let turns = 0; turns < 50 && !movedEarly; turns++) await settle();
  addWorktree!();
  const [worker, change] = await Promise.all([made, moved]);
  expect(worker.status).toBe(200);
  expect(change.status).toBe(409);
  expect(s.projects.getById(projectId)!.workingDir).toBe(oldRepo);
});

test("a project archived while one of its workers is being restored or made leaves no worker active", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gg" });
  await tmuxNewSession("md-gg", wd, s.tmux.client);
  const archivedWorker = seedWorker(s.workers, projectId, { name: "Old", mode: "existing-branch-existing-worktree", branch: "x", worktreePath: wd, tmuxWindowName: "old" });
  s.workers.archive(archivedWorker);
  const restored = new WorkerService(s.deps).restore({ id: archivedWorker });
  const made = postJson(s.workersApp, `/api/projects/${projectId}/workers`, { name: "New", mode: "existing-branch-new-worktree", branch: "y" });
  while (git.waiting.length === 0) await settle();
  const archived = deleteJson(s.projectsApp, `/api/projects/${projectId}`);
  await git.drain(Promise.all([restored, made, archived]), "oldest");
  expect((await archived).status).toBe(200);
  expect(s.workers.listActiveByProject(projectId)).toEqual([]);
});

test("a worker its manager asked for is not made, or restored, once that manager's thread is archived meanwhile", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gh" });
  await tmuxNewSession("md-gh", wd, s.tmux.client);
  const manager = s.agentStore.createManagerThread("Release");
  const service = new WorkerService({ ...s.deps });
  const archivedWorker = seedWorker(s.workers, projectId, { name: "Old", mode: "existing-branch-existing-worktree", branch: "x", worktreePath: wd, tmuxWindowName: "old" });
  s.workers.archive(archivedWorker);
  const made = service.create({ projectId, name: "New", mode: "existing-branch-new-worktree", branch: "y", ownerThreadId: manager.id });
  const restored = service.restore({ id: archivedWorker, ownerThreadId: manager.id });
  while (git.waiting.length === 0) await settle();
  s.agentStore.archiveThread(manager.id);
  const [create, restore] = await git.drain(Promise.all([made, restored]), "oldest");
  expect([create.ok, restore.ok]).toEqual([false, false]);
  expect(s.workers.listActiveByProject(projectId)).toEqual([]);
  // Nothing it made is left behind: the new worker's worktree went with it.
  expect(git.asked.filter((args) => args.includes("worktree") && args.includes("remove"))).toHaveLength(git.asked.filter((args) => args.includes("worktree") && args.includes("add")).length);
});

test("no worker is made in a project archived before its turn came", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gi" });
  await tmuxNewSession("md-gi", wd, s.tmux.client);
  expect((await deleteJson(s.projectsApp, `/api/projects/${projectId}`)).status).toBe(200);
  const made = await git.drain(postJson(s.workersApp, `/api/projects/${projectId}/workers`, { name: "Late", mode: "existing-branch-new-worktree", branch: "y" }));
  expect(made.status).toBe(404);
  expect(git.asked.some((args) => args.includes("worktree"))).toBe(false);
});

const asThread = (threadId: string): ToolContext => ({ threadId, wakeId: `wake-${threadId}`, scope: { kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] } });

test("a worker another thread restores while its old manager's archive waits is not archived by that old manager", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gj" });
  await tmuxNewSession("md-gj", wd, s.tmux.client);
  const oldManager = s.agentStore.createManagerThread("Old");
  const newManager = s.agentStore.createManagerThread("New");
  const workerId = seedWorker(s.workers, projectId, { name: "W", mode: "existing-branch-existing-worktree", branch: "x", worktreePath: wd, tmuxWindowName: "w", ownerThreadId: oldManager.id });
  s.workers.archive(workerId);
  const toolDeps = {
    workersStore: s.workers, projectsStore: s.projects, agentStore: s.agentStore, tmuxClient: s.tmux.client,
    gitClient: { runner: git.runner }, tmuxRuntime: s.deps.tmuxRuntime, broadcast: () => {}
  };
  const restored = buildRestoreWorkerTool(toolDeps).handler({ workerId: workerId }, asThread(newManager.id));
  while (git.waiting.length === 0) await settle();
  const archived = buildArchiveWorkerTool(toolDeps).handler({ workerId: workerId, confirmedByUser: true }, asThread(oldManager.id));
  const [restore, archive] = await git.drain(Promise.all([restored, archived]), "oldest");
  expect(restore.ok).toBe(true);
  expect(archive.ok).toBeUndefined();
  expect(s.workers.getById(workerId)).toMatchObject({ archivedAt: null, ownerThreadId: newManager.id });
});

test("a worker whose archived manager is deleted while another thread restores it leaves nothing behind", async () => {
  const git = queuedGit(repository);
  const s = apps(git.runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gm" });
  await tmuxNewSession("md-gm", wd, s.tmux.client);
  const oldManager = s.agentStore.createManagerThread("Old");
  const newManager = s.agentStore.createManagerThread("New");
  const workerId = seedWorker(s.workers, projectId, { name: "W", mode: "existing-branch-new-worktree", branch: "x", tmuxWindowName: "w", ownerThreadId: oldManager.id });
  s.workers.archive(workerId);
  s.agentStore.archiveThread(oldManager.id);
  const restored = new WorkerService({ ...s.deps }).restore({ id: workerId, ownerThreadId: newManager.id });
  while (!git.waiting.some((call) => call.args.includes("worktree") && call.args.includes("add"))) await git.release("oldest");
  // The old manager's delete takes the worker with it while git adds its worktree.
  const deletion = new ThreadDeletion({ db: s.store.db, agentStore: s.agentStore, canvases: { delete: () => null } });
  expect(deletion.delete(oldManager.id).ok).toBe(true);
  const restore = await git.drain(restored, "oldest");
  expect(restore).toMatchObject({ ok: false, status: 404 });
  expect(await tmuxHasWindow("md-gm", "w", s.tmux.client)).toBe(false);
  const worktreeCalls = (verb: string) => git.asked.filter((args) => args.includes("worktree") && args.includes(verb)).length;
  expect(worktreeCalls("add")).toBe(1);
  expect(worktreeCalls("remove")).toBe(1);
});

test("a worker is listed only once its worktree is there", async () => {
  let addWorktree: (() => void) | null = null;
  const runner: CommandRunner = {
    run: async (_command, args) => {
      if (args.includes("worktree") && args.includes("add")) await new Promise<void>((resolve) => { addWorktree = resolve; });
      return repository(args);
    }
  };
  const s = apps(runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gk" });
  await tmuxNewSession("md-gk", wd, s.tmux.client);
  const made = postJson(s.workersApp, `/api/projects/${projectId}/workers`, { name: "F", mode: "existing-branch-new-worktree", branch: "x" });
  while (!addWorktree) await settle();
  expect(s.workers.listActiveByProject(projectId)).toEqual([]);
  (addWorktree as () => void)();
  const worker = await made;
  expect(worker.status).toBe(200);
  expect(s.workers.listActiveByProject(projectId).map((f) => f.id)).toEqual([worker.body.id]);
});

test("a restore whose terminal could not open puts the worker back in the archive before git takes its worktree back", async () => {
  let removeWorktree: (() => void) | null = null;
  const runner: CommandRunner = {
    run: async (_command, args) => {
      if (args.includes("worktree") && args.includes("remove")) await new Promise<void>((resolve) => { removeWorktree = resolve; });
      return repository(args);
    }
  };
  const s = apps(runner);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-gn" });
  await tmuxNewSession("md-gn", wd, s.tmux.client);
  const workerId = seedWorker(s.workers, projectId, { name: "W", mode: "existing-branch-new-worktree", branch: "x", worktreePath: null, tmuxWindowName: "w" });
  s.workers.archive(workerId);
  const brokenTmux = {
    socketArgs: s.tmux.client.socketArgs,
    runner: { run: async (command: string, args: string[], options?: never) => args.includes("new-window") ? { status: 1, signal: null, stdout: "", stderr: "no space for new window" } : s.tmux.client.runner!.run(command, args, options) }
  };
  const service = new WorkerService({ ...s.deps, tmuxClient: brokenTmux });
  const restored = service.restore({ id: workerId });
  while (!removeWorktree) await settle();
  // Taking the worktree back is under way: the worker is already archived again.
  expect(s.workers.getById(workerId)!.archivedAt).not.toBeNull();
  (removeWorktree as () => void)();
  expect((await restored).ok).toBe(false);
});
