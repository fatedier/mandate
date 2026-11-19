import { z } from "zod";

export const params = z.object({
  workerId: z.string().min(1),
  removeWorktree: z.boolean().optional(),
  forceRemoveWorktree: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
  forceDeleteBranch: z.boolean().optional(),
  confirmedByUser: z.boolean().optional().describe(
    "Set only after the user said, in this thread, to archive despite the findings the previous call returned."
  )
});
