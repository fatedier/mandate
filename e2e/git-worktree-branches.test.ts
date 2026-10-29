import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitBranchesCreatedInWorktree, gitBranchIsStill } from "../src/server/platform/git/git.js";
import { onCleanup } from "../tests/helpers/cleanup.js";
import { git, nextSecond, repoWithWorktree } from "./helpers/git-repo.js";

const madeIn = (dir: string) => gitBranchesCreatedInWorktree(dir).map((made) => made.name);

// Which branches a worker made in its own worktree, by git's own records
// alone: a branch counts only when its first reflog entry and a checkout of
// that worktree onto it are one moment (same second, same commit). Anything
// else — a branch made elsewhere and checked out there, the branch the
// worktree was made on — does not. Missing one is fine; naming one that is
// not the worker's is not.

test("a branch made in the worktree by checkout -b or switch -c counts", async () => {
  const { worktree } = repoWithWorktree();
  // A worker's first command comes seconds after its worktree.
  await nextSecond();
  git(worktree, ["commit", "-q", "--allow-empty", "-m", "work"]);
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  await nextSecond();
  git(worktree, ["switch", "-q", "-c", "fix/y"]);
  expect(madeIn(worktree).sort()).toEqual(["fix/x", "fix/y"]);
  // Each with the moment that shows it, to check again before a delete.
  const x = gitBranchesCreatedInWorktree(worktree).find((made) => made.name === "fix/x");
  expect(x?.reflog.map((entry) => entry.commit)).toEqual([git(worktree, ["rev-parse", "fix/x"])]);
  expect(x?.reflog[0]?.at).toMatch(/^\d+$/);
}, 10_000);

test("a branch made elsewhere and checked out in the worktree does not count", async () => {
  const { repo, worktree } = repoWithWorktree();
  // Made while the worker runs, in the owner's own checkout.
  await nextSecond();
  git(repo, ["branch", "owner-branch"]);
  await nextSecond();
  git(worktree, ["checkout", "-q", "owner-branch"]);
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  expect(madeIn(worktree)).toEqual(["fix/x"]);
}, 10_000);

test("the branch the worktree was made on does not count", () => {
  const { worktree } = repoWithWorktree();
  expect(madeIn(worktree)).toEqual([]);
});

test("a branch made in the worktree and deleted since is not listed", async () => {
  const { worktree } = repoWithWorktree();
  await nextSecond();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  git(worktree, ["checkout", "-q", "research/x"]);
  git(worktree, ["branch", "-q", "-D", "fix/x"]);
  expect(madeIn(worktree)).toEqual([]);
}, 10_000);

// The branch the worktree was made on was created in the worktree's first
// second; switched back to within that second on the same commit, its two
// entries line up like a branch made there. Nothing made that early counts.
test("nothing made in the worktree's first second counts, its own branch included", async () => {
  // Begun just past a second's start, so all of it falls in that second.
  await nextSecond();
  const { worktree } = repoWithWorktree();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  git(worktree, ["checkout", "-q", "research/x"]);
  expect(madeIn(worktree)).toEqual([]);
}, 10_000);

test("with the reflog switched off, nothing counts", () => {
  const { repo, worktree } = repoWithWorktree();
  git(repo, ["config", "core.logAllRefUpdates", "false"]);
  fs.rmSync(path.join(repo, ".git", "worktrees", "wt", "logs"), { recursive: true, force: true });
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  expect(madeIn(worktree)).toEqual([]);
});

// A branch's history can be carried to another name: a rename moves it, a
// copy (`git branch -c`) duplicates it. The copy's oldest entry is then the
// worker's, though the owner made the copy.
test("a branch with a renamed or copied history does not count", async () => {
  const { repo, worktree } = repoWithWorktree();
  await nextSecond();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  git(worktree, ["branch", "-m", "fix/x", "fix/archive"]);
  git(repo, ["branch", "-c", "fix/archive", "fix/x"]);
  expect(madeIn(worktree)).toEqual([]);
}, 10_000);

