import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  MAX_COUNTED_UNTRACKED,
  gitDiffNames,
  gitDiffFile,
  gitDiffSummary,
  gitMergeBase,
} from "../src/server/platform/git/git-diff.js";
import { gitHeadCommit, type GitClient } from "../src/server/platform/git/git.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** Repo with: base commit on main; feature branch with one committed edit,
 *  one committed new file, one committed rename, one uncommitted edit, one
 *  untracked file. Returns dir + cleanup. */
function fixtureRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-gitdiff-"));
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
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe("gitMergeBase / gitHeadCommit", () => {
  test("resolves merge base and head", () => {
    const { dir, cleanup } = fixtureRepo();
    try {
      const mb = gitMergeBase(dir, "main");
      const head = gitHeadCommit(dir);
      expect(mb).toMatch(/^[0-9a-f]{40}$/);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
      expect(mb).not.toBe(head);
      expect(gitMergeBase(dir, "no-such-ref")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("gitDiffSummary", () => {
  test("reports committed, uncommitted, untracked, and renamed files", () => {
    const { dir, cleanup } = fixtureRepo();
    try {
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
    } finally {
      cleanup();
    }
  });
});

describe("gitDiffFile", () => {
  test("tracked patch, untracked patch, truncation", () => {
    const { dir, cleanup } = fixtureRepo();
    try {
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
    } finally {
      cleanup();
    }
  });

  test("pure rename renders as a rename, not full-file additions", () => {
    const { dir, cleanup } = fixtureRepo();
    try {
      const mb = gitMergeBase(dir, "main")!;
      const renamed = gitDiffFile(dir, mb, "renamed-dst.txt", {
        untracked: false,
        oldPath: "renamed-src.txt"
      })!;
      expect(renamed.patch).toContain("rename from renamed-src.txt");
      expect(renamed.patch).toContain("rename to renamed-dst.txt");
      expect(renamed.patch).not.toContain("new file mode");
    } finally {
      cleanup();
    }
  });
});

describe("gitDiffNames", () => {
  test("lists tracked, renamed, and untracked names without counting", () => {
    const { dir, cleanup } = fixtureRepo();
    try {
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
    } finally {
      cleanup();
    }
  });

  test("spawns exactly two git commands", () => {
    let spawns = 0;
    const fake = {
      runner: {
        run: (_bin: string, args: string[]) => {
          spawns += 1;
          if (args.includes("--name-status")) {
            return { status: 0, stdout: "M\0a.txt\0", stderr: "" };
          }
          return { status: 0, stdout: "u.txt\0", stderr: "" };
        }
      }
    };
    const names = gitDiffNames("/repo", "deadbeef", fake as never)!;
    expect(spawns).toBe(2);
    expect(names.map((n) => n.path)).toEqual(["a.txt", "u.txt"]);
  });
});

describe("gitDiffSummary untracked counting", () => {
  test("custom runner: one batched wc spawn, capped, remainder nulled", () => {
    const total = MAX_COUNTED_UNTRACKED + 5;
    const paths = Array.from({ length: total }, (_, i) => `u${String(i).padStart(4, "0")}.txt`);
    let wcSpawns = 0;
    let wcArgPaths = 0;
    const ok = (stdout: string) => ({ status: 0, signal: null, stdout, stderr: "" });
    const fake: GitClient = {
      runner: {
        run(command, args) {
          if (command === "wc") {
            wcSpawns += 1;
            const files = args.filter((a) => a !== "-l");
            wcArgPaths = files.length;
            const lines = files.map((f) => `       3 ${f}`);
            if (files.length > 1) lines.push(`     ${files.length * 3} total`);
            return ok(lines.join("\n") + "\n");
          }
          if (args.includes("rev-parse")) return ok(`${"a".repeat(40)}\n`);
          if (args.includes("ls-files")) return ok(paths.map((p) => `${p}\0`).join(""));
          // name-status, numstat, status --porcelain: empty tracked change set
          return ok("");
        }
      }
    };

    const summary = gitDiffSummary("/repo", "b".repeat(40), fake)!;
    expect(wcSpawns).toBe(1);
    expect(wcArgPaths).toBe(MAX_COUNTED_UNTRACKED);
    expect(summary.files.length).toBe(total);

    const counted = summary.files.slice(0, MAX_COUNTED_UNTRACKED);
    for (const f of counted) expect(f.additions).toBe(3);

    const uncounted = summary.files.slice(MAX_COUNTED_UNTRACKED);
    expect(uncounted.length).toBe(5);
    for (const f of uncounted) {
      expect(f.additions).toBeNull();
      expect(f.deletions).toBeNull();
      expect(f.binary).toBe(false);
    }
  });

  test("local: counts in-process with git numstat line semantics", () => {
    const { dir, cleanup } = fixtureRepo();
    try {
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
    } finally {
      cleanup();
    }
  });
});

