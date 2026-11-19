import { z } from "zod";
import type { ToolDefinition } from "../agent/tool-registry.js";
import type { SkillRegistry } from "./skill-registry.js";
import type { SkillScope } from "./skill-frontmatter.js";
import { AVAILABLE_SKILLS_TAG, SKILL_TOOL_NAME } from "./skill-shared.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import skillReminderPromptPath from "./prompts/system-reminder.md" with { type: "file" };
import { params } from "./skill-tool-schema.js";

type SkillResult = string | { error: string };

/**
 * Wrap the body in a system-reminder tag so the model recognises it as
 * authoritative instructions for the current task.
 */
function wrapAsSystemReminder(name: string, body: string): string {
  return renderPromptFile(skillReminderPromptPath, {
    skillName: name,
    skillBody: body.trim()
  }).trimEnd();
}

export function buildSkillTool(
  registry: SkillRegistry,
  scope: SkillScope
): ToolDefinition<z.infer<typeof params>, SkillResult> {
  return {
    name: SKILL_TOOL_NAME,
    description: `Load the full body of a named skill from the ${AVAILABLE_SKILLS_TAG} list. The returned text is wrapped in a <system-reminder> tag and should be treated as authoritative instructions for the current task.`,
    parameters: params,
    handler: async ({ name }, ctx) => {
      const body = await registry.loadBody(name, scope);
      if (body !== null) return wrapAsSystemReminder(name, body);
      const learned = registry.loadLearned(name, scope, { threadId: ctx.threadId, projectId: ctx.project?.id ?? ctx.worker?.projectId ?? null });
      if (learned?.kind === "loaded") return wrapAsSystemReminder(name, learned.text);
      if (learned?.kind === "archived") return { error: learned.text };
      return { error: `Unknown skill: ${name}` };
    }
  };
}
