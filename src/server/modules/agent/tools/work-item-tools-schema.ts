import { z } from "zod";

export const dismissParams = z.object({
  id: z.string(),
  reason: z.string().optional()
});
