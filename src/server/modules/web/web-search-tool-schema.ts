import { z } from "zod";

export const params = z.object({
  query: z.string().min(1).describe("What to find, written as you would ask a person.")
});
