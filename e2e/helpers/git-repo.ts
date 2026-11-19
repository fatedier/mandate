import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onCleanup } from "../../tests/helpers/cleanup.js";

// Real git repositories for tests that ask what git itself recorded.

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };

/** The time every git() call writes, in whole seconds as reflogs keep it:
 *  an hour ago, well inside the 30 days git's reflog expiry counts back from
 *  the real now, and moved only by nextSecond. Which steps share a second is
 *  then the test's to say, not the wall clock's. */
let second = Math.floor(Date.now() / 1000) - 3600;

/** Runs git at the clock's time. `env` can set GIT_COMMITTER_DATE (it wins
 *  over the clock): reflog entries carry the committer's time. */
export function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  const at = `@${second} +0000`;
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, ...IDENTITY, GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at, ...env } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** Moves the clock on a second: reflog times are whole seconds. */
export function nextSecond(): void {
  second += 1;
}

/** A repository on main and a worktree made on a new branch, as Mandate makes one. */
export function repoWithWorktree(branch = "research/x", env: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "md-worktree-branches-"));
  onCleanup(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "wt");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"], env);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"], env);
  git(repo, ["worktree", "add", "-q", "-b", branch, worktree], env);
  return { root, repo, worktree };
}
