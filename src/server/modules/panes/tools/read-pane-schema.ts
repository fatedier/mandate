import { z } from "zod";

export const params = z.object({
  paneId: z.string(),
  lines: z.number().int().positive().max(2000).optional()
});
