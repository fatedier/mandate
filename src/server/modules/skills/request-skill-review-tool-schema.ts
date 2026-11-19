import { z } from "zod";

export const params = z.object({
  thread: z.string().optional().describe("The conversation where the work was done: this one, or a worker or thread you handed the work to. Default: this one."),
  focus: z.string().min(1).describe("What to keep, in one sentence — the user's words when the user asked.")
});
