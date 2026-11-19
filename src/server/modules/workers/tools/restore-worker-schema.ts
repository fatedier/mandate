import { z } from "zod";

export const params = z.object({
  workerId: z.string().min(1),
  mode: z.enum([
    "new-branch-new-worktree",
    "existing-branch-new-worktree",
    "shared-cwd",
    "existing-branch-existing-worktree"
  ]).optional(),
  branch: z.string().min(1).optional(),
  baseRef: z.string().min(1).optional(),
  worktreePath: z.string().min(1).optional(),
  tmuxWindowName: z.string().min(1).optional()
});
