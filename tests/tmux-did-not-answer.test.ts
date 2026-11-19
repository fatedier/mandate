import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  tmuxHasSession,
  tmuxHasWindow,
  tmuxListSessions,
  tmuxListSessionsWithWindows,
  tmuxKillSession,
  tmuxKillWindow,
  tmuxListWindows,
  tmuxNewSession,
  tmuxNewWindow,
  type TmuxClient
} from "../src/server/platform/tmux/tmux.js";
import { CommandDidNotAnswerError } from "../src/server/platform/process/command-runner.js";
import { reconcileWorker } from "../src/server/modules/projects/project-reconcile.js";
import { tmuxReconcileAdapter } from "../src/server/modules/projects/tmux-reconcile-adapter.js";
import { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { WorkerService } from "../src/server/modules/workers/worker-service.js";
import { BroadcastCenter } from "../src/server/runtime/broadcast-center.js";
import { onHttpError } from "../src/server/app/http-app.js";
import { startFakeTmuxServer, stallingTmux } from "./helpers/fake-tmux.js";
import { freshProjectEnv } from "./helpers/fixtures.js";
import { buildWorkersTestApp, buildProjectsTestApp, deleteJson, postJson } from "./helpers/test-app.js";
import { tempDir } from "./helpers/temp.js";
import { seedProject } from "./helpers/fixtures.js";
import type { GitClient } from "../src/server/platform/git/git.js";
import type { LifecycleEvent } from "../src/server/runtime/events.js";

/**
 * A tmux that does not answer in time is not a tmux that says no. Read as
 * "no", it made Mandate open a second window beside the worker's own, split
 * an extra pane, register a project with none of its workers, and show every
 * project as gone. Bun 1.4.2's spawnSync can stall every call this way
 * (oven-sh/bun#34069); an ordinary timeout does it one call at a time.
 */

const missingTmux: TmuxClient = {
  socketArgs: [],
  runner: {
    run: async () => ({
      status: null, signal: null, stdout: "", stderr: "",
      error: Object.assign(new Error("spawnSync tmux ENOENT"), { code: "ENOENT" })
    })
  }
};

test("the probes throw when tmux does not answer, answer no when it says no, and treat no tmux at all as no", async () => {
  const fake = startFakeTmuxServer();
  try {
    await tmuxNewSession("md", "/tmp", fake.client);
    const stalled = stallingTmux(fake.client, () => true);
    const probes: Array<[string, () => Promise<unknown>]> = [
      ["has-session", () => tmuxHasSession("md", stalled)],
      ["list-sessions", () => tmuxListSessions(stalled)],
      ["list-windows", () => tmuxListWindows("md", stalled)],
      ["has-window", () => tmuxHasWindow("md", "sh", stalled)],
      ["list-windows -a", () => tmuxListSessionsWithWindows(stalled)]
    ];
    for (const [name, probe] of probes) {
      const outcome = await probe().then(() => "answered", (err: unknown) => err instanceof CommandDidNotAnswerError ? "did not answer" : String(err));
      expect([name, outcome]).toEqual([name, "did not answer"]);
    }
    expect(await tmuxHasSession("gone", fake.client)).toBe(false);
    expect(await tmuxListWindows("gone", fake.client)).toEqual([]);
    expect(await tmuxHasSession("md", missingTmux)).toBe(false);
    expect(await tmuxListSessions(missingTmux)).toEqual([]);
    expect(await tmuxListSessionsWithWindows(missingTmux)).toEqual([]);
  } finally {
    fake.cleanup();
  }
});

test("a window check that does not answer opens no second window", async () => {
  const fake = startFakeTmuxServer();
  try {
    await tmuxNewSession("md-p", "/tmp", fake.client);
    await tmuxNewWindow("md-p", "wkr", "/tmp", fake.client);
    const before = fake.calls.filter((c) => c[0] === "new-window").length;
    const stalled = stallingTmux(fake.client, (args) => args.includes("list-windows"));
    const project = { id: "p1", name: "P", workingDir: "/tmp", tmuxSessionName: "md-p", ownership: "app", isGit: false, gitRemote: null, archivedAt: null };
    const worker = { id: "f1", projectId: "p1", name: "wkr", tmuxWindowName: "wkr", worktreePath: null, ownership: "app", archivedAt: null };
    await expect(reconcileWorker(worker as never, project as never, tmuxReconcileAdapter(stalled))).rejects.toThrow(CommandDidNotAnswerError);
    expect(fake.calls.filter((c) => c[0] === "new-window").length).toBe(before);
    expect(await tmuxListWindows("md-p", fake.client)).toEqual(["sh", "wkr"]);
  } finally {
    fake.cleanup();
  }
});

function makeApps(stalls: (args: string[]) => boolean, gitClient?: GitClient) {
  const env = freshProjectEnv("md-unanswered-");
  const tmuxClient = stallingTmux(env.tmux.client, stalls);
  const events: LifecycleEvent[] = [];
  const deps = {
    projects: env.projects, workers: env.workers, agentStore: env.agentStore, tmuxClient, gitClient,
    broadcast: (event: LifecycleEvent) => { events.push(event); },
    tmuxRuntime: new TmuxRuntime({ tmuxClient, projectsStore: env.projects, workersStore: env.workers })
  };
  return { ...env, tmuxClient, events, tmuxRuntime: deps.tmuxRuntime, projectsApp: buildProjectsTestApp(deps), workersApp: buildWorkersTestApp(deps) };
}

test("a project is not created when tmux does not answer its session list", async () => {
  const s = makeApps((args) => args.includes("list-sessions"));
  const r = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  expect(r.status).toBeGreaterThanOrEqual(500);
  expect(s.projects.listActive()).toEqual([]);
});

test("archiving goes ahead when tmux does not answer about the window: the window is left, and said so", async () => {
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-windows"));
  const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  const worker = await postJson(s.workersApp, `/api/projects/${proj.body.id}/workers`, { name: "F", mode: "shared-cwd" });
  expect(worker.status).toBe(200);
  stalled = true;
  const r = await deleteJson(s.workersApp, `/api/workers/${worker.body.id}?confirmed=1`);
  expect(r.status).toBe(200);
  expect(s.workers.getById(worker.body.id)!.archivedAt).toBeTruthy();
  expect(r.body.cleanupFailures).toEqual([{ kind: "terminal", windowName: worker.body.tmuxWindowName, error: expect.stringContaining("did not answer") }]);
  expect(s.tmux.calls.some((c) => c[0] === "kill-window")).toBe(false);
});

test("a shell pane is not split when tmux does not answer which panes the worker has", async () => {
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-panes") && args.some((a) => a.includes("pane_current_command")));
  const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  const worker = await postJson(s.workersApp, `/api/projects/${proj.body.id}/workers`, { name: "F", mode: "shared-cwd" });
  const splits = () => s.tmux.calls.filter((c) => c[0] === "split-window").length;
  const before = splits();
  stalled = true;
  const r = await postJson(s.workersApp, `/api/workers/${worker.body.id}/panes`, {});
  expect(r.status).toBe(503);
  expect(splits()).toBe(before);
});

test("a split does not go ahead when tmux does not answer how big the window's panes are", async () => {
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-panes") && args.some((a) => a.includes("pane_width")));
  const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  const worker = await postJson(s.workersApp, `/api/projects/${proj.body.id}/workers`, { name: "F", mode: "shared-cwd" });
  const splits = () => s.tmux.calls.filter((c) => c[0] === "split-window").length;
  const before = splits();
  stalled = true;
  const runtime = s.tmuxRuntime;
  const outcome = await runtime.spawnPane({ workerId: worker.body.id, cwd: "/tmp" }).then(() => "split", (err) => err instanceof CommandDidNotAnswerError ? "did not answer" : String(err));
  expect(outcome).toBe("did not answer");
  expect(splits()).toBe(before);
});

test("the projects broadcast keeps what it last sent when tmux does not answer", async () => {
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-windows"));
  await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  const sent: unknown[] = [];
  const center = new BroadcastCenter({
    sse: { emit: (_event: string, data: unknown) => sent.push(data) },
    projectsStore: s.projects, workersStore: s.workers, tmuxClient: s.tmuxClient
  } as unknown as ConstructorParameters<typeof BroadcastCenter>[0]);
  await center.projectsState();
  expect(sent).toHaveLength(1);
  stalled = true;
  await expect(center.projectsState()).resolves.toBeUndefined();
  expect(sent).toHaveLength(1);
});

test("over HTTP, a command that did not answer is a 503 the user can retry", async () => {
  const app = new Hono();
  app.onError(onHttpError);
  app.get("/x", () => { throw new CommandDidNotAnswerError("tmux list-sessions"); });
  const res = await app.request("/x");
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ error: "tmux list-sessions did not answer in time. Try again." });
});

