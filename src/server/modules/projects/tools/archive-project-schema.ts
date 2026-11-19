import { z } from "zod";

export const params = z.object({
  projectId: z.string().min(1),
  killTmux: z.boolean().optional()
});
