import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import leadPromptPath from "./prompts/learned-skills-lead.md" with { type: "file" };
import workerPromptPath from "./prompts/learned-skills-worker.md" with { type: "file" };
import type { SkillScope } from "./skill-frontmatter.js";

/**
 * An agent's skills section with what it is told about learned skills after
 * the list. The personal agent and managers always read theirs (it says when
 * to ask for a review, which is how the first skill comes); a worker reads
 * its line only when it has skills to follow.
 */
export function withLearnedSkillGuidance(scope: SkillScope, manifest: string): string {
  const list = manifest.trim();
  if (scope === "worker") return list ? `${list}\n\n${renderPromptFile(workerPromptPath).trim()}` : "";
  const lead = renderPromptFile(leadPromptPath).trim();
  return list ? `${list}\n\n${lead}` : lead;
}
