import { expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  type GitClient,
  gitCurrentBranch,
  gitListBranches,
  gitBranchExists,
  gitResolveDefaultBaseRef,
  gitWorktreeAdd,
  gitWorktreeRemove
} from "../src/server/platform/git/git.js";
import { freshStoresEnv, seedProject } from "../tests/helpers/fixtures.js";
import { tempGitRepo as tempRepo } from "./helpers/fixtures.js";

test("gitListBranches: returns local branches of fresh repo", () => {
  const { dir, cleanup } = tempRepo();
  try {
    const branches = gitListBranches(dir);
    expect(branches.includes("main")).toBeTruthy();
  } finally { cleanup(); }
});

test("gitListBranches: includes branches created after init", () => {
  const { dir, cleanup } = tempRepo();
  try {
    spawnSync("git", ["-C", dir, "branch", "feature-x"], { encoding: "utf8" });
    const branches = gitListBranches(dir);
    expect(branches.includes("main")).toBeTruthy();
    expect(branches.includes("feature-x")).toBeTruthy();
  } finally { cleanup(); }
});

test("gitBranchExists: true for existing, false for missing", () => {
  const { dir, cleanup } = tempRepo();
  try {
    expect(gitBranchExists(dir, "main")).toBe(true);
    expect(gitBranchExists(dir, "nope")).toBe(false);
  } finally { cleanup(); }
});

test("gitResolveDefaultBaseRef: prefers the current branch", () => {
  const { dir, cleanup } = tempRepo();
  try {
    expect(gitCurrentBranch(dir)).toBe("main");
    expect(gitResolveDefaultBaseRef(dir)).toBe("main");
  } finally { cleanup(); }
});

test("gitWorktreeAdd: creates worktree on a new branch", () => {
  const { dir, cleanup } = tempRepo();
  const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "md-wt-"));
  try {
    fs.rmSync(wtPath, { recursive: true, force: true });
    gitWorktreeAdd(dir, wtPath, "feature-y", { newBranch: true });
    expect(fs.existsSync(path.join(wtPath, "README"))).toBeTruthy();
    expect(gitBranchExists(dir, "feature-y")).toBe(true);
  } finally {
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    cleanup();
  }
});

test("gitWorktreeAdd: creates a new branch from an explicit base ref", () => {
  const { dir, cleanup } = tempRepo();
  const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "md-wt-"));
  try {
    spawnSync("git", ["-C", dir, "checkout", "-b", "base-branch"], { encoding: "utf8" });
    fs.writeFileSync(path.join(dir, "BASE"), "base-only");
    spawnSync("git", ["-C", dir, "add", "BASE"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "commit", "-m", "base commit"], { encoding: "utf8" });
    spawnSync("git", ["-C", dir, "checkout", "main"], { encoding: "utf8" });

    fs.rmSync(wtPath, { recursive: true, force: true });
    gitWorktreeAdd(dir, wtPath, "feature-from-base", { newBranch: true, baseRef: "base-branch" });

    expect(fs.existsSync(path.join(wtPath, "BASE"))).toBeTruthy();
    expect(gitBranchExists(dir, "feature-from-base")).toBe(true);
  } finally {
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    cleanup();
  }
});

test("gitWorktreeAdd: attaches worktree to an existing branch", () => {
  const { dir, cleanup } = tempRepo();
  const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "md-wt-"));
  try {
    spawnSync("git", ["-C", dir, "branch", "existing"], { encoding: "utf8" });
    fs.rmSync(wtPath, { recursive: true, force: true });
    gitWorktreeAdd(dir, wtPath, "existing", { newBranch: false });
    expect(fs.existsSync(path.join(wtPath, "README"))).toBeTruthy();
  } finally {
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    cleanup();
  }
});

