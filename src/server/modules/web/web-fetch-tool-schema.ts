import { z } from "zod";

export const params = z.object({
  url: z.string().describe("The page to read."),
  offset: z.number().int().min(0).optional()
    .describe("Where in the page's text to start, in characters (default 0). Pass the offset the previous call gave to read on.")
});