test("a project whose new session tmux does not answer about is not left active, and the user is told to retry", async () => {
  const s = makeApps((args) => args.includes("has-session"));
  const r = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  expect(r.status).toBe(503);
  expect(s.projects.listActive()).toEqual([]);
});

test("a new worker whose window check does not answer leaves no branch behind, so it can be created again", async () => {
  const gitCalls: string[][] = [];
  const git: GitClient = {
    runner: {
      async run(_command, args) {
        gitCalls.push(args);
        if (args.includes("show-ref")) return { status: 1, signal: null, stdout: "", stderr: "" }; // the branch is new
        if (args.includes("rev-parse")) return { status: 0, signal: null, stdout: "abc123\n", stderr: "" };
        return { status: 0, signal: null, stdout: "", stderr: "" }; // worktree add / remove, branch -D
      }
    }
  };
  let stalled = false;
  const s = makeApps((args) => stalled && args.includes("list-windows"), git);
  const wd = tempDir("md-wd-");
  const projectId = seedProject(s.projects, { isGit: true, workingDir: wd, tmuxSessionName: "md-g" });
  await tmuxNewSession("md-g", wd, s.tmux.client);
  stalled = true;
  const r = await postJson(s.workersApp, `/api/projects/${projectId}/workers`, { name: "F", mode: "new-branch-new-worktree", branch: "feat-x", baseRef: "main" });
  expect(r.status).toBe(503);
  expect(gitCalls.some((a) => a.includes("worktree") && a.includes("add"))).toBe(true);
  expect(gitCalls.some((a) => a.includes("branch") && a.includes("-D") && a.includes("feat-x"))).toBe(true);
  expect(s.workers.listActiveByProject(projectId)).toEqual([]);
});

