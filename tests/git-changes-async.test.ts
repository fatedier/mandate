import { expect, test } from "bun:test";
import { Hono } from "hono";
import { mountGitRoutes } from "../src/server/modules/git/git-routes.js";
import type { CommandResult, CommandRunner } from "../src/server/platform/process/command-runner.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { tempDir } from "./helpers/temp.js";

// A worker's Changes run git over the whole working tree, a quarter of a
// second and more on a large repository. The server answers other requests
// while git runs: git is only ever asked without waiting on it.

const ok = (stdout: string): CommandResult => ({ status: 0, signal: null, stdout, stderr: "" });

/** git as a repository with one changed file would answer, each call held
 *  until released; a call that would wait on git throws. */
function heldGit() {
  const waiting: Array<() => void> = [];
  const answer = (args: string[]): CommandResult => {
    if (args.includes("rev-parse")) return ok("abc123\n");
    if (args.includes("--name-status")) return ok("M\0src/app.ts\0");
    if (args.includes("--numstat")) return ok("3\t1\tsrc/app.ts\0");
    if (args.includes("status")) return ok(" M src/app.ts\0");
    if (args.includes("ls-files")) return ok("");
    if (args.includes("--")) return ok("diff --git a/src/app.ts b/src/app.ts\n+three\n-one\n");
    return { status: 1, signal: null, stdout: "", stderr: "unexpected" };
  };
  const runner: CommandRunner = {
    run: (_command, args) => new Promise((resolve) => { waiting.push(() => resolve(answer(args))); })
  };
  // Each answer lets the route ask its next question.
  const releaseAll = async () => {
    for (let turns = 0; turns < 50; turns++) {
      if (waiting.length > 0) waiting.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  return { runner, waiting, releaseAll };
}

test("a worker's Changes ask git without waiting on it: another request is answered while git runs", async () => {
  const env = freshStoresEnv("md-git-changes-async-");
  const repo = tempDir("md-repo-");
  const projectId = seedProject(env.projects, { isGit: true, workingDir: repo });
  const workerId = seedWorker(env.workers, projectId, { worktreePath: null, branch: null });
  const git = heldGit();
  const app = new Hono();
  mountGitRoutes(app, { projects: env.projects, workers: env.workers, gitClient: { runner: git.runner } });
  app.get("/ping", (c) => c.text("pong"));

  const changes = app.request(`/api/workers/${workerId}/changes`);
  while (git.waiting.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  // git is running; the server is not waiting on it.
  expect(await (await app.request("/ping")).text()).toBe("pong");

  await git.releaseAll();
  const body = await (await changes).json() as { files: Array<{ path: string; additions: number; deletions: number; uncommitted: boolean }>; head: string };
  expect(body.head).toBe("abc123");
  expect(body.files).toMatchObject([{ path: "src/app.ts", additions: 3, deletions: 1, uncommitted: true }]);
});

test("a file of a worker's Changes is read without waiting on git too", async () => {
  const env = freshStoresEnv("md-git-changes-async-file-");
  const repo = tempDir("md-repo-");
  const projectId = seedProject(env.projects, { isGit: true, workingDir: repo });
  const workerId = seedWorker(env.workers, projectId, { worktreePath: null, branch: null });
  const git = heldGit();
  const app = new Hono();
  mountGitRoutes(app, { projects: env.projects, workers: env.workers, gitClient: { runner: git.runner } });
  app.get("/ping", (c) => c.text("pong"));

  const file = app.request(`/api/workers/${workerId}/changes/file?path=${encodeURIComponent("src/app.ts")}`);
  while (git.waiting.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await (await app.request("/ping")).text()).toBe("pong");
  await git.releaseAll();
  expect((await file).status).toBe(200);
});

// Two reads of one worker's Changes may now end in either order, and the
// worker may be archived while git runs: what the server keeps and answers
// must still be the newest state of a worker that is still there.

/** git whose answers are the repository as it was when each call was made,
 *  released one call at a time. */
function steppedGit() {
  let state: "untracked" | "committed" = "untracked";
  const waiting: Array<{ args: string[]; go: () => void }> = [];
  const answer = (args: string[], at: typeof state): CommandResult => {
    if (args.includes("rev-parse")) return ok(at === "untracked" ? "aaa111\n" : "bbb222\n");
    if (args.includes("--name-status")) return ok(at === "untracked" ? "" : "M\0src/new.ts\0");
    if (args.includes("--numstat")) return ok(at === "untracked" ? "" : "2\t0\tsrc/new.ts\0");
    if (args.includes("status")) return ok(at === "untracked" ? "?? src/new.ts\0" : " M src/new.ts\0");
    if (args.includes("ls-files")) return ok(at === "untracked" ? "src/new.ts\0" : "");
    return ok("diff --git a/src/new.ts b/src/new.ts\n");
  };
  const runner: CommandRunner = {
    run: (_command, args) => {
      const at = state;
      return new Promise((resolve) => { waiting.push({ args, go: () => resolve(answer(args, at)) }); });
    }
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Answers the oldest (or the newest) waiting call, then lets its request ask the next. */
  const release = async (which: "oldest" | "newest") => {
    while (waiting.length === 0) await settle();
    (which === "oldest" ? waiting.shift()! : waiting.pop()!).go();
    await settle();
  };
  return { runner, waiting, releaseOne: () => release("oldest"), releaseNewest: () => release("newest"), commit: () => { state = "committed"; } };
}

test("a read of Changes that ends after a newer one does not put back the older names for its files", async () => {
  const env = freshStoresEnv("md-git-changes-order-");
  const repo = tempDir("md-repo-");
  const projectId = seedProject(env.projects, { isGit: true, workingDir: repo });
  const workerId = seedWorker(env.workers, projectId, { worktreePath: null, branch: null });
  const git = steppedGit();
  const app = new Hono();
  mountGitRoutes(app, { projects: env.projects, workers: env.workers, gitClient: { runner: git.runner } });

  // The older read sees src/new.ts untracked; it waits on its last call.
  const older = app.request(`/api/workers/${workerId}/changes`);
  for (let i = 0; i < 4; i++) await git.releaseOne();
  // The file is committed and changed; a newer read sees that, and ends first.
  git.commit();
  const newer = app.request(`/api/workers/${workerId}/changes`);
  for (let i = 0; i < 5; i++) await git.releaseNewest();
  expect(((await (await newer).json()) as { head: string }).head).toBe("bbb222");
  await git.releaseOne();
  expect(((await (await older).json()) as { head: string }).head).toBe("aaa111");

  // The file is read as the newer read named it: a tracked change, not a new file.
  const file = app.request(`/api/workers/${workerId}/changes/file?path=${encodeURIComponent("src/new.ts")}`);
  while (git.waiting.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(git.waiting[0]!.args).not.toContain("--no-index");
  await git.releaseOne();
  expect((await file).status).toBe(200);
});

test("a worker archived while git reads its Changes is answered as gone", async () => {
  const env = freshStoresEnv("md-git-changes-archived-");
  const repo = tempDir("md-repo-");
  const projectId = seedProject(env.projects, { isGit: true, workingDir: repo });
  const workerId = seedWorker(env.workers, projectId, { worktreePath: null, branch: null });
  const git = steppedGit();
  const app = new Hono();
  mountGitRoutes(app, { projects: env.projects, workers: env.workers, gitClient: { runner: git.runner } });

  const changes = app.request(`/api/workers/${workerId}/changes`);
  await git.releaseOne();
  env.workers.archive(workerId);
  for (let i = 0; i < 4; i++) await git.releaseOne();
  const answered = await changes;
  expect(answered.status).toBe(404);
  expect(await answered.json()).toEqual({ error: "worker not found" });

  const file = app.request(`/api/workers/${workerId}/changes/file?path=${encodeURIComponent("src/new.ts")}`);
  expect((await file).status).toBe(404);
});

test("a file of a worker archived while git reads it is answered as gone, whether git was listing names or reading the patch", async () => {
  const env = freshStoresEnv("md-git-changes-archived-file-");
  const repo = tempDir("md-repo-");
  const projectId = seedProject(env.projects, { isGit: true, workingDir: repo });
  const listing = seedWorker(env.workers, projectId, { name: "listing", tmuxWindowName: "listing", worktreePath: null, branch: null });
  const patching = seedWorker(env.workers, projectId, { name: "patching", tmuxWindowName: "patching", worktreePath: null, branch: null });
  const git = steppedGit();
  git.commit();
  const app = new Hono();
  mountGitRoutes(app, { projects: env.projects, workers: env.workers, gitClient: { runner: git.runner } });
  const fileOf = (workerId: string) => app.request(`/api/workers/${workerId}/changes/file?path=${encodeURIComponent("src/new.ts")}`);

  // Nothing cached: archived while git lists the names.
  const listed = fileOf(listing);
  await git.releaseOne();
  env.workers.archive(listing);
  await git.releaseOne();
  expect((await listed).status).toBe(404);

  // Names cached by a read of its Changes: archived while git reads the patch.
  const changes = app.request(`/api/workers/${patching}/changes`);
  for (let i = 0; i < 5; i++) await git.releaseOne();
  expect((await changes).status).toBe(200);
  const patched = fileOf(patching);
  while (git.waiting.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  env.workers.archive(patching);
  await git.releaseOne();
  expect((await patched).status).toBe(404);
});

test("a branch comparison of a worker archived while git finds its merge base is answered as gone, not as a base it could not find", async () => {
  const env = freshStoresEnv("md-git-changes-archived-branch-");
  const repo = tempDir("md-repo-");
  const projectId = seedProject(env.projects, { isGit: true, workingDir: repo });
  const workerId = seedWorker(env.workers, projectId, { worktreePath: null, branch: "feat/x", baseRef: "main" });
  const waiting: Array<() => void> = [];
  // No rebase on record; merge-base, held, fails once the worker is gone.
  const runner: CommandRunner = {
    run: (_command, args) => args.includes("merge-base")
      ? new Promise((resolve) => { waiting.push(() => resolve({ status: 128, signal: null, stdout: "", stderr: "fatal: not a git repository" })); })
      : Promise.resolve({ status: 1, signal: null, stdout: "", stderr: "" })
  };
  const app = new Hono();
  mountGitRoutes(app, { projects: env.projects, workers: env.workers, gitClient: { runner } });
  const changes = app.request(`/api/workers/${workerId}/changes?compare=branch`);
  const file = app.request(`/api/workers/${workerId}/changes/file?compare=branch&path=${encodeURIComponent("src/new.ts")}`);
  while (waiting.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  env.workers.archive(workerId);
  for (const go of waiting.splice(0)) go();
  for (const answered of [await changes, await file]) {
    expect(answered.status).toBe(404);
    expect(await answered.json()).toEqual({ error: "worker not found" });
  }
});
