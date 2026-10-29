import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  MAX_COUNTED_UNTRACKED,
  gitDiffNames,
  gitDiffFile,
  gitDiffSummary,
  gitMergeBase,
} from "../src/server/platform/git/git-diff.js";
import { gitHeadCommit } from "../src/server/platform/git/git.js";
import { tempDir } from "../tests/helpers/temp.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** Repo with: base commit on main; feature branch with one committed edit,
 *  one committed new file, one committed rename, one uncommitted edit, one
 *  untracked file. Returns its dir. */
function fixtureRepo(): string {
  const dir = tempDir("md-gitdiff-");
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "renamed-src.txt"), "same content\nstays identical\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "base");
  git(dir, "checkout", "-b", "feature");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "hello\n");
  git(dir, "mv", "renamed-src.txt", "renamed-dst.txt");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "feature work");
  fs.appendFileSync(path.join(dir, "a.txt"), "four\n"); // uncommitted edit
  fs.writeFileSync(path.join(dir, "untracked.txt"), "u1\nu2\n"); // untracked
  return dir;
}

describe("gitMergeBase / gitHeadCommit", () => {
  test("resolves merge base and head", () => {
    const dir = fixtureRepo();
    const mb = gitMergeBase(dir, "main");
    const head = gitHeadCommit(dir);
    expect(mb).toMatch(/^[0-9a-f]{40}$/);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(mb).not.toBe(head);
    expect(gitMergeBase(dir, "no-such-ref")).toBeNull();
  });
});

describe("gitDiffSummary", () => {
  test("reports committed, uncommitted, untracked, and renamed files", () => {
    const dir = fixtureRepo();
    const mb = gitMergeBase(dir, "main")!;
    const summary = gitDiffSummary(dir, mb)!;
    const byPath = new Map(summary.files.map((f) => [f.path, f]));

    const a = byPath.get("a.txt")!;
    expect(a.status).toBe("M");
    expect(a.uncommitted).toBe(true); // working-tree edit on top of commit
    expect(a.additions).toBe(2); // "three" + "four" vs merge base

    const added = byPath.get("new.txt")!;
    expect(added.status).toBe("A");
    expect(added.uncommitted).toBe(false);

    const renamed = byPath.get("renamed-dst.txt")!;
    expect(renamed.status).toBe("R");
    expect(renamed.oldPath).toBe("renamed-src.txt");

    const untracked = byPath.get("untracked.txt")!;
    expect(untracked.status).toBe("A");
    expect(untracked.uncommitted).toBe(true);
    expect(untracked.additions).toBe(2);

    expect(summary.totalAdditions).toBeGreaterThanOrEqual(5);
    expect(summary.head).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("gitDiffFile", () => {
  test("tracked patch, untracked patch, truncation", () => {
    const dir = fixtureRepo();
    const mb = gitMergeBase(dir, "main")!;
    const tracked = gitDiffFile(dir, mb, "a.txt", { untracked: false })!;
    expect(tracked.patch).toContain("+three");
    expect(tracked.patch).toContain("+four");
    expect(tracked.truncated).toBe(false);

    const untracked = gitDiffFile(dir, mb, "untracked.txt", { untracked: true })!;
    expect(untracked.patch).toContain("+u1");

    const tiny = gitDiffFile(dir, mb, "a.txt", { untracked: false, maxBytes: 10 })!;
    expect(tiny.truncated).toBe(true);
    expect(tiny.patch.length).toBeLessThanOrEqual(10);
  });

});

describe("gitDiffNames", () => {
  test("lists tracked, renamed, and untracked names without counting", () => {
    const dir = fixtureRepo();
    const mb = gitMergeBase(dir, "main")!;
    const names = gitDiffNames(dir, mb)!;
    const byPath = new Map(names.map((n) => [n.path, n]));

    expect(byPath.get("a.txt")).toMatchObject({ status: "M", untracked: false });
    expect(byPath.get("new.txt")).toMatchObject({ status: "A", untracked: false });
    expect(byPath.get("renamed-dst.txt")).toMatchObject({
      status: "R",
      oldPath: "renamed-src.txt",
      untracked: false
    });
    expect(byPath.get("untracked.txt")).toMatchObject({
      status: "A",
      oldPath: null,
      untracked: true
    });
    expect(names.map((n) => n.path)).toEqual([...names.map((n) => n.path)].sort());
  });
});

describe("gitDiffSummary untracked counting", () => {
  test("only the first MAX_COUNTED_UNTRACKED untracked files are counted; the rest are unknown", () => {
    const dir = fixtureRepo();
    // Named to sort ahead of the fixture's untracked.txt, as ls-files lists them.
    const extra = Array.from({ length: MAX_COUNTED_UNTRACKED + 5 }, (_, i) => `u${String(i).padStart(4, "0")}.txt`);
    for (const name of extra) fs.writeFileSync(path.join(dir, name), "x\n");
    const summary = gitDiffSummary(dir, gitMergeBase(dir, "main")!)!;
    const additions = new Map(summary.files.map((f) => [f.path, f.additions]));
    expect(extra.slice(0, MAX_COUNTED_UNTRACKED).every((name) => additions.get(name) === 1)).toBe(true);
    expect([...extra.slice(MAX_COUNTED_UNTRACKED), "untracked.txt"].map((name) => additions.get(name))).toEqual(Array(6).fill(null));
  });


  test("local: counts in-process with git numstat line semantics", () => {
    const dir = fixtureRepo();
    fs.writeFileSync(path.join(dir, "no-trailing.txt"), "a\nb"); // partial last line counts
    fs.writeFileSync(path.join(dir, "empty.txt"), "");
    fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 0, 2, 3]));
    const mb = gitMergeBase(dir, "main")!;
    const summary = gitDiffSummary(dir, mb)!;
    const byPath = new Map(summary.files.map((f) => [f.path, f]));

    expect(byPath.get("no-trailing.txt")).toMatchObject({ additions: 2, binary: false });
    expect(byPath.get("empty.txt")).toMatchObject({ additions: 0, binary: false });
    expect(byPath.get("bin.dat")).toMatchObject({ additions: null, binary: true });
    expect(byPath.get("untracked.txt")).toMatchObject({ additions: 2 });
  });
});