// Only a linked worktree's own root is read: a folder inside the repository
// (a worktree moved away, its old path made again) would read the owner's
// main checkout.
test("only the root of a linked worktree is read: a main checkout or a folder inside a checkout names nothing", async () => {
  const { repo, worktree } = repoWithWorktree();
  await nextSecond();
  git(repo, ["checkout", "-q", "-b", "owner/x"]);
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  fs.mkdirSync(path.join(repo, "sub"));
  fs.mkdirSync(path.join(worktree, "sub"));
  expect(madeIn(repo)).toEqual([]);
  expect(madeIn(path.join(repo, "sub"))).toEqual([]);
  expect(madeIn(path.join(worktree, "sub"))).toEqual([]);
  expect(madeIn(worktree)).toEqual(["fix/x"]);
}, 10_000);

// Two names the disk keeps as one file (letter case, or ẞ and ss on macOS)
// share one ref file and one reflog: deleting one can take the other. Only
// the disk knows which names those are.
const oneFileOnThisDisk = (dir: string, a: string, b: string) => {
  fs.writeFileSync(path.join(dir, `probe-${a.replace("/", "-")}`), "");
  return fs.existsSync(path.join(dir, `probe-${b.replace("/", "-")}`));
};
for (const [made, other] of [["fix/x", "fix/X"], ["fix/ẞ", "fix/ss"]] as const) {
  test(`a branch whose files the disk shares with another branch does not count (${made}, ${other})`, async () => {
    const { root, repo, worktree } = repoWithWorktree();
    await nextSecond();
    git(worktree, ["checkout", "-q", "-b", made]);
    git(worktree, ["checkout", "-q", "research/x"]);
    git(repo, ["pack-refs", "--all"]);
    git(repo, ["branch", other]);
    expect(madeIn(worktree)).toEqual(oneFileOnThisDisk(root, made, other) ? [] : [made]);
  }, 10_000);
}

// An ordinary `git gc` clears reflog entries past git's expiry (unreachable
// ones after 30 days by default): a rename or copy entry can go while the
// first entry stays. Only a branch made since the earliest moment gc could
// have cleared anything counts.
test("a branch made before git's reflog expiry does not count", () => {
  const madeDaysAgo = (days: number) => {
    const base = Math.floor(Date.now() / 1000) - days * 86_400;
    const at = (second: number) => ({ GIT_COMMITTER_DATE: `@${base + second} +0000`, GIT_AUTHOR_DATE: `@${base + second} +0000` });
    const { worktree } = repoWithWorktree("research/x", at(0));
    git(worktree, ["checkout", "-q", "-b", "fix/x"], at(5));
    return worktree;
  };
  expect(madeIn(madeDaysAgo(40))).toEqual([]);
  expect(madeIn(madeDaysAgo(10))).toEqual(["fix/x"]);
}, 10_000);

test("a repository whose settings let gc clear reflogs sooner counts nothing made before then", async () => {
  const { repo, worktree } = repoWithWorktree();
  await nextSecond();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  expect(madeIn(worktree)).toEqual(["fix/x"]);
  git(repo, ["config", "gc.reflogExpireUnreachable", "now"]);
  expect(madeIn(worktree)).toEqual([]);
  git(repo, ["config", "--unset", "gc.reflogExpireUnreachable"]);
  git(repo, ["config", "gc.refs/heads/fix/*.reflogExpire", "now"]);
  expect(madeIn(worktree)).toEqual([]);
  git(repo, ["config", "--unset", "gc.refs/heads/fix/*.reflogExpire"]);
  // A setting git itself cannot read: unsure, nothing counts.
  git(repo, ["config", "gc.reflogExpire", "whenever"]);
  expect(madeIn(worktree)).toEqual([]);
}, 10_000);

