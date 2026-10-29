import type { AgentScope } from "../agent/agent-store.js";
import type { SkillScope } from "./skill-frontmatter.js";
import type { SkillRegistry } from "./skill-registry.js";
import { buildSkillReferenceTool } from "./skill-reference-tool.js";
import { buildSkillTool } from "./skill-tool.js";
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
  // Built for managers and workers. Your agent swaps in its own pair, which
  // reads the global scope's skills (agent-scopes).
  const skillScope: SkillScope = input.scope === "worker" ? "worker" : "manager";
  return [toolPack("skills.core", [input.scope], buildSkillTools(input.skillRegistry, skillScope))];
}
