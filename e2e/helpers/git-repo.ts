import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onCleanup } from "../../tests/helpers/cleanup.js";

// Real git repositories for tests that ask what git itself recorded.

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };

/** `env` can set GIT_COMMITTER_DATE: reflog entries carry the committer's time. */
export function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...process.env, ...IDENTITY, ...env } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** Waits into the next second: reflog times are whole seconds. */
export async function nextSecond(): Promise<void> {
  const now = Date.now();
  await Bun.sleep(1000 - (now % 1000) + 20);
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
