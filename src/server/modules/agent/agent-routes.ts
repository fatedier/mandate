import type { Hono } from "hono";
import { ThreadDeletion } from "./thread-delete.js";
import { mountAgentsRoutes } from "./agents-api.js";
import { mountMessageImageRoutes } from "./message-images.js";
import { modelSupportsInput } from "../../config.js";
import type { AppDeps } from "../../app/deps.js";
import { registerWorkItemsRoutes } from "./work-items-routes.js";
import { PlanStore } from "../plans/plan-store.js";
import { threadWorkerRefs } from "./manager-threads.js";
import type { Config } from "../../config.js";
import type { ConversationScope } from "../../../shared/api/agents.js";

/** The model a thread's input is checked against: its route's first model. */
export function modelRefForScope(config: Config, scope: ConversationScope): string {
  return config.agent[scope].modelRef;
}

export function mountAgentModuleRoutes(app: Hono, deps: AppDeps): void {
  const planStore = new PlanStore(deps.store.db);
  mountMessageImageRoutes(app, { agentStore: deps.agentStore });
  mountAgentsRoutes(app, {
    agentStore: deps.agentStore,
    wakeScheduler: deps.wakeScheduler,
    compaction: deps.compaction,
    userMessageQueue: deps.userMessageQueue,
    sse: deps.sse,
    scopes: deps.scopes,
    contextBudgetTokens: deps.config.agent.compressionThresholdTokens,
    managerThreads: deps.managerThreads,
    threadArchive: deps.threadArchive,
    backgroundTasks: deps.backgroundTasks,
    threadDeletion: new ThreadDeletion({
      db: deps.store.db, agentStore: deps.agentStore, canvases: deps.canvasStore, isBusy: deps.isThreadWorking, sse: deps.sse
    }),
    pendingMonitors: deps.pendingMonitors,
    allPendingMonitors: deps.allPendingMonitors,
    ...(deps.threadModels ? { threadModels: deps.threadModels } : {}),
    ...(deps.supportsInputForThread ? { supportsInputForThread: deps.supportsInputForThread } : {}),
    listThreadWorkers: (threadId, archived) =>
      threadWorkerRefs({ features: deps.features, projects: deps.projects, agentStore: deps.agentStore }, threadId, archived),
    // A subagent's thread takes no message from a person: no route posts to one.
    modelSupportsInput: (scope, input) => scope !== "subagent" && modelSupportsInput(deps.config, modelRefForScope(deps.config, scope), input)
  });

  registerWorkItemsRoutes(app, { workStore: deps.workStore, sse: deps.sse, planStore });
}
