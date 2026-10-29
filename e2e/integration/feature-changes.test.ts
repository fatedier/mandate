import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildGitTestApp } from "../../tests/helpers/test-app.js";
import { freshStoresEnv, seedFeature, seedProject } from "../../tests/helpers/fixtures.js";
import { tempDir } from "../../tests/helpers/temp.js";
import type { FeatureChangesFileResponse, FeatureChangesResponse } from "../../src/shared/api-contracts.js";

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function repoWithFeatureBranch(): string {
  const dir = tempDir("md-changes-");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  git(dir, "checkout", "-b", "feat/x");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "work");
  return dir;
}

describe("GET /api/features/:featureId/changes", () => {
  test("the branch comparison, asked for by name, answers against the merge base", async () => {
    const env = freshStoresEnv();
    const repoDir = repoWithFeatureBranch();
    try {
      const projectId = seedProject(env.projects, { workingDir: repoDir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repoDir
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });
      const res = await app.request(`/api/features/${featureId}/changes?compare=branch`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeatureChangesResponse;
      // The mode is read back, not assumed: `compare` takes anything but
      // "branch" as head, so a request that lost the parameter would answer
      // 200 with an empty file list and every other assertion here would be
      // vacuous rather than wrong.
      expect(body.compare).toBe("branch");
      expect(body.baseRef).toBe("main");
      expect(body.files.map((f) => f.path)).toEqual(["a.txt"]);
      expect(body.files[0]!.status).toBe("M");
    } finally {
      env.cleanup();
    }
  });

  test("the default comparison is the uncommitted work, not the branch", async () => {
    // The coverage whose absence let this tier drift: `compare=head` became the
    // default while every test here described a branch comparison, so nothing
    // ran the mode a reader actually gets.
    const env = freshStoresEnv();
    const repoDir = repoWithFeatureBranch();
    try {
      fs.writeFileSync(path.join(repoDir, "dirty.txt"), "not committed\n");
      const projectId = seedProject(env.projects, { workingDir: repoDir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repoDir
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });
      const res = await app.request(`/api/features/${featureId}/changes`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeatureChangesResponse;
      expect(body.compare).toBe("head");
      // No base is resolved at all in this mode, which is the point of it.
      expect(body.baseRef).toBe("HEAD");
      // `a.txt` is the branch's whole change and it is committed, so the two
      // modes disagree about it — which is what makes this more than a
      // restatement of the test above.
      expect(body.files.map((f) => f.path)).toEqual(["dirty.txt"]);
    } finally {
      env.cleanup();
    }
  });

  // A worker made to work in the project's own directory has no branch of its
  // own. It had no Changes at all: the answer was 400 "feature has no branch",
  // though what is uncommitted needs no branch and no base.
  test("a worker with no branch of its own is answered from the project's directory: what is uncommitted there", async () => {
    const env = freshStoresEnv();
    const repoDir = repoWithFeatureBranch();
    try {
      fs.writeFileSync(path.join(repoDir, "a.txt"), "one\ntwo\nthree\n");
      fs.writeFileSync(path.join(repoDir, "notes.txt"), "not committed\n");
      const projectId = seedProject(env.projects, { workingDir: repoDir, isGit: true });
      const shared = seedFeature(env.features, projectId, { mode: "shared-cwd", branch: null });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });

      const res = await app.request(`/api/features/${shared}/changes`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeatureChangesResponse;
      expect([body.compare, body.baseRef]).toEqual(["head", "HEAD"]);
      // The edit to a tracked file and the new file; `a.txt`'s committed line is not among them.
      expect(body.files.map((f) => [f.path, f.untracked]).sort()).toEqual([["a.txt", false], ["notes.txt", true]]);
      expect([body.totalAdditions, body.totalDeletions]).toEqual([2, 0]);

      // Each file's patch, through the same gate of membership.
      const edited = await app.request(`/api/features/${shared}/changes/file?path=${encodeURIComponent("a.txt")}`);
      expect(edited.status).toBe(200);
      const patch = ((await edited.json()) as FeatureChangesFileResponse).patch;
      expect(patch).toContain("+three");
      expect(patch).not.toContain("+two");
      const added = await app.request(`/api/features/${shared}/changes/file?path=${encodeURIComponent("notes.txt")}`);
      expect(added.status).toBe(200);
      expect(((await added.json()) as FeatureChangesFileResponse).patch).toContain("+not committed");
      expect((await app.request(`/api/features/${shared}/changes/file?path=${encodeURIComponent("../../etc/hosts")}`)).status).toBe(404);
    } finally {
      env.cleanup();
    }
  });

  test("the comparison against a base is refused for a worker with no branch of its own: it has no base", async () => {
    const env = freshStoresEnv();
    const repoDir = repoWithFeatureBranch();
    try {
      fs.writeFileSync(path.join(repoDir, "notes.txt"), "not committed\n");
      const projectId = seedProject(env.projects, { workingDir: repoDir, isGit: true });
      const shared = seedFeature(env.features, projectId, { mode: "shared-cwd", branch: null });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });
      const summary = await app.request(`/api/features/${shared}/changes?compare=branch`);
      expect(summary.status).toBe(400);
      expect(((await summary.json()) as { error: string }).error).toBe("this worker has no branch of its own to compare from a base");
      // The file too, asked for cold, with no names remembered from a summary.
      const file = await app.request(`/api/features/${shared}/changes/file?path=${encodeURIComponent("notes.txt")}&compare=branch`);
      expect(file.status).toBe(400);
      // What is uncommitted is still answered.
      expect((await app.request(`/api/features/${shared}/changes`)).status).toBe(200);
    } finally {
      env.cleanup();
    }
  });

  test("400 outside a git project, 404 unknown, 409 missing worktree", async () => {
    const env = freshStoresEnv();
    try {
      const plainProject = seedProject(env.projects, { name: "Plain", tmuxSessionName: "md-plain", workingDir: "/tmp", isGit: false });
      const plain = seedFeature(env.features, plainProject, { mode: "shared-cwd", branch: null });
      const projectId = seedProject(env.projects, { workingDir: "/tmp", isGit: true });
      const gone = seedFeature(env.features, projectId, {
        // active features are unique per project on both name and window name
        name: "G",
        tmuxWindowName: "g",
        mode: "new-branch-new-worktree",
        branch: "feat/gone",
        worktreePath: path.join(os.tmpdir(), "md-definitely-missing-worktree")
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });
      const refused = await app.request(`/api/features/${plain}/changes`);
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: string }).error).toBe("project is not a git project");
      expect((await app.request(`/api/features/no-such/changes`)).status).toBe(404);
      const conflict = await app.request(`/api/features/${gone}/changes`);
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as { error: string; code?: string };
      // A code the client can name the case by, and a sentence that names
      // the folder and a real way out (there is no "reconcile" control).
      expect(body.code).toBe("worktree_missing");
      expect(body.error).toContain(path.join(os.tmpdir(), "md-definitely-missing-worktree"));
      expect(body.error).toContain("Archive the worker");
      expect(body.error).not.toContain("reconcile");
    } finally {
      env.cleanup();
    }
  });
});

