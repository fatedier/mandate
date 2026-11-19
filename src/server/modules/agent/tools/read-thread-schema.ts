import { z } from "zod";

export const readParams = z.object({
  threadId: z.string().min(1),
  limit: z.number().int().positive().max(50).optional()
});
