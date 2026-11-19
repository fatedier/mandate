import { expect, test } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { gitBranchExists } from "../../src/server/platform/git/git.js";
import { tmuxHasWindow, tmuxListWindows } from "../../src/server/platform/tmux/tmux.js";
import { TmuxRuntime } from "../../src/server/runtime/runtimes/tmux-runtime.js";
import { WorkerService } from "../../src/server/modules/workers/worker-service.js";
import {
  buildWorkersTestApp,
  buildProjectsTestApp,
  deleteJson,
  postJson
} from "../../tests/helpers/test-app.js";
import { withTempDataDir } from "../../tests/helpers/fixtures.js";
import { tempDir } from "../../tests/helpers/temp.js";
import { freshRealTmuxProjectEnv, tempGitRepo } from "../helpers/fixtures.js";

const setupCustomDataDir = withTempDataDir;

function makeApps() {
  const env = freshRealTmuxProjectEnv("md-db-");
  const deps = {
    projects: env.projects, workers: env.workers,
    tmuxClient: env.tmux.client, broadcast: () => {},
    tmuxRuntime: new TmuxRuntime({
      tmuxClient: env.tmux.client, projectsStore: env.projects, workersStore: env.workers
    })
  };
  return {
    deps,
    projectsApp: buildProjectsTestApp(deps),
    workersApp: buildWorkersTestApp(deps),
    projects: env.projects, workers: env.workers, tmux: env.tmux, cleanup: env.cleanup
  };
}

test("POST workers (new-branch-new-worktree) creates worktree + new branch", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, tmux, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProj", workingDir: repo.dir });
    expect(proj.status).toBe(200);
    expect(proj.body.isGit).toBe(true);

    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "WorkerA", mode: "new-branch-new-worktree", branch: "worker-a" });

    expect(worker.status).toBe(200);
    expect(worker.body.mode).toBe("new-branch-new-worktree");
    expect(worker.body.branch).toBe("worker-a");
    expect(worker.body.baseRef).toBe("main");
    expect(worker.body.worktreePath).toBeTruthy();
    expect(worker.body.worktreePath.startsWith(data.dataDir)).toBeTruthy();

    // worktree dir exists and has README from base branch
    expect(fs.existsSync(path.join(worker.body.worktreePath, "README"))).toBeTruthy();

    // git knows about the new branch
    const branches = spawnSync("git", ["-C", repo.dir, "branch"], { encoding: "utf8" }).stdout;
    expect(branches.includes("worker-a")).toBeTruthy();

    // tmux window cwd is the worktree
    const windows = await tmuxListWindows(proj.body.tmuxSessionName, tmux.client);
    expect(windows.includes("workera") || windows.some((w) => w.startsWith("workera"))).toBeTruthy();
  } finally {
    cleanup();
    data.restore();
    repo.cleanup();
  }
});

