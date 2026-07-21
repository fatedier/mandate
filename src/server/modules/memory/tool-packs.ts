import type { AgentScope } from "../agent/agent-store.js";
import { buildMemoryTools } from "./tools/memory.js";
import type { MemoryManager } from "./manager.js";
import { optionalToolPack, type ToolPack } from "../../runtime/tool-packs.js";

export function buildMemoryToolPacks(input: {
  scope: AgentScope;
  memory?: MemoryManager | null;
}): ToolPack[] {
  return optionalToolPack(
    "memory.core",
    [input.scope],
    input.memory ? buildMemoryTools(input.memory, input.scope) : null
  );
}