test("gitWorktreeAdd: allows large checkout time", () => {
  const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
  const client: GitClient = {
    runner: {
      run(_command, args, options) {
        calls.push({ args, timeout: options?.timeout });
        return { status: 0, signal: null, stdout: "", stderr: "" };
      }
    }
  };

  gitWorktreeAdd("/repo", "/repo-worktree", "feature-y", { newBranch: true }, client);

  expect(calls).toEqual([{
    args: ["-C", "/repo", "worktree", "add", "-b", "feature-y", "/repo-worktree"],
    timeout: 60_000
  }]);
});

test("gitWorktreeAdd: throws on bad branch name", () => {
  const { dir, cleanup } = tempRepo();
  const wtPath = path.join(os.tmpdir(), `md-wt-${Date.now()}-bad`);
  try {
    expect(() =>
      gitWorktreeAdd(dir, wtPath, "main", { newBranch: true })).toThrow(/already exists|exists/i);
  } finally {
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    cleanup();
  }
});

test("gitWorktreeRemove: removes worktree directory and git record", () => {
  const { dir, cleanup } = tempRepo();
  const wtPath = fs.mkdtempSync(path.join(os.tmpdir(), "md-wt-"));
  try {
    fs.rmSync(wtPath, { recursive: true, force: true });
    gitWorktreeAdd(dir, wtPath, "feature-z", { newBranch: true });
    expect(fs.existsSync(wtPath)).toBeTruthy();
    gitWorktreeRemove(wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
  } finally {
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch {}
    cleanup();
  }
});

test("gitWorktreeRemove: allows large remove time", () => {
  const calls: Array<{ args: string[]; timeout: number | undefined }> = [];
  const client: GitClient = {
    runner: {
      run(_command, args, options) {
        calls.push({ args, timeout: options?.timeout });
        return { status: 0, signal: null, stdout: "", stderr: "" };
      }
    }
  };

  gitWorktreeRemove("/repo-worktree", "/repo", {}, client);
  gitWorktreeRemove("/repo-worktree", "/repo", { force: true }, client);

  expect(calls).toEqual([
    {
      args: ["-C", "/repo", "worktree", "remove", "/repo-worktree"],
      timeout: 60_000
    },
    {
      args: ["-C", "/repo", "worktree", "remove", "--force", "/repo-worktree"],
      timeout: 60_000
    }
  ]);
});

import { buildGitTestApp, getJson } from "../tests/helpers/test-app.js";

test("GET /api/projects/:id/git/branches lists branches of git project", async () => {
  const env = freshStoresEnv("md-db-");
  const repo = tempRepo();
  try {
    spawnSync("git", ["-C", repo.dir, "branch", "feature-listed"], { encoding: "utf8" });
    const projectId = seedProject(env.projects, {
      name: "p", workingDir: repo.dir, isGit: true, tmuxSessionName: "md-p"
    });
    const app = buildGitTestApp({ projects: env.projects, features: env.features });
    const r = await getJson(app, `/api/projects/${projectId}/git/branches`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.branches)).toBeTruthy();
    expect(r.body.branches.includes("main")).toBeTruthy();
    expect(r.body.branches.includes("feature-listed")).toBeTruthy();
    expect(r.body.currentBranch).toBe("main");
    expect(r.body.defaultBaseRef).toBe("main");
  } finally {
    repo.cleanup();
    env.cleanup();
  }
});

test("GET /api/projects/:id/git/branches returns 400 when project is not git", async () => {
  const env = freshStoresEnv("md-db-");
  const wd = fs.mkdtempSync(path.join(os.tmpdir(), "md-wd-"));
  try {
    const projectId = seedProject(env.projects, {
      name: "p2", workingDir: wd, tmuxSessionName: "md-p2"
    });
    const app = buildGitTestApp({ projects: env.projects, features: env.features });
    const r = await getJson(app, `/api/projects/${projectId}/git/branches`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not a git project/i);
  } finally {
    fs.rmSync(wd, { recursive: true, force: true });
    env.cleanup();
  }
});
