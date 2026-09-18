import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { gitBranchExists } from "../../src/server/platform/git/git.js";
import { tmuxHasWindow, tmuxListWindows } from "../../src/server/platform/tmux/tmux.js";
import { buildPaneRuntimes } from "../../src/server/runtime/pane-runtime-registry.js";
import {
  buildFeaturesTestApp,
  buildProjectsTestApp,
  deleteJson,
  postJson
} from "../../tests/helpers/test-app.js";
import { withTempDataDir } from "../../tests/helpers/fixtures.js";
import { freshRealTmuxProjectEnv, tempGitRepo } from "../helpers/fixtures.js";

const setupCustomDataDir = withTempDataDir;

function makeApps() {
  const env = freshRealTmuxProjectEnv("md-db-");
  const deps = {
    projects: env.projects, features: env.features,
    tmuxClient: env.tmux.client, broadcast: () => {},
    paneRuntimes: buildPaneRuntimes({
      tmuxClient: env.tmux.client, projectsStore: env.projects, featuresStore: env.features
    })
  };
  return {
    projectsApp: buildProjectsTestApp(deps),
    featuresApp: buildFeaturesTestApp(deps),
    projects: env.projects, features: env.features, tmux: env.tmux, cleanup: env.cleanup
  };
}

test("POST features (new-branch-new-worktree) creates worktree + new branch", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, tmux, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProj", workingDir: repo.dir });
    expect(proj.status).toBe(200);
    expect(proj.body.isGit).toBe(true);

    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "FeatA", mode: "new-branch-new-worktree", branch: "feature-a" });

    expect(feat.status).toBe(200);
    expect(feat.body.mode).toBe("new-branch-new-worktree");
    expect(feat.body.branch).toBe("feature-a");
    expect(feat.body.baseRef).toBe("main");
    expect(feat.body.worktreePath).toBeTruthy();
    expect(feat.body.worktreePath.startsWith(data.dataDir)).toBeTruthy();

    // worktree dir exists and has README from base branch
    expect(fs.existsSync(path.join(feat.body.worktreePath, "README"))).toBeTruthy();

    // git knows about the new branch
    const branches = spawnSync("git", ["-C", repo.dir, "branch"], { encoding: "utf8" }).stdout;
    expect(branches.includes("feature-a")).toBeTruthy();

    // tmux window cwd is the worktree
    const windows = tmuxListWindows(proj.body.tmuxSessionName, tmux.client);
    expect(windows.includes("feata") || windows.some((w) => w.startsWith("feata"))).toBeTruthy();
  } finally {
    cleanup();
    data.restore();
    repo.cleanup();
  }
});

