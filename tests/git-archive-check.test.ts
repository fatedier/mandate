import { expect, test } from "bun:test";
import { gitArchiveCheck } from "../src/server/platform/git/git-archive-check.js";
import type { GitClient } from "../src/server/platform/git/git.js";

/** Answers git by the argument list after `-C <dir>`; unknown commands fail. */
function fakeGit(answers: Record<string, { status?: number; stdout?: string }>): GitClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    runner: {
      run: (_bin: string, args: string[]) => {
        const key = args.slice(2).join(" ");
        calls.push(key);
        const a = answers[key];
        return { status: a ? (a.status ?? 0) : 1, signal: null, stdout: a?.stdout ?? "", stderr: "" };
      }
    }
  };
}

const K = "status --porcelain -z --untracked-files=normal --ignore-submodules=none";
const base = { worktreePath: "/wt", repoDir: "/wt", workingDir: "/repo", branch: "fix-x", baseRefHint: "origin/master" };

test("clean worktree and a branch already in its base: safe", () => {
  const git = fakeGit({
    "status --porcelain -z --untracked-files=normal --ignore-submodules=none": { stdout: "" },
    "rev-list --count origin/master..fix-x": { stdout: "0\n" }
  });
  const r = gitArchiveCheck(base, git);
  expect(r).toMatchObject({ dirtyFiles: 0, unmergedCommits: 0, branch: "fix-x", baseRef: "origin/master", findings: [] });
});

test("ignored files are not asked about: status is read without them", () => {
  // Removing the worktree takes them, as archiving always has, and nothing
  // asks about them.
  const git = fakeGit({
    [K]: { stdout: " M a.ts\0?? folder with space/\0" },
    "rev-list --count origin/master..fix-x": { stdout: "0\n" }
  });
  expect(gitArchiveCheck(base, git).findings).toEqual(["2 uncommitted files in the worktree."]);
  expect(git.calls[0]).toBe(K);
});

test("a checkout attached as a worker records no base: it is measured against the remote's default, not its own branch", () => {
  const git = fakeGit({
    "branch --show-current": { stdout: "fix-x\n" },
    "rev-list --count fix-x..fix-x": { stdout: "0\n" },
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": { stdout: "origin/main\n" },
    "rev-list --count origin/main..fix-x": { stdout: "3\n" },
    "merge-base origin/main fix-x": { stdout: "mb\n" },
    "diff --name-only --no-renames --ignore-submodules=none -z mb fix-x": { stdout: "a.ts\0" }
  });
  const r = gitArchiveCheck({ worktreePath: null, repoDir: "/repo", workingDir: "/repo", branch: "fix-x", baseRefHint: null }, git);
  expect({ baseRef: r.baseRef, unmergedCommits: r.unmergedCommits }).toEqual({ baseRef: "origin/main", unmergedCommits: 3 });
});

test("a rebase the checkout remembers onto the branch itself is no base either: the remote's default is", () => {
  // A shared checkout rebased another branch onto this one, then switched to
  // it: its reflog names the worker's own branch.
  const git = fakeGit({
    "reflog show --no-abbrev HEAD": { stdout: "abc HEAD@{0}: rebase (start): checkout fix-x\n" },
    "rev-parse --verify fix-x^{commit}": { stdout: "abc\n" },
    "symbolic-ref --quiet --short refs/remotes/origin/HEAD": { stdout: "origin/main\n" },
    "rev-list --count origin/main..fix-x": { stdout: "0\n" }
  });
  const r = gitArchiveCheck({ worktreePath: null, repoDir: "/repo", workingDir: "/repo", branch: "fix-x", baseRefHint: null }, git);
  expect({ baseRef: r.baseRef, unmergedCommits: r.unmergedCommits, findings: r.findings }).toEqual({ baseRef: "origin/main", unmergedCommits: 0, findings: [] });
});

test("a branch whose only possible base is itself asks instead of passing", () => {
  const git = fakeGit({
    "branch --show-current": { stdout: "fix-x\n" },
    "rev-list --count fix-x..fix-x": { stdout: "0\n" }
  });
  const r = gitArchiveCheck({ worktreePath: null, repoDir: "/repo", workingDir: "/repo", branch: "fix-x", baseRefHint: null }, git);
  expect(r.findings).toEqual(['Could not tell which branch "fix-x" merges into.']);
});

test("dirty worktree: counts files, untracked included", () => {
  const git = fakeGit({
    "status --porcelain -z --untracked-files=normal --ignore-submodules=none": { stdout: " M a.ts\0?? b.ts\0R  d.ts\0c.ts\0" },
    "rev-list --count origin/master..fix-x": { stdout: "0\n" }
  });
  expect(gitArchiveCheck(base, git).findings).toEqual(["3 uncommitted files in the worktree."]);
});

test("commits whose files differ from the base: unmerged", () => {
  const git = fakeGit({
    "status --porcelain -z --untracked-files=normal --ignore-submodules=none": { stdout: "" },
    "rev-list --count origin/master..fix-x": { stdout: "4\n" },
    "merge-base origin/master fix-x": { stdout: "abc\n" },
    "diff --name-only --no-renames --ignore-submodules=none -z abc fix-x": { stdout: "a.ts\0b.ts\0" },
    "diff --quiet --ignore-submodules=none origin/master fix-x -- :(literal)a.ts :(literal)b.ts": { status: 1 }
  });
  expect(gitArchiveCheck(base, git).findings).toEqual(['Branch "fix-x" has 4 commits not in origin/master.']);
});

test("squash-merged: commits exist, but every file the branch changed matches the base", () => {
  const git = fakeGit({
    "status --porcelain -z --untracked-files=normal --ignore-submodules=none": { stdout: "" },
    "rev-list --count origin/master..fix-x": { stdout: "4\n" },
    "merge-base origin/master fix-x": { stdout: "abc\n" },
    "diff --name-only --no-renames --ignore-submodules=none -z abc fix-x": { stdout: "a.ts\0" },
    "diff --quiet --ignore-submodules=none origin/master fix-x -- :(literal)a.ts": { status: 0 }
  });
  expect(gitArchiveCheck(base, git)).toMatchObject({ unmergedCommits: 0, findings: [] });
});

test("shared-cwd style (no worktree, no branch): nothing to check", () => {
  const git = fakeGit({});
  expect(gitArchiveCheck({ ...base, worktreePath: null, branch: null }, git))
    .toEqual({ dirtyFiles: null, unmergedCommits: null, branch: null, baseRef: null, findings: [] });
  expect(git.calls).toStrictEqual([]);
});

test("a git failure is a finding, never a silent pass", () => {
  const git = fakeGit({ "rev-list --count origin/master..fix-x": { stdout: "0\n" } });
  expect(gitArchiveCheck(base, git).findings).toEqual(["Could not read the worktree's status."]);
});
