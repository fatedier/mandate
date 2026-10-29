import type { AgentScope, AgentStore } from "../agent/agent-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { buildMemoryTools } from "./tools/memory.js";
import type { MemoryManager } from "./manager.js";
import type { FeatureRecordStore } from "../plans/record-store.js";
import { optionalToolPack, type ToolPack } from "../../runtime/tool-packs.js";

export function buildMemoryToolPacks(input: {
  scope: AgentScope;
  memory?: MemoryManager | null;
  agentStore?: AgentStore;
  projectsStore?: ProjectsStore;
  records?: FeatureRecordStore | null;
}): ToolPack[] {
  const ready = input.memory && input.agentStore && input.projectsStore && input.records;
  return optionalToolPack(
    "memory.core",
    [input.scope],
    ready
      ? buildMemoryTools({ memory: input.memory!, records: input.records!, scope: input.scope, agentStore: input.agentStore!, projectsStore: input.projectsStore! })
      : null
  );
}