test("POST features (new-branch-new-worktree) honors explicit baseRef", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, cleanup } = makeApps();
  try {
    spawnSync("git", ["-C", repo.dir, "checkout", "-b", "release-base"], { encoding: "utf8" });
    fs.writeFileSync(path.join(repo.dir, "BASE"), "release");
    spawnSync("git", ["-C", repo.dir, "add", "BASE"], { encoding: "utf8" });
    spawnSync("git", ["-C", repo.dir, "commit", "-m", "release base"], { encoding: "utf8" });
    spawnSync("git", ["-C", repo.dir, "checkout", "main"], { encoding: "utf8" });

    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProjBase", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`, {
      name: "FromBase",
      mode: "new-branch-new-worktree",
      branch: "from-base",
      baseRef: "release-base"
    });

    expect(feat.status).toBe(200);
    expect(feat.body.baseRef).toBe("release-base");
    expect(fs.existsSync(path.join(feat.body.worktreePath, "BASE"))).toBeTruthy();
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST features (new-branch-new-worktree) rejects invalid baseRef", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProjBadBase", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`, {
      name: "BadBase",
      mode: "new-branch-new-worktree",
      branch: "bad-base",
      baseRef: "missing-ref"
    });

    expect(feat.status).toBe(400);
    expect(feat.body.error).toMatch(/baseRef.*commit/);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST features (existing-branch-new-worktree) attaches new worktree to existing branch", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, cleanup } = makeApps();
  try {
    spawnSync("git", ["-C", repo.dir, "branch", "ready"], { encoding: "utf8" });

    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProj2", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "Ready", mode: "existing-branch-new-worktree", branch: "ready" });

    expect(feat.status).toBe(200);
    expect(feat.body.branch).toBe("ready");
    expect(fs.existsSync(path.join(feat.body.worktreePath, "README"))).toBeTruthy();
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST features (existing-branch-existing-worktree) records the user-supplied path", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  // Pre-create a worktree out-of-band so we can hand its path to the API.
  const existingWtPath = fs.mkdtempSync(path.join(os.tmpdir(), "md-existing-wt-"));
  fs.rmSync(existingWtPath, { recursive: true, force: true });
  spawnSync("git", ["-C", repo.dir, "worktree", "add", existingWtPath, "-b", "premade"], { encoding: "utf8" });
  const { projectsApp, featuresApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "GitProj3", workingDir: repo.dir });

    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "Premade", mode: "existing-branch-existing-worktree", branch: "premade", worktreePath: existingWtPath });

    expect(feat.status).toBe(200);
    expect(feat.body.worktreePath).toBe(existingWtPath);
  } finally {
    spawnSync("git", ["-C", repo.dir, "worktree", "remove", "--force", existingWtPath], { encoding: "utf8" });
    fs.rmSync(existingWtPath, { recursive: true, force: true });
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST features (new-branch-new-worktree) on non-git project returns 400", async () => {
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-")); // not a git repo
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "NoGit", workingDir: wd });
    expect(proj.body.isGit).toBe(false);

    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "X", mode: "new-branch-new-worktree", branch: "feat-x" });

    expect(feat.status).toBe(400);
    expect(feat.body.error).toMatch(/git/);
  } finally {
    cleanup(); data.restore();
    fs.rmSync(wd, { recursive: true, force: true });
  }
});

test("POST features (new-branch-new-worktree) rolls back DB row when git fails", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, features, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Rollback", workingDir: repo.dir });

    // "main" already exists — `git worktree add -b main` will fail.
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "Bad", mode: "new-branch-new-worktree", branch: "main" });

    expect(feat.status).toBe(400);
    // No active feature should exist after rollback.
    const activeFeatures = features.listActiveByProject(proj.body.id);
    expect(activeFeatures.length).toBe(0);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE feature removes Mandate-created worktree and local branch by default", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Killer", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "Cleanup", mode: "new-branch-new-worktree", branch: "kill-me" });

    const wtPath = feat.body.worktreePath;
    expect(fs.existsSync(wtPath)).toBeTruthy();
    expect(gitBranchExists(repo.dir, "kill-me")).toBe(true);

    const r = await deleteJson(featuresApp, `/api/features/${feat.body.id}`);
    expect(r.status).toBe(200);

    expect(fs.existsSync(wtPath)).toBe(false);
    expect(gitBranchExists(repo.dir, "kill-me")).toBe(false);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE feature closes the tmux window", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, tmux, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "WindowCleanup", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "KillWin", mode: "shared-cwd" });

    expect(tmuxHasWindow(proj.body.tmuxSessionName, feat.body.tmuxWindowName, tmux.client)).toBe(true);

    const r = await deleteJson(featuresApp, `/api/features/${feat.body.id}`);
    expect(r.status).toBe(200);
    expect(tmuxHasWindow(proj.body.tmuxSessionName, feat.body.tmuxWindowName, tmux.client)).toBe(false);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE feature keeps cleanup resources when explicitly disabled", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Keep", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "Stay", mode: "new-branch-new-worktree", branch: "stay" });

    const wtPath = feat.body.worktreePath;
    await deleteJson(featuresApp, `/api/features/${feat.body.id}?removeWorktree=false&deleteBranch=false`);
    expect(fs.existsSync(wtPath)).toBeTruthy();
    expect(gitBranchExists(repo.dir, "stay")).toBe(true);

    // cleanup so the test temp dir actually goes away
    spawnSync("git", ["-C", repo.dir, "worktree", "remove", "--force", wtPath], { encoding: "utf8" });
    spawnSync("git", ["-C", repo.dir, "branch", "-D", "stay"], { encoding: "utf8" });
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE feature removes Mandate-created worktree but keeps existing branch", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, cleanup } = makeApps();
  try {
    spawnSync("git", ["-C", repo.dir, "branch", "ready-cleanup"], { encoding: "utf8" });
    const proj = await postJson(projectsApp, "/api/projects", { name: "ExistingBranch", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "Existing", mode: "existing-branch-new-worktree", branch: "ready-cleanup" });

    const wtPath = feat.body.worktreePath;
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(gitBranchExists(repo.dir, "ready-cleanup")).toBe(true);

    const r = await deleteJson(featuresApp, `/api/features/${feat.body.id}`);
    expect(r.status).toBe(200);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(gitBranchExists(repo.dir, "ready-cleanup")).toBe(true);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST feature restore recreates deleted branch and worktree", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, features, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Restore", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "RestoreFeature", mode: "new-branch-new-worktree", branch: "restore-branch" });

    const wtPath = feat.body.worktreePath;
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(gitBranchExists(repo.dir, "restore-branch")).toBe(true);

    const archived = await deleteJson(featuresApp, `/api/features/${feat.body.id}`);
    expect(archived.status).toBe(200);
    expect(features.getById(feat.body.id)?.archivedAt).toBeTruthy();
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(gitBranchExists(repo.dir, "restore-branch")).toBe(false);

    const restored = await postJson(featuresApp, `/api/features/${feat.body.id}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.body.feature.archivedAt).toBeNull();
    expect(features.getById(feat.body.id)?.archivedAt).toBeNull();
    expect(fs.existsSync(path.join(wtPath, "README"))).toBe(true);
    expect(gitBranchExists(repo.dir, "restore-branch")).toBe(true);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("DELETE feature leaves dirty Mandate-created worktree and branch for manual cleanup", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, features, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Dirty", workingDir: repo.dir });
    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "DirtyFeature", mode: "new-branch-new-worktree", branch: "dirty-branch" });

    const wtPath = feat.body.worktreePath;
    fs.writeFileSync(path.join(wtPath, "dirty.txt"), "local change");

    const r = await deleteJson(featuresApp, `/api/features/${feat.body.id}`);
    expect(r.status).toBe(200);
    const cleanupKinds = r.body.cleanupFailures.map((failure: { kind: string }) => failure.kind);
    expect(cleanupKinds).toContain("worktree");
    expect(cleanupKinds).toContain("branch");
    expect(features.getById(feat.body.id)?.archivedAt).toBeTruthy();
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(gitBranchExists(repo.dir, "dirty-branch")).toBe(true);

    spawnSync("git", ["-C", repo.dir, "worktree", "remove", "--force", wtPath], { encoding: "utf8" });
    spawnSync("git", ["-C", repo.dir, "branch", "-D", "dirty-branch"], { encoding: "utf8" });
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});

test("POST features rolls back DB row when git worktree add fails after insert", async () => {
  const repo = tempGitRepo();
  const data = setupCustomDataDir();
  const { projectsApp, featuresApp, features, cleanup } = makeApps();
  try {
    const proj = await postJson(projectsApp, "/api/projects", { name: "Rollback2", workingDir: repo.dir });

    // Pre-occupy the worktree path so `git worktree add` fails (dir not empty).
    // Path is computed as <dataDir>/worktrees/<tmuxSessionName>/<sanitized-branch>.
    const expected = path.join(data.dataDir, "worktrees", proj.body.tmuxSessionName, "blocked_branch");
    fs.mkdirSync(expected, { recursive: true });
    fs.writeFileSync(path.join(expected, "blocker"), "x");

    const feat = await postJson(featuresApp, `/api/projects/${proj.body.id}/features`,
      { name: "Blocked", mode: "new-branch-new-worktree", branch: "blocked-branch" });

    expect(feat.status).toBe(500);
    expect(feat.body.error).toMatch(/git worktree add failed/);
    expect(features.listActiveByProject(proj.body.id).length).toBe(0);
  } finally {
    cleanup(); data.restore(); repo.cleanup();
  }
});
