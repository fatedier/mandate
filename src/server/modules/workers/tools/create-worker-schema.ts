import { z } from "zod";

export const params = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).describe(
    "User-facing name, written the way a person would write it — a short phrase, "
    + "normal capitalisation and spaces. It is what the sidebar and the project "
    + "cards show, and it is the only place a human reads this worker's identity. "
    + "Do NOT slugify it: 'Continue the checkout retry refactor', not "
    + "'continue-checkout-retry-refactor'. The machine-readable form is "
    + "derived from this automatically for the tmux window; the git branch is a "
    + "separate parameter. Neither one needs you to pre-flatten the name."
  ),
  mode: z.enum([
    "new-branch-new-worktree",
    "existing-branch-new-worktree",
    "shared-cwd",
    "existing-branch-existing-worktree"
  ]),
  branch: z.string().optional(),
  baseRef: z.string().optional(),
  worktreePath: z.string().optional()
});
