import type { Hono } from "hono";
import { mountAgentsRoutes } from "./agents-api.js";
import { modelSupportsInput } from "../../config.js";
import type { AppDeps } from "../../app/deps.js";
import { registerWorkItemsRoutes } from "./work-items-routes.js";

export function mountAgentModuleRoutes(app: Hono, deps: AppDeps): void {
  mountAgentsRoutes(app, {
    agentStore: deps.agentStore,
    wakeScheduler: deps.wakeScheduler,
    beforeNewChatArchive: deps.beforeAgentNewChatArchive,
    beforeSideThreadClose: deps.beforeAgentSideThreadClose,
    summarizeSideConversation: deps.summarizeAgentSideConversation,
    userMessageQueue: deps.userMessageQueue,
    sse: deps.sse,
    scopes: deps.scopes,
    contextBudgetTokens: deps.config.agent.compressionThresholdTokens,
    uiContextRegistry: deps.uiContextRegistry,
    workStore: deps.workStore,
    modelSupportsInput: (scope, input) =>
      modelSupportsInput(
        deps.config,
        scope === "manager"
          ? deps.config.agent.manager.modelRef
          : deps.config.agent.worker.modelRef,
        input
      )
  });

  registerWorkItemsRoutes(app, {
    agentStore: deps.agentStore,
    workStore: deps.workStore,
    sse: deps.sse,
    wake: (threadId, reason) =>
      deps.wakeScheduler.wake(threadId, reason, null)
  });
}
