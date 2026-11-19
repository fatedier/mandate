import { z } from "zod";

export const params = z.object({
  paneId: z.string()
});
