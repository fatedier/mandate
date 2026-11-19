import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { gitWorktreeAdd, gitWorktreeRemove } from "../src/server/platform/git/git.js";
import { tempDir } from "../tests/helpers/temp.js";
import { tempGitRepo as tempRepo } from "./helpers/fixtures.js";
import { git } from "./helpers/git-repo.js";

// With no repository named, as here (production names the project's), the
// remove goes through its fallbacks: only this runs them against a real git.
test("gitWorktreeRemove: removes worktree directory and git record", async () => {
  const { dir, cleanup } = tempRepo();
  const wtPath = tempDir("md-wt-");
  try {
    fs.rmSync(wtPath, { recursive: true, force: true });
    await gitWorktreeAdd(dir, wtPath, "worker-z", { newBranch: true });
    expect(fs.existsSync(wtPath)).toBeTruthy();
    expect(git(dir, ["worktree", "list", "--porcelain"])).toContain(wtPath);
    await gitWorktreeRemove(wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
    // git's own record of it is gone too, not only the folder.
    expect(git(dir, ["worktree", "list", "--porcelain"])).not.toContain(wtPath);
  } finally {
    cleanup();
  }
});
