import { z } from "zod";

export const params = z.object({
  name: z.string().min(1),
  workingDir: z.string().min(1)
});