describe("file endpoint reuses the names cache primed by the summary", () => {
  test("a file fetch after a summary costs exactly one more git spawn", async () => {
    const env = freshStoresEnv();
    const repoDir = tempDir("md-cache-");
    const calls: string[][] = [];
    const hash = "a".repeat(40);
    const ok = (stdout: string) => ({ status: 0, signal: null, stdout, stderr: "" });
    const fakeClient = {
      runner: {
        run(_command: string, args: string[]) {
          calls.push(args);
          if (args.includes("merge-base")) return ok(`${hash}\n`);
          if (args.includes("--name-status")) return ok("M\0a.txt\0");
          if (args.includes("--numstat")) return ok("1\t0\ta.txt\0");
          if (args.includes("ls-files")) return ok("");
          if (args.includes("rev-parse")) return ok(`${hash}\n`);
          if (args.includes("status")) return ok("");
          // per-file patch
          return ok("--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n");
        }
      }
    };
    try {
      const projectId = seedProject(env.projects, { workingDir: repoDir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repoDir
      });
      const app = buildGitTestApp({
        projects: env.projects,
        features: env.features,
        gitClient: fakeClient
      });

      const summary = await app.request(`/api/features/${featureId}/changes`);
      expect(summary.status).toBe(200);
      const afterSummary = calls.length;

      const file = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("a.txt")}`);
      expect(file.status).toBe(200);
      expect(calls.length).toBe(afterSummary + 1);
      expect(calls[calls.length - 1]).toContain("a.txt");

      const again = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("a.txt")}`);
      expect(again.status).toBe(200);
      expect(calls.length).toBe(afterSummary + 2);
    } finally {
      env.cleanup();
    }
  });

  test("a branch-mode summary does not let a head-mode read past the membership gate", async () => {
    // The cache is keyed by mode because membership in one change set gates
    // every file read in it. Keyed by feature alone, the branch summary below
    // would prime `a.txt` and the head request would then serve a file that is
    // not in the head change set — a real diff, of the wrong comparison, with
    // nothing to signal it.
    const env = freshStoresEnv();
    const repoDir = repoWithFeatureBranch();
    try {
      const projectId = seedProject(env.projects, { workingDir: repoDir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repoDir
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });

      const primed = await app.request(`/api/features/${featureId}/changes?compare=branch`);
      expect(primed.status).toBe(200);
      expect(((await primed.json()) as FeatureChangesResponse).files.map((f) => f.path))
        .toEqual(["a.txt"]);

      const head = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("a.txt")}`);
      expect(head.status).toBe(404);
      // And the branch read still works, so the 404 above is the mode talking
      // and not the cache having been emptied.
      const branch = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("a.txt")}&compare=branch`);
      expect(branch.status).toBe(200);
    } finally {
      env.cleanup();
    }
  });

  test("a path missing from the cache falls back to a fresh recompute", async () => {
    const env = freshStoresEnv();
    const repoDir = repoWithFeatureBranch();
    try {
      const projectId = seedProject(env.projects, { workingDir: repoDir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repoDir
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });

      expect((await app.request(`/api/features/${featureId}/changes`)).status).toBe(200);
      // File born AFTER the cache was primed must still resolve immediately.
      fs.writeFileSync(path.join(repoDir, "born-later.txt"), "n1\n");
      const res = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("born-later.txt")}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeatureChangesFileResponse;
      expect(body.patch).toContain("+n1");
    } finally {
      env.cleanup();
    }
  });
});

