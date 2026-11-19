import { z } from "zod";

export const params = z.object({
  path: z.string(),
  content: z.string()
});