// With extensions.worktreeConfig a worktree can set its own expiry, and a gc
// run there clears the shared branch reflogs too: every worktree's settings
// count.
test("an owner's copy put back under the worker's name does not count when another worktree's gc clears sooner", async () => {
  const { root, repo, worktree } = repoWithWorktree();
  git(repo, ["config", "extensions.worktreeConfig", "true"]);
  const sibling = path.join(root, "sibling");
  git(repo, ["worktree", "add", "-q", "-b", "owner/sibling", sibling]);
  git(sibling, ["config", "--worktree", "gc.reflogExpireUnreachable", "now"]);
  await nextSecond();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  const born = git(worktree, ["rev-parse", "HEAD"]);
  git(worktree, ["commit", "-q", "--allow-empty", "-m", "work"]);
  git(worktree, ["branch", "-m", "fix/archive"]);
  await nextSecond();
  git(repo, ["branch", "-c", "fix/archive", "fix/x"]);
  git(repo, ["branch", "-f", "fix/x", born]);
  // What gc in that worktree does, by that worktree's own settings.
  git(sibling, ["reflog", "expire", "--all"]);
  expect(madeIn(worktree)).toEqual([]);
}, 10_000);

// A worktree moved with a plain `mv` still works, but git lists it at its old,
// missing path: its settings are read from git's own folder for it, which a
// move leaves where it is.
test("a moved worktree's own sooner expiry still counts", async () => {
  const { root, repo, worktree } = repoWithWorktree();
  git(repo, ["config", "extensions.worktreeConfig", "true"]);
  git(repo, ["worktree", "add", "-q", "-b", "owner/sibling", path.join(root, "sibling")]);
  const moved = path.join(root, "sibling-moved");
  fs.renameSync(path.join(root, "sibling"), moved);
  git(moved, ["config", "--worktree", "gc.reflogExpireUnreachable", "now"]);
  await nextSecond();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  expect(madeIn(worktree)).toEqual([]);
}, 10_000);

// Every entry in the branch's own record must be one this worktree wrote
// too: a change made from anywhere else (a reset, a copy over it) leaves the
// branch not shown to be the worker's.
test("a branch changed from outside the worktree does not count", async () => {
  const { repo, worktree } = repoWithWorktree();
  await nextSecond();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  git(worktree, ["commit", "-q", "--allow-empty", "-m", "work"]);
  git(worktree, ["checkout", "-q", "research/x"]);
  expect(madeIn(worktree)).toEqual(["fix/x"]);
  await nextSecond();
  git(repo, ["branch", "-f", "fix/x", "main"]);
  expect(madeIn(worktree)).toEqual([]);
}, 10_000);

test("a branch the worker commits, amends and rebases in its worktree still counts", async () => {
  const { repo, worktree } = repoWithWorktree();
  await nextSecond();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  git(worktree, ["commit", "-q", "--allow-empty", "-m", "work"]);
  git(worktree, ["commit", "-q", "--allow-empty", "--amend", "-m", "work, again"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "main moves on"]);
  git(worktree, ["rebase", "-q", "main"]);
  git(worktree, ["reset", "-q", "--hard", "HEAD"]);
  expect(madeIn(worktree)).toEqual(["fix/x"]);
}, 10_000);

test("a branch found is still itself only while its record is unchanged", async () => {
  const { repo, worktree } = repoWithWorktree();
  await nextSecond();
  git(worktree, ["checkout", "-q", "-b", "fix/x"]);
  const [x] = gitBranchesCreatedInWorktree(worktree);
  expect(gitBranchIsStill(worktree, x!)).toBe(true);
  const [birth] = x!.reflog;
  expect(gitBranchIsStill(worktree, { ...x!, reflog: [{ ...birth!, commit: "0".repeat(40) }] })).toBe(false);
  expect(gitBranchIsStill(worktree, { ...x!, reflog: [{ ...birth!, at: String(Number(birth!.at) - 1) }] })).toBe(false);
  // One more entry since it was found, though its first is the same.
  git(worktree, ["checkout", "-q", "research/x"]);
  await nextSecond();
  git(repo, ["commit", "-q", "--allow-empty", "-m", "main moves on"]);
  git(repo, ["branch", "-f", "fix/x", "main"]);
  expect(gitBranchIsStill(worktree, x!)).toBe(false);
}, 10_000);

test("a folder that is not a worktree names nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-not-a-worktree-"));
  onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
  expect(madeIn(dir)).toEqual([]);
  expect(madeIn(path.join(dir, "missing"))).toEqual([]);
});
