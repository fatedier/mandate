import { z } from "zod";

export const params = z.object({
  skill: z.string().describe("The skill name (must appear in the available-skills list)."),
  path: z.string().describe("Reference file path relative to the skill's references/ directory (e.g. 'advanced.md').")
});
