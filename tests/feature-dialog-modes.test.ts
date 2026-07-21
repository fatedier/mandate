import { expect, test } from "bun:test";
import { fieldsForMode } from "../src/client/routes/projects/feature-mode-fields.js";

test("fieldsForMode shared-cwd: no branch, no worktreePath", () => {
  const f = fieldsForMode("shared-cwd");
  expect(f.showBranch).toBe(false);
  expect(f.showBaseRef).toBe(false);
  expect(f.showWorktreePath).toBe(false);
  expect(f.branchSource).toBe("none");
});

test("fieldsForMode new-branch-new-worktree: branch as free text, no path", () => {
  const f = fieldsForMode("new-branch-new-worktree");
  expect(f.showBranch).toBe(true);
  expect(f.showBaseRef).toBe(true);
  expect(f.showWorktreePath).toBe(false);
  expect(f.branchSource).toBe("new");
});

test("fieldsForMode existing-branch-new-worktree: branch from autocomplete, no path", () => {
  const f = fieldsForMode("existing-branch-new-worktree");
  expect(f.showBranch).toBe(true);
  expect(f.showBaseRef).toBe(false);
  expect(f.showWorktreePath).toBe(false);
  expect(f.branchSource).toBe("existing");
});

test("fieldsForMode existing-branch-existing-worktree: branch + worktreePath", () => {
  const f = fieldsForMode("existing-branch-existing-worktree");
  expect(f.showBranch).toBe(true);
  expect(f.showBaseRef).toBe(false);
  expect(f.showWorktreePath).toBe(true);
  expect(f.branchSource).toBe("existing");
});
