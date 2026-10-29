import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { gitArchiveCheck } from "../src/server/platform/git/git-archive-check.js";
import { tempGitRepo } from "./helpers/fixtures.js";

const sh = (dir: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const commitFile = (dir: string, name: string, body: string, msg: string) => {
  fs.writeFileSync(path.join(dir, name), body);
  sh(dir, "add", name);
  sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", msg);
};
const input = (dir: string) => ({ worktreePath: dir, repoDir: dir, workingDir: dir, branch: "fix-x", baseRefHint: "main" });

test("real git: unmerged, then squash-merged counts as merged, then dirty", () => {
  const { dir, cleanup } = tempGitRepo();
  try {
    sh(dir, "checkout", "-b", "fix-x");
    commitFile(dir, "a.txt", "one\n", "a1");
    commitFile(dir, "a.txt", "two\n", "a2");
    expect(gitArchiveCheck(input(dir)).findings).toEqual(['Branch "fix-x" has 2 commits not in main.']);

    // Squash-merge into main: new commit on main with the branch's content.
    sh(dir, "checkout", "main");
    sh(dir, "merge", "--squash", "fix-x");
    sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "squash");
    sh(dir, "checkout", "fix-x");
    expect(gitArchiveCheck(input(dir))).toMatchObject({ unmergedCommits: 0, findings: [] });

    fs.writeFileSync(path.join(dir, "scratch.txt"), "x");
    expect(gitArchiveCheck(input(dir)).findings).toEqual(["1 uncommitted file in the worktree."]);
  } finally { cleanup(); }
});

test("real git: a rename is unmerged while the base still has the old path", () => {
  const { dir, cleanup } = tempGitRepo();
  try {
    commitFile(dir, "old.txt", "same\n", "old");
    sh(dir, "checkout", "-b", "fix-x");
    sh(dir, "mv", "old.txt", "new.txt");
    sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "rename");
    // The base gains an identical new.txt but keeps old.txt: the branch's
    // deletion of old.txt is not in it.
    sh(dir, "checkout", "main");
    commitFile(dir, "new.txt", "same\n", "add new");
    sh(dir, "checkout", "fix-x");
    expect(gitArchiveCheck(input(dir)).findings).toEqual(['Branch "fix-x" has 1 commit not in main.']);
  } finally { cleanup(); }
});

test("real git: untracked files count even where status hides them", () => {
  const { dir, cleanup } = tempGitRepo();
  try {
    sh(dir, "checkout", "-b", "fix-x");
    sh(dir, "config", "status.showUntrackedFiles", "no");
    fs.writeFileSync(path.join(dir, "notes.txt"), "draft");
    expect(gitArchiveCheck({ ...input(dir), baseRefHint: "main" }).findings).toEqual(["1 uncommitted file in the worktree."]);
  } finally { cleanup(); }
});

test("real git: ignored files and directories are not findings", () => {
  const { dir, cleanup } = tempGitRepo();
  try {
    sh(dir, "checkout", "-b", "fix-x");
    commitFile(dir, ".gitignore", ".env\nnode_modules/\n", "ignore");
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=local");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "x");
    const findings = gitArchiveCheck({ ...input(dir), baseRefHint: "main" }).findings;
    // The branch has one commit (.gitignore) not in main; the ignored .env and
    // node_modules are not asked about.
    expect(findings).toEqual(['Branch "fix-x" has 1 commit not in main.']);
  } finally { cleanup(); }
});

test("real git: a base recorded as HEAD means the project's checkout, not the worktree whose HEAD is the branch", () => {
  const { dir, cleanup } = tempGitRepo();
  const wt = `${dir}-wt`;
  try {
    // Created with baseRef "HEAD": branched from the checkout's HEAD (main).
    sh(dir, "worktree", "add", "-b", "fix-x", wt, "HEAD");
    commitFile(wt, "a.txt", "one\n", "a1");
    const findings = gitArchiveCheck({ worktreePath: wt, repoDir: wt, workingDir: dir, branch: "fix-x", baseRefHint: "HEAD" }).findings;
    expect(findings).toEqual(['Branch "fix-x" has 1 commit not in main.']);
  } finally {
    fs.rmSync(wt, { recursive: true, force: true });
    cleanup();
  }
});