test("a restore whose window check does not answer puts the worker back exactly as it was", async () => {
  let listWindows = 0;
  let stallFrom = Infinity;
  const s = makeApps((args) => args.includes("list-windows") && ++listWindows >= stallFrom);
  const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  const worker = await postJson(s.workersApp, `/api/projects/${proj.body.id}/workers`, { name: "F", mode: "shared-cwd" });
  const id = worker.body.id as string;
  const owner = s.agentStore.createManagerThread("Owner");
  s.workers.setOwner(id, owner.id);
  s.agentStore.getOrCreateThread("worker", id);
  await deleteJson(s.workersApp, `/api/workers/${id}?confirmed=1`);
  const workerThread = s.agentStore.getThreadByScope("worker", id);
  if (workerThread) s.agentStore.archiveThread(workerThread.id);
  // Archived well before: a rollback that stamps a new archive time shows.
  s.store.db.prepare("update workers set archived_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", id);
  const before = s.workers.getById(id)!;
  expect(before.archivedAt).toBeTruthy();
  // The conflict check answers (no such window); the reconcile after the rewrite does not.
  stallFrom = listWindows + 2;
  const service = new WorkerService({ projects: s.projects, workers: s.workers, agentStore: s.agentStore, tmuxClient: s.tmuxClient, tmuxRuntime: s.tmuxRuntime });
  await expect(service.restore({ id, tmuxWindowName: "renamed" })).rejects.toThrow(CommandDidNotAnswerError);
  const after = s.workers.getById(id)!;
  const shape = (f: typeof before) => ({ archivedAt: f.archivedAt, tmuxWindowName: f.tmuxWindowName, mode: f.mode, branch: f.branch, worktreePath: f.worktreePath, ownerThreadId: f.ownerThreadId });
  expect(shape(after)).toEqual(shape(before));
  expect(s.agentStore.getThreadByScope("worker", id)).toBe(null);
});

test("a restore whose window check does not answer after the session was rebuilt opens no window, and the same restore can be retried", async () => {
  let listWindows = 0;
  let stallAt = -1;
  const s = makeApps((args) => args.includes("list-windows") && ++listWindows === stallAt);
  const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  const worker = await postJson(s.workersApp, `/api/projects/${proj.body.id}/workers`, { name: "F", mode: "shared-cwd" });
  const id = worker.body.id as string;
  await deleteJson(s.workersApp, `/api/workers/${id}?confirmed=1`);
  const session = s.projects.getById(proj.body.id)!.tmuxSessionName;
  const windowName = s.workers.getById(id)!.tmuxWindowName;
  await tmuxKillSession(session, s.tmux.client);
  // 1: the conflict check (no session, no window). The rebuild opens the
  // session; the worker, not recorded until its window is there, is not
  // among those it reopens. 2: its own window's check stalls.
  stallAt = listWindows + 2;
  const service = new WorkerService({ projects: s.projects, workers: s.workers, agentStore: s.agentStore, tmuxClient: s.tmuxClient, tmuxRuntime: s.tmuxRuntime });
  await expect(service.restore({ id })).rejects.toThrow(CommandDidNotAnswerError);
  expect((await tmuxListWindows(session, s.tmux.client)).includes(windowName)).toBe(false);
  expect((await service.restore({ id })).ok).toBe(true);
});