describe("GET /api/features/:featureId/changes/file", () => {
  test("returns a patch only for paths inside the change set", async () => {
    const env = freshStoresEnv();
    const repoDir = repoWithFeatureBranch();
    try {
      const projectId = seedProject(env.projects, { workingDir: repoDir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repoDir
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });
      // `a.txt` is committed on the branch, so it is in the branch change set
      // and not the head one — the mode has to be named or this reads 404.
      const ok = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("a.txt")}&compare=branch`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as FeatureChangesFileResponse;
      expect(body.patch).toContain("+two");

      // path outside the change set (or the repo) must be rejected, not read
      const evil = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("../../etc/hosts")}&compare=branch`);
      expect(evil.status).toBe(404);
      expect((await app.request(`/api/features/${featureId}/changes/file`)).status).toBe(400);

      // untracked files resolve through the names listing (no-index patch), and
      // are the one thing both comparisons agree on: neither has a committed
      // version to diff against.
      fs.writeFileSync(path.join(repoDir, "scratch.txt"), "u1\nu2\n");
      const untracked = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("scratch.txt")}&compare=branch`);
      expect(untracked.status).toBe(200);
      const upatch = (await untracked.json()) as FeatureChangesFileResponse;
      expect(upatch.patch).toContain("+u1");
    } finally {
      env.cleanup();
    }
  });

  test("pure rename renders as a rename, not full-file additions", async () => {
    const env = freshStoresEnv();
    const dir = tempDir("md-changes-");
    try {
      git(dir, "init", "-b", "main");
      git(dir, "config", "user.email", "t@t");
      git(dir, "config", "user.name", "t");
      fs.writeFileSync(path.join(dir, "a.txt"), "same content\nstays identical\n");
      git(dir, "add", ".");
      git(dir, "commit", "-m", "base");
      git(dir, "checkout", "-b", "feat/x");
      git(dir, "mv", "a.txt", "b.txt");
      git(dir, "commit", "-m", "rename");
      const projectId = seedProject(env.projects, { workingDir: dir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: dir
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });
      // The rename is committed, so it exists only in the branch comparison.
      const res = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("b.txt")}&compare=branch`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeatureChangesFileResponse;
      expect(body.patch).toContain("rename from a.txt");
      expect(body.patch).toContain("rename to b.txt");
      expect(body.patch).not.toContain("new file mode");
    } finally {
      env.cleanup();
    }
  });
});
