import { z } from "zod";

export const params = z.object({
  paneId: z.string().min(1),
  name: z.string().max(80).optional(),
  description: z.string().max(1000).optional()
}).strict();
