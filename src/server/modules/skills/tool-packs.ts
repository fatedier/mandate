import type { AgentScope } from "../agent/agent-store.js";
import type { SkillScope } from "./skill-frontmatter.js";
import type { SkillRegistry } from "./skill-registry.js";
import { buildSkillReferenceTool } from "./skill-reference-tool.js";
import { buildSkillTool } from "./skill-tool.js";
import { buildManageSkillTool } from "./manage-skill-tool.js";
import { buildRequestSkillReviewTool } from "./request-skill-review-tool.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { ToolDefinition } from "../agent/tool-registry.js";

/** `skill` and `read_skill_reference`, reading the skills of one scope. */
export function buildSkillTools(registry: SkillRegistry, scope: SkillScope): ToolDefinition[] {
  return [buildSkillTool(registry, scope), buildSkillReferenceTool(registry, scope)] as ToolDefinition[];
}

export function buildSkillToolPacks(input: {
  scope: AgentScope;
  skillRegistry: SkillRegistry;
}): ToolPack[] {
  // Built for managers and workers. The personal agent swaps in its own pair, which
  // reads the personal scope's skills (agent-scopes).
  const skillScope: SkillScope = input.scope === "worker" ? "worker" : "manager";
  // Workers follow skills and report a wrong step; their managers change them.
  const tools = skillScope === "worker"
    ? buildSkillTools(input.skillRegistry, skillScope)
    : [...buildSkillTools(input.skillRegistry, skillScope), buildManageSkillTool(input.skillRegistry) as ToolDefinition, buildRequestSkillReviewTool(input.skillRegistry) as ToolDefinition];
  return [toolPack("skills.core", [input.scope], tools)];
}
