import type { AgentScope } from "../agent/agent-store.js";
import type { SkillRegistry } from "./skill-registry.js";
import { buildSkillReferenceTool } from "./skill-reference-tool.js";
import { buildSkillTool } from "./skill-tool.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";

export function buildSkillToolPacks(input: {
  scope: AgentScope;
  skillRegistry: SkillRegistry;
}): ToolPack[] {
  return [
    toolPack("skills.core", [input.scope], [
      buildSkillTool(input.skillRegistry, input.scope),
      buildSkillReferenceTool(input.skillRegistry, input.scope)
    ])
  ];
}
