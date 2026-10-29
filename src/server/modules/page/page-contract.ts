import * as fs from "node:fs";
import skillPath from "../skills/builtins/agent-page/SKILL.md" with { type: "file" };
import { parseSkillFrontmatter } from "../skills/skill-frontmatter.js";

let cached: string | null = null;

/** The page's rules: the agent-page skill's body, without its frontmatter.
 *  Your agent reads it as that skill; a page subagent is given it in its
 *  prompt. */
export function pageContract(): string {
  if (cached === null) {
    const parsed = parseSkillFrontmatter(fs.readFileSync(skillPath, "utf8"));
    if (!parsed.ok) throw new Error(`the agent-page skill does not parse: ${parsed.error}`);
    cached = parsed.value.body.trim();
  }
  return cached;
}
