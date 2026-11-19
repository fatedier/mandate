import { z } from "zod";

export const params = z
  .object({
    cwd: z.string().optional(),
    direction: z.enum(["right", "down"]).optional(),
    targetPaneId: z.string().optional(),
    name: z.string().max(80).optional(),
    description: z.string().max(1000).optional()
  })
  .strict();
