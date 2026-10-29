import { expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  gitCurrentBranch,
  gitResolveDefaultBaseRef,
  gitWorktreeAdd,
  gitWorktreeRemove
} from "../src/server/platform/git/git.js";
import { tempDir } from "../tests/helpers/temp.js";
import { tempGitRepo as tempRepo } from "./helpers/fixtures.js";

test("gitResolveDefaultBaseRef: prefers the current branch", () => {
  const { dir, cleanup } = tempRepo();
  try {
    expect(gitCurrentBranch(dir)).toBe("main");
    expect(gitResolveDefaultBaseRef(dir)).toBe("main");
  } finally { cleanup(); }
});

test("gitWorktreeRemove: removes worktree directory and git record", () => {
  const { dir, cleanup } = tempRepo();
  const wtPath = tempDir("md-wt-");
  try {
    fs.rmSync(wtPath, { recursive: true, force: true });
    gitWorktreeAdd(dir, wtPath, "feature-z", { newBranch: true });
    expect(fs.existsSync(wtPath)).toBeTruthy();
    gitWorktreeRemove(wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
  } finally {
    cleanup();
  }
});
