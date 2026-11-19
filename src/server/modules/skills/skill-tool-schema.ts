import { z } from "zod";
import { AVAILABLE_SKILLS_TAG } from "./skill-shared.js";

export const params = z.object({
  name: z.string().describe(`The skill name from the ${AVAILABLE_SKILLS_TAG} list.`)
});