test("a create whose window check does not answer after the session was rebuilt opens no window of its own; the ones rebuilt stay", async () => {
  let listWindows = 0;
  let stallAt = -1;
  const s = makeApps((args) => args.includes("list-windows") && ++listWindows === stallAt);
  const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  const other = await postJson(s.workersApp, `/api/projects/${proj.body.id}/workers`, { name: "G", mode: "shared-cwd" });
  const otherWindow = s.workers.getById(other.body.id)!.tmuxWindowName;
  const session = s.projects.getById(proj.body.id)!.tmuxSessionName;
  await tmuxKillSession(session, s.tmux.client);
  // The rebuild checks (and opens) G's window; F's own check stalls.
  stallAt = listWindows + 2;
  const r = await postJson(s.workersApp, `/api/projects/${proj.body.id}/workers`, { name: "F", mode: "shared-cwd" });
  expect(r.status).toBe(503);
  const windows = await tmuxListWindows(session, s.tmux.client);
  expect(windows).toContain(otherWindow);
  expect(windows.filter((w) => w.toLowerCase() === "f")).toEqual([]);
});

test("a worker's context says its panes could not be read, not that it has none, when tmux does not answer", async () => {
  const { buildWorkerRuntimeContext } = await import("../src/server/modules/agent/system-prompt.js");
  const unknown = buildWorkerRuntimeContext({ panes: null });
  expect(unknown).toContain("Active panes: unknown (tmux did not answer)");
  expect(unknown).not.toContain("Active panes: 0");
  expect(buildWorkerRuntimeContext({ panes: [] })).toContain("Active panes: 0");
});

test("a worker wake whose pane read does not answer gets that context, not an empty pane list", async () => {
  const { paneContextFor } = await import("../src/server/runtime/scopes/worker-scope.js");
  const runtime = { listPanes: async () => { throw new CommandDidNotAnswerError("tmux list-panes"); } };
  const other = { listPanes: async () => { throw new Error("worker gone"); } };
  const base = { project: {} as never, worker: { id: "f1" } as never, analyzer: { getCachedAnalysis: () => null } as never };
  expect(await paneContextFor({ ...base, paneRuntime: runtime as never })).toBe(null);
  expect(await paneContextFor({ ...base, paneRuntime: other as never })).toEqual([]);
});

test("the fake reads a numeric window target as an index first, as tmux 3.7c does", async () => {
  const fake = startFakeTmuxServer();
  try {
    await tmuxNewSession("s", "/tmp", fake.client);
    await tmuxNewWindow("s", "other", "/tmp", fake.client);
    await tmuxNewWindow("s", "1", "/tmp", fake.client);
    fake.client.runner!.run("tmux", ["kill-window", "-t", "s:1"]);
    expect(await tmuxListWindows("s", fake.client)).toEqual(["sh", "1"]);
  } finally {
    fake.cleanup();
  }
});

test("closing a worker's window by name closes that window, even when its name is another window's index", async () => {
  const fake = startFakeTmuxServer();
  try {
    await tmuxNewSession("s", "/tmp", fake.client);
    await tmuxNewWindow("s", "other", "/tmp", fake.client);
    const id = await tmuxNewWindow("s", "1", "/tmp", fake.client);
    expect(id).toMatch(/^@/);
    await tmuxKillWindow("s", "1", fake.client);
    expect(await tmuxListWindows("s", fake.client)).toEqual(["sh", "other"]);
  } finally {
    fake.cleanup();
  }
});

test("a create for a worker named 1 that stops after its window opened closes its own window, not the worker at index 1", async () => {
  const s = makeApps(() => false);
  const proj = await postJson(s.projectsApp, "/api/projects", { name: "P", workingDir: tempDir("md-wd-") });
  await postJson(s.workersApp, `/api/projects/${proj.body.id}/workers`, { name: "A", mode: "shared-cwd" });
  const session = s.projects.getById(proj.body.id)!.tmuxSessionName;
  await tmuxKillSession(session, s.tmux.client);
  // The rebuild opens "sh", then A (index 1), then "1" (index 2). Its
  // manager's thread is archived as "1" opens: the create stops there.
  const manager = s.agentStore.createManagerThread("Release");
  const tmuxClient = {
    socketArgs: s.tmuxClient.socketArgs,
    runner: {
      run: async (command: string, args: string[], options?: never) => {
        const answer = s.tmuxClient.runner!.run(command, args, options);
        if (args.includes("new-window") && args.includes("1")) s.agentStore.archiveThread(manager.id);
        return answer;
      }
    }
  };
  const service = new WorkerService({ projects: s.projects, workers: s.workers, agentStore: s.agentStore, tmuxClient, tmuxRuntime: s.tmuxRuntime });
  const r = await service.create({ projectId: proj.body.id, name: "1", mode: "shared-cwd", ownerThreadId: manager.id });
  expect(r.ok).toBe(false);
  expect(await tmuxListWindows(session, s.tmux.client)).toEqual(["sh", "a"]);
});
