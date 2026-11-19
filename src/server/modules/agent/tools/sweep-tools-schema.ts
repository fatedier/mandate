import { z } from "zod";

export const endSweepParams = z.object({
  reason: z.string().min(1).max(300).describe(
    "One line on why nothing is outstanding — recorded so a later reader knows what you concluded."
  )
});
