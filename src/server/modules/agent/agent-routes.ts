import { displayPersonalAgentName } from "../../../shared/personal-agent-name.js";
import type { Hono } from "hono";
import { ThreadDeletion } from "./thread-delete.js";
import { MessageDeletion } from "./message-delete.js";
import { mountAgentsRoutes } from "./agents-api.js";
import { mountMessageImageRoutes } from "./message-images.js";
import { ReplyTabStore, mountReplyTabRoutes } from "./reply-tabs.js";
import { modelSupportsInput } from "../../config.js";
import type { AppDeps } from "../../app/deps.js";
import { registerWorkItemsRoutes } from "./work-items-routes.js";
import { PlanStore } from "../plans/plan-store.js";
import { threadWorkerRefs } from "./manager-threads.js";
import type { Config } from "../../config.js";
import type { ConversationScope } from "../../../shared/api/agents.js";

/** The model a thread's input is checked against: its route's first model
 *  (a side chat's is the personal agent's). */
export function modelRefForScope(config: Config, scope: ConversationScope | "side_chat"): string {
  return config.agent[scope === "side_chat" ? "personal" : scope].modelRef;
}

export function mountAgentModuleRoutes(app: Hono, deps: AppDeps): void {
  const planStore = new PlanStore(deps.store.db);
  mountMessageImageRoutes(app, { agentStore: deps.agentStore });
  mountReplyTabRoutes(app, { store: new ReplyTabStore(deps.store.db), agentStore: deps.agentStore, sse: deps.sse });
  mountAgentsRoutes(app, {
    agentStore: deps.agentStore,
    canvases: deps.canvasStore,
    ...(deps.taskBoard ? { taskBoard: deps.taskBoard } : {}),
    agentName: () => displayPersonalAgentName(deps.config.agent.personalAgentName),
    wakeScheduler: deps.wakeScheduler,
    compaction: deps.compaction,
    userMessageQueue: deps.userMessageQueue,
    sse: deps.sse,
    scopes: deps.scopes,
    // Read at each request: saving the settings replaces the config in place.
    contextBudgetTokens: () => deps.config.agent.compressionThresholdTokens,
    managerThreads: deps.managerThreads,
    threadArchive: deps.threadArchive,
    backgroundTasks: deps.backgroundTasks,
    ...(deps.dutyReportsFor ? { dutyReportsFor: deps.dutyReportsFor } : {}),
    threadDeletion: new ThreadDeletion({
      db: deps.store.db, agentStore: deps.agentStore, canvases: deps.canvasStore, isBusy: deps.isThreadWorking, sse: deps.sse,
      ...(deps.threadProjects ? { projects: deps.threadProjects } : {}),
      ...(deps.schedules ? { onDelete: (threadId: string) => deps.schedules!.threadDeleting(threadId) } : {})
    }),
    messageDeletion: new MessageDeletion({
      db: deps.store.db, agentStore: deps.agentStore, sse: deps.sse,
      // A manager thread's own summary (its latest activity, its title while unnamed) is sent again.
      onDeleted: (threadId) => { deps.managerThreads?.publish(threadId); }
    }),
    ...(deps.threadLabels ? { threadLabels: deps.threadLabels } : {}),
    pendingMonitors: deps.pendingMonitors,
    allPendingMonitors: deps.allPendingMonitors,
    ...(deps.threadModels ? { threadModels: deps.threadModels } : {}),
    ...(deps.supportsInputForThread ? { supportsInputForThread: deps.supportsInputForThread } : {}),
    listThreadWorkers: (threadId, archived) =>
      threadWorkerRefs({ workers: deps.workers, projects: deps.projects, agentStore: deps.agentStore }, threadId, archived),
    // A subagent's thread takes no message from a person: no route posts to one.
    modelSupportsInput: (scope, input) => scope !== "subagent" && modelSupportsInput(deps.config, modelRefForScope(deps.config, scope), input)
  });

  registerWorkItemsRoutes(app, { workStore: deps.workStore, sse: deps.sse, planStore });
}