test("POST workers (new-branch-new-worktree) honors explicit baseRef", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, cleanup } = makeApps();
  try {
    spawnSync("git", ["-C", repo.dir, "checkout", "-b", "release-base"], { encoding: "utf8" });
    fs.writeFileSync(path.join(repo.dir, "BASE"), "release");
    spawnSync("git", ["-C", repo.dir, "add", "BASE"], { encoding: "utf8" });
    spawnSync("git", ["-C", repo.dir, "commit", "-m", "release base"], { encoding: "utf8" });
    spawnSync("git", ["-C", repo.dir, "checkout", "main"], { encoding: "utf8" });

    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProjBase", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`, {
      name: "FromBase",
      mode: "new-branch-new-worktree",
      branch: "from-base",
      baseRef: "release-base"
    });

    expect(worker.status).toBe(200);
    expect(worker.body.baseRef).toBe("release-base");
    expect(fs.existsSync(path.join(worker.body.worktreePath, "BASE"))).toBeTruthy();
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST workers (new-branch-new-worktree) rejects invalid baseRef", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProjBadBase", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`, {
      name: "BadBase",
      mode: "new-branch-new-worktree",
      branch: "bad-base",
      baseRef: "missing-ref"
    });

    expect(worker.status).toBe(400);
    expect(worker.body.error).toMatch(/baseRef.*commit/);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST workers (existing-branch-new-worktree) attaches new worktree to existing branch", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, cleanup } = makeApps();
  try {
    spawnSync("git", ["-C", repo.dir, "branch", "ready"], { encoding: "utf8" });

    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProj2", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "Ready", mode: "existing-branch-new-worktree", branch: "ready" });

    expect(worker.status).toBe(200);
    expect(worker.body.branch).toBe("ready");
    expect(fs.existsSync(path.join(worker.body.worktreePath, "README"))).toBeTruthy();
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST workers (existing-branch-existing-worktree) records the user-supplied path", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  // Pre-create a worktree out-of-band so we can hand its path to the API.
  const existingWtPath = tempDir("md-existing-wt-");
  fs.rmSync(existingWtPath, { recursive: true, force: true });
  spawnSync("git", ["-C", repo.dir, "worktree", "add", existingWtPath, "-b", "premade"], { encoding: "utf8" });
  const { projectsApp, workersApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProj3", workingDir: repo.dir });

    // A path that is not there is refused before anything is recorded.
    const missing = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "Premade", mode: "existing-branch-existing-worktree", branch: "premade", worktreePath: `${existingWtPath}-missing` });
    expect(missing).toMatchObject({ status: 400, body: { error: "worktreePath does not exist" } });

    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "Premade", mode: "existing-branch-existing-worktree", branch: "premade", worktreePath: existingWtPath });

    expect(worker.status).toBe(200);
    expect(worker.body.worktreePath).toBe(existingWtPath);
  } finally {
    spawnSync("git", ["-C", repo.dir, "worktree", "remove", "--force", existingWtPath], { encoding: "utf8" });
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST workers (new-branch-new-worktree) on non-git project returns 400", async () => {
  const wd = tempDir("md-wd-"); // not a git repo
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "NoGit", workingDir: wd });
    expect(proj.body.isGit).toBe(false);

    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "X", mode: "new-branch-new-worktree", branch: "feat-x" });

    expect(worker.status).toBe(400);
    expect(worker.body.error).toMatch(/git/);
  } finally {
    cleanup(); data.restore();
  }
});

test("POST workers (new-branch-new-worktree) rolls back DB row when git fails", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, workers, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Rollback", workingDir: repo.dir });

    // "main" already exists — `git worktree add -b main` will fail.
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "Bad", mode: "new-branch-new-worktree", branch: "main" });

    expect(worker.status).toBe(400);
    // No active worker should exist after rollback.
    const activeWorkers = workers.listActiveByProject(proj.body.id);
    expect(activeWorkers.length).toBe(0);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE worker removes Mandate-created worktree and local branch by default", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Killer", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "Cleanup", mode: "new-branch-new-worktree", branch: "kill-me" });

    const wtPath = worker.body.worktreePath;
    expect(fs.existsSync(wtPath)).toBeTruthy();
    expect(await gitBranchExists(repo.dir, "kill-me")).toBe(true);

    const r = await deleteJson(workersApp, `/api/workers/${worker.body.id}`);
    expect(r.status).toBe(200);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(await gitBranchExists(repo.dir, "kill-me")).toBe(false);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE worker closes the tmux window", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, tmux, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "WindowCleanup", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "KillWin", mode: "shared-cwd" });

    expect(await tmuxHasWindow(proj.body.tmuxSessionName, worker.body.tmuxWindowName, tmux.client)).toBe(true);

    const r = await deleteJson(workersApp, `/api/workers/${worker.body.id}`);
    expect(r.status).toBe(200);
    expect(await tmuxHasWindow(proj.body.tmuxSessionName, worker.body.tmuxWindowName, tmux.client)).toBe(false);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE worker keeps cleanup resources when explicitly disabled", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Keep", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "Stay", mode: "new-branch-new-worktree", branch: "stay" });

    const wtPath = worker.body.worktreePath;
    await deleteJson(workersApp, `/api/workers/${worker.body.id}?removeWorktree=false&deleteBranch=false`);
    expect(fs.existsSync(wtPath)).toBeTruthy();
    expect(await gitBranchExists(repo.dir, "stay")).toBe(true);

    // cleanup so the test temp dir actually goes away
    spawnSync("git", ["-C", repo.dir, "worktree", "remove", "--force", wtPath], { encoding: "utf8" });
    spawnSync("git", ["-C", repo.dir, "branch", "-D", "stay"], { encoding: "utf8" });
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE worker removes Mandate-created worktree but keeps existing branch", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, cleanup } = makeApps();
  try {
    spawnSync("git", ["-C", repo.dir, "branch", "ready-cleanup"], { encoding: "utf8" });
    const proj = await postJson(projectsApp, "/api/projects", { name: "ExistingBranch", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "Existing", mode: "existing-branch-new-worktree", branch: "ready-cleanup" });

    const wtPath = worker.body.worktreePath;
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(await gitBranchExists(repo.dir, "ready-cleanup")).toBe(true);

    const r = await deleteJson(workersApp, `/api/workers/${worker.body.id}`);
    expect(r.status).toBe(200);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(await gitBranchExists(repo.dir, "ready-cleanup")).toBe(true);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

// The restore_worker tool restores through the service.
test("a worker restore recreates the deleted branch and worktree", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { deps, projectsApp, workersApp, workers, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Restore", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "RestoreWorker", mode: "new-branch-new-worktree", branch: "restore-branch" });

    const wtPath = worker.body.worktreePath;
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(await gitBranchExists(repo.dir, "restore-branch")).toBe(true);

    const archived = await deleteJson(workersApp, `/api/workers/${worker.body.id}`);
    expect(archived.status).toBe(200);
    expect(workers.getById(worker.body.id)?.archivedAt).toBeTruthy();
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(await gitBranchExists(repo.dir, "restore-branch")).toBe(false);

    const restored = await new WorkerService(deps).restore({ id: worker.body.id });
    expect(restored).toMatchObject({ ok: true, worker: { archivedAt: null } });
    expect(workers.getById(worker.body.id)?.archivedAt).toBeNull();
    expect(fs.existsSync(path.join(wtPath, "README"))).toBe(true);
    expect(await gitBranchExists(repo.dir, "restore-branch")).toBe(true);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE worker leaves dirty Mandate-created worktree and branch for manual cleanup", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, workers, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Dirty", workingDir: repo.dir });
    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "DirtyWorker", mode: "new-branch-new-worktree", branch: "dirty-branch" });

    const wtPath = worker.body.worktreePath;
    fs.writeFileSync(path.join(wtPath, "dirty.txt"), "local change");

    // Unconfirmed, archive refuses: the worktree has uncommitted work.
    const refused = await deleteJson(workersApp, `/api/workers/${worker.body.id}`);
    expect(refused.status).toBe(409);
    expect(workers.getById(worker.body.id)?.archivedAt).toBe(null);
    // The user said archive anyway; git's own non-forced cleanup still keeps both.
    const r = await deleteJson(workersApp, `/api/workers/${worker.body.id}?confirmed=true`);
    expect(r.status).toBe(200);
    const cleanupKinds = r.body.cleanupFailures.map((failure: { kind: string }) => failure.kind);
    expect(cleanupKinds).toContain("worktree");
    expect(cleanupKinds).toContain("branch");
    expect(workers.getById(worker.body.id)?.archivedAt).toBeTruthy();
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(await gitBranchExists(repo.dir, "dirty-branch")).toBe(true);

    spawnSync("git", ["-C", repo.dir, "worktree", "remove", "--force", wtPath], { encoding: "utf8" });
    spawnSync("git", ["-C", repo.dir, "branch", "-D", "dirty-branch"], { encoding: "utf8" });
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST workers rolls back DB row when git worktree add fails after insert", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, workersApp, workers, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Rollback2", workingDir: repo.dir });

    // Pre-occupy the worktree path so `git worktree add` fails (dir not empty).
    // Path is computed as <dataDir>/worktrees/<tmuxSessionName>/<sanitized-branch>.
    const expected = path.join(data.dataDir, "worktrees", proj.body.tmuxSessionName, "blocked_branch");
    fs.mkdirSync(expected, { recursive: true });
    fs.writeFileSync(path.join(expected, "blocker"), "x");

    const worker = await postJson(workersApp, `/api/projects/${proj.body.id}/workers`,
      { name: "Blocked", mode: "new-branch-new-worktree", branch: "blocked-branch" });

    expect(worker.status).toBe(500);
    expect(worker.body.error).toMatch(/git worktree add failed/);
    expect(workers.listActiveByProject(proj.body.id).length).toBe(0);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});
