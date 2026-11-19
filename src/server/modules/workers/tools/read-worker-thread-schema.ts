import { z } from "zod";

export const params = z.object({
  workerId: z.string().min(1),
  limit: z.number().int().positive().max(50).optional()
});
