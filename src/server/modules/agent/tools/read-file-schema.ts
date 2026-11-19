import { z } from "zod";

export const MAX_LINES = 2000;

export const params = z.object({
  path: z.string(),
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(MAX_LINES).optional()
});
