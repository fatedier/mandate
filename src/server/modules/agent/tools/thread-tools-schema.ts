import { z } from "zod";

export const params = z.object({
  title: z.string().min(1).max(80).describe(
    "2-6 words naming what this thread is about, e.g. \"payments v2 release\". Plain words, no quotes or emoji."
  )
}).strict();
