import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildGitTestApp } from "../../tests/helpers/test-app.js";
import { freshStoresEnv, seedFeature, seedProject } from "../../tests/helpers/fixtures.js";
import type { FeatureChangesFileResponse, FeatureChangesResponse } from "../../src/shared/api-contracts.js";

function git(dir: string, ...args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function repoWithFeatureBranch(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-changes-"));
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
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("GET /api/features/:featureId/changes", () => {
  test("the branch comparison, asked for by name, answers against the merge base", async () => {
    const env = freshStoresEnv();
    const repo = repoWithFeatureBranch();
    try {
      const projectId = seedProject(env.projects, { workingDir: repo.dir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repo.dir
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
      repo.cleanup();
      env.cleanup();
    }
  });

  test("the default comparison is the uncommitted work, not the branch", async () => {
    // The coverage whose absence let this tier drift: `compare=head` became the
    // default while every test here described a branch comparison, so nothing
    // ran the mode a reader actually gets.
    const env = freshStoresEnv();
    const repo = repoWithFeatureBranch();
    try {
      fs.writeFileSync(path.join(repo.dir, "dirty.txt"), "not committed\n");
      const projectId = seedProject(env.projects, { workingDir: repo.dir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repo.dir
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
      repo.cleanup();
      env.cleanup();
    }
  });

  test("400 for branchless feature, 404 unknown, 409 missing worktree", async () => {
    const env = freshStoresEnv();
    try {
      const projectId = seedProject(env.projects, { workingDir: "/tmp", isGit: true });
      const plain = seedFeature(env.features, projectId, { mode: "shared-cwd", branch: null });
      const gone = seedFeature(env.features, projectId, {
        // active features are unique per project on both name and window name;
        // the defaults ("F" / "f") are taken by `plain` above
        name: "G",
        tmuxWindowName: "g",
        mode: "new-branch-new-worktree",
        branch: "feat/gone",
        worktreePath: path.join(os.tmpdir(), "md-definitely-missing-worktree")
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });
      expect((await app.request(`/api/features/${plain}/changes`)).status).toBe(400);
      expect((await app.request(`/api/features/no-such/changes`)).status).toBe(404);
      const conflict = await app.request(`/api/features/${gone}/changes`);
      expect(conflict.status).toBe(409);
      const body = (await conflict.json()) as { error: string };
      expect(body.error).toContain("reconcile");
    } finally {
      env.cleanup();
    }
  });
});

describe("file endpoint reuses the names cache primed by the summary", () => {
  test("a file fetch after a summary costs exactly one more git spawn", async () => {
    const env = freshStoresEnv();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-cache-"));
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
      fs.rmSync(repoDir, { recursive: true, force: true });
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
    const repo = repoWithFeatureBranch();
    try {
      const projectId = seedProject(env.projects, { workingDir: repo.dir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repo.dir
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
      repo.cleanup();
      env.cleanup();
    }
  });

  test("a path missing from the cache falls back to a fresh recompute", async () => {
    const env = freshStoresEnv();
    const repo = repoWithFeatureBranch();
    try {
      const projectId = seedProject(env.projects, { workingDir: repo.dir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repo.dir
      });
      const app = buildGitTestApp({ projects: env.projects, features: env.features });

      expect((await app.request(`/api/features/${featureId}/changes`)).status).toBe(200);
      // File born AFTER the cache was primed must still resolve immediately.
      fs.writeFileSync(path.join(repo.dir, "born-later.txt"), "n1\n");
      const res = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("born-later.txt")}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as FeatureChangesFileResponse;
      expect(body.patch).toContain("+n1");
    } finally {
      repo.cleanup();
      env.cleanup();
    }
  });
});

describe("GET /api/features/:featureId/changes/file", () => {
  test("returns a patch only for paths inside the change set", async () => {
    const env = freshStoresEnv();
    const repo = repoWithFeatureBranch();
    try {
      const projectId = seedProject(env.projects, { workingDir: repo.dir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repo.dir
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
      fs.writeFileSync(path.join(repo.dir, "scratch.txt"), "u1\nu2\n");
      const untracked = await app.request(`/api/features/${featureId}/changes/file?path=${encodeURIComponent("scratch.txt")}&compare=branch`);
      expect(untracked.status).toBe(200);
      const upatch = (await untracked.json()) as FeatureChangesFileResponse;
      expect(upatch.patch).toContain("+u1");
    } finally {
      repo.cleanup();
      env.cleanup();
    }
  });

  test("pure rename renders as a rename, not full-file additions", async () => {
    const env = freshStoresEnv();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-changes-"));
    const repo = { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
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
      const projectId = seedProject(env.projects, { workingDir: repo.dir, isGit: true });
      const featureId = seedFeature(env.features, projectId, {
        mode: "existing-branch-existing-worktree",
        branch: "feat/x",
        baseRef: "main",
        worktreePath: repo.dir
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
      repo.cleanup();
      env.cleanup();
    }
  });
});
