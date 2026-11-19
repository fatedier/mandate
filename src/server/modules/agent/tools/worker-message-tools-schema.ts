import { z } from "zod";

export const sendParams = z.object({
  workerId: z.string().min(1).describe("The worker's id, from list_workers."),
  message: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe("The message for the worker.")
});
