import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { buildPaneRuntimes } from "../../src/server/runtime/pane-runtime-registry.js";
import { buildFeaturesTestApp, buildProjectsTestApp, patchJson, postJson } from "../../tests/helpers/test-app.js";
import { withTempDataDir } from "../../tests/helpers/fixtures.js";
import { freshRealTmuxProjectEnv, tempGitRepo } from "../helpers/fixtures.js";

// A project's working directory changed with real git: a worktree belongs to
// the repository that made it, so the change is let through when the new
// directory is that repository (another checkout of it, or the same one
// moved, its worktrees then linked again) and refused when it is not.

function makeApps() {
  const env = freshRealTmuxProjectEnv("md-workdir-");
  const deps = {
    projects: env.projects, features: env.features, tmuxClient: env.tmux.client, broadcast: () => {},
    paneRuntimes: buildPaneRuntimes({ tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features })
  };
  return { projectsApp: buildProjectsTestApp(deps), featuresApp: buildFeaturesTestApp(deps), projects: env.projects, cleanup: env.cleanup };
}

const git = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });

async function projectWithWorker(apps: ReturnType<typeof makeApps>, name: string, dir: string) {
  const project = await postJson(apps.projectsApp, "/api/projects", { name, workingDir: dir });
  expect(project.status).toBe(200);
  const worker = await postJson(apps.featuresApp, `/api/projects/${project.body.id}/features`, { name: "search", mode: "new-branch-new-worktree", branch: "search" });
  expect(worker.status).toBe(200);
  return { projectId: project.body.id as string, worktree: worker.body.worktreePath as string };
}

test("another checkout of the same repository: the change goes through and the worker's worktree still works", async () => {
  const repo = tempGitRepo();
  const data = withTempDataDir();
  const apps = makeApps();
  try {
    const { projectId, worktree } = await projectWithWorker(apps, "project-1", repo.dir);
    const checkout = path.join(data.dataDir, "checkout-2");
    expect(git(repo.dir, "worktree", "add", "-b", "side", checkout).status).toBe(0);
    const r = await patchJson(apps.projectsApp, `/api/projects/${projectId}`, { workingDir: checkout });
    expect([r.status, r.body.workingDir, r.body.isGit]).toEqual([200, checkout, true]);
    expect(git(worktree, "status", "--porcelain").status).toBe(0);
  } finally {
    apps.cleanup(); data.restore(); repo.cleanup();
  }
});

test("the repository moved on disk: its worker's worktree, broken by the move, is linked again", async () => {
  const repo = tempGitRepo();
  const data = withTempDataDir();
  const apps = makeApps();
  const moved = `${repo.dir}-moved`;
  try {
    const { projectId, worktree } = await projectWithWorker(apps, "project-2", repo.dir);
    fs.renameSync(repo.dir, moved);
    expect(git(worktree, "status", "--porcelain").status === 0).toBe(false);
    const r = await patchJson(apps.projectsApp, `/api/projects/${projectId}`, { workingDir: moved });
    expect([r.status, apps.projects.getById(projectId)!.workingDir]).toEqual([200, moved]);
    expect(git(worktree, "status", "--porcelain").status).toBe(0);
    expect(fs.realpathSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim())).toBe(fs.realpathSync(path.join(moved, ".git")));
  } finally {
    apps.cleanup(); data.restore();
    fs.rmSync(moved, { recursive: true, force: true });
  }
});

test("another repository is refused while a worker's worktree belongs to this one, naming it", async () => {
  const repo = tempGitRepo();
  const other = tempGitRepo();
  const data = withTempDataDir();
  const apps = makeApps();
  try {
    const { projectId } = await projectWithWorker(apps, "project-3", repo.dir);
    const r = await patchJson(apps.projectsApp, `/api/projects/${projectId}`, { workingDir: other.dir });
    expect([r.status, r.body.workers.map((w: { name: string }) => w.name)]).toEqual([409, ["search"]]);
    expect(apps.projects.getById(projectId)!.workingDir).toBe(repo.dir);
  } finally {
    apps.cleanup(); data.restore(); repo.cleanup(); other.cleanup();
  }
});

test("a moved repository's worker is not handed to another repository that has a worktree of the same name", async () => {
  const repo = tempGitRepo();
  const other = tempGitRepo();
  const data = withTempDataDir();
  const apps = makeApps();
  const moved = `${repo.dir}-moved`;
  // git names a worktree's admin entry after its directory: this one's is "search", as ours is.
  const otherWorktree = path.join(data.dataDir, "other", "search");
  try {
    const { projectId, worktree } = await projectWithWorker(apps, "project-4", repo.dir);
    expect(git(other.dir, "worktree", "add", "-b", "search", otherWorktree).status).toBe(0);
    const adminName = (dir: string) => path.basename(fs.readFileSync(path.join(dir, ".git"), "utf8").replace(/^gitdir: /, "").trim());
    expect([adminName(worktree), adminName(otherWorktree)]).toEqual(["search", "search"]);
    const before = fs.readFileSync(path.join(worktree, ".git"), "utf8");
    fs.renameSync(repo.dir, moved);
    const r = await patchJson(apps.projectsApp, `/api/projects/${projectId}`, { workingDir: other.dir });
    expect([r.status, r.body.workers.map((w: { name: string }) => w.name)]).toEqual([409, ["search"]]);
    // Nothing was relinked: ours still points at its own repository, theirs still works.
    expect(fs.readFileSync(path.join(worktree, ".git"), "utf8")).toBe(before);
    expect(git(otherWorktree, "status", "--porcelain").status).toBe(0);
    // The repository it does belong to links it again.
    expect((await patchJson(apps.projectsApp, `/api/projects/${projectId}`, { workingDir: moved })).status).toBe(200);
    expect(git(worktree, "status", "--porcelain").status).toBe(0);
  } finally {
    apps.cleanup(); data.restore(); other.cleanup();
    fs.rmSync(moved, { recursive: true, force: true });
  }
});
