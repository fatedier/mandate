import type { AgentScope } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { buildUiNavigateTool } from "./tools/ui-navigate.js";
import { buildUiOpenUrlTool } from "./tools/ui-open-url.js";
import { buildUiReadPageSummaryTool } from "./tools/ui-read-page-summary.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { ProjectsStore } from "../projects/projects-store.js";
import { optionalToolPack, toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { TmuxSnapshot } from "../../platform/tmux/tmux-types.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { UiContextRegistry } from "./ui-context-registry.js";

export function buildUiPageSummaryToolPacks(input: {
  scope: AgentScope;
  uiContextRegistry?: UiContextRegistry;
}): ToolPack[] {
  return optionalToolPack(
    "ui.page-summary",
    [input.scope],
    input.uiContextRegistry ? [buildUiReadPageSummaryTool(input.uiContextRegistry)] : null
  );
}

export function buildManagerUiToolPacks(input: {
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  getSnapshot: () => TmuxSnapshot | null;
  tmuxClient: TmuxClient;
  sse: AgentSseEmitter;
}): ToolPack[] {
  return [
    toolPack("ui.manager", ["manager"], [
      buildUiNavigateTool({
        projectsStore: input.projectsStore,
        featuresStore: input.featuresStore,
        getSnapshot: input.getSnapshot,
        tmuxClient: input.tmuxClient,
        emit: (action, payload) => input.sse.emit(SSE_EVENTS.agentUiAction, { action, payload })
      }),
      buildUiOpenUrlTool((action, payload) =>
        input.sse.emit(SSE_EVENTS.agentUiAction, { action, payload }))
    ])
  ];
}
