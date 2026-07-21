import type { AgentScope } from "../modules/agent/agent-store.js";
import type { ToolDefinition, ToolRegistry } from "../modules/agent/tool-registry.js";

export interface ToolPack {
  id: string;
  scopes: readonly AgentScope[];
  tools: readonly ToolDefinition[];
}

export function toolPack(
  id: string,
  scopes: readonly AgentScope[],
  tools: readonly ToolDefinition[]
): ToolPack {
  return { id, scopes, tools };
}

export function optionalToolPack(
  id: string,
  scopes: readonly AgentScope[],
  tools: readonly ToolDefinition[] | null | undefined
): ToolPack[] {
  return tools && tools.length > 0 ? [toolPack(id, scopes, tools)] : [];
}

export function registerToolPacks(
  registry: ToolRegistry,
  scope: AgentScope,
  packs: readonly ToolPack[]
): void {
  for (const pack of packs) {
    if (!pack.scopes.includes(scope)) continue;
    for (const tool of pack.tools) {
      registry.register(tool);
    }
  }
}
