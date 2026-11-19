import type { MandateModule } from "../module.js";
import { mountAgentModuleRoutes } from "./agent-routes.js";
import { buildManagerScopePack } from "./manager-scope-pack.js";
import { initializeAgentHistorySchema } from "./history-schema.js";
import { initializeAgentSchema } from "./schema.js";
import {
  buildAlarmToolPacks,
  buildSweepToolPacks,
  buildWorkerDispatchToolPacks,
  buildFileToolPacks,
  buildMonitorToolPacks,
  buildSubagentToolPacks
} from "./tool-packs.js";
import { buildChatHistoryTools } from "./tools/chat-history.js";
import { buildWorkItemTools } from "./tools/work-item-tools.js";
import { toolPack } from "../../runtime/tool-packs.js";
import { buildNameThreadTool } from "./tools/thread-tools.js";
import { buildReadThreadTool } from "./tools/read-thread.js";
import { ManagerThreadService } from "./manager-threads.js";
import { scopePack } from "../../runtime/scope-packs.js";
import { buildSubagentScope } from "../../runtime/scopes/subagent-scope.js";

export const agentModule: MandateModule = {
  id: "agents",
  schema: [initializeAgentSchema, initializeAgentHistorySchema],
  mountRoutes: (app, { deps }) => mountAgentModuleRoutes(app, deps),
  commonToolPacks: (ctx) => [
    ...buildFileToolPacks(ctx.scope, {
      supportsInputForScope: ctx.supportsInputForScope,
      supportsInputForThread: ctx.supportsInputForThread,
      supportsToolResultImagesForThread: ctx.supportsToolResultImagesForThread,
      ...(ctx.shellRunner ? { shellRunner: ctx.shellRunner } : {}),
      ...(ctx.commands ? { commands: ctx.commands } : {})
    }),
    ...buildMonitorToolPacks({
      scope: ctx.scope,
      paneMonitorManager: ctx.paneMonitorManager,
      commandMonitorManager: ctx.commandMonitorManager,
      projectsStore: ctx.projectsStore,
      workersStore: ctx.workersStore
    }),
    ...(ctx.alarmManager
      ? buildAlarmToolPacks({ scope: ctx.scope, alarmManager: ctx.alarmManager })
      : []),
    ...buildSweepToolPacks({ scope: ctx.scope, sweepController: ctx.sweepController }),
    ...(ctx.agentStore && ctx.workersStore && ctx.getWakeScheduler
      ? buildWorkerDispatchToolPacks({
          scope: ctx.scope,
          agentStore: ctx.agentStore,
          workersStore: ctx.workersStore,
          getWakeScheduler: ctx.getWakeScheduler
        })
      : []),
    ...(ctx.store
      ? [toolPack("agent.chat-history", [ctx.scope], buildChatHistoryTools({ db: ctx.store.db, scope: ctx.scope }))]
      : []),
    ...(ctx.agentStore && ctx.subagents
      ? buildSubagentToolPacks({
          scope: ctx.scope, agentStore: ctx.agentStore, subagents: ctx.subagents,
          ...(ctx.commands ? { commands: ctx.commands } : {}),
          ...(ctx.taskList ? { taskList: ctx.taskList } : {})
        })
      : [])
  ],
  managerToolPacks: (ctx) => [
    toolPack("agent.work-items", ["manager"], buildWorkItemTools({
      workStore: ctx.workStore, sse: ctx.sse, workersStore: ctx.workersStore, agentStore: ctx.agentStore, planStore: ctx.planStore
    })),
    toolPack("agent.threads", ["manager"], [
      buildNameThreadTool(new ManagerThreadService({
        agentStore: ctx.agentStore, sse: ctx.sse,
        ...(ctx.dutySummary ? { dutySummary: ctx.dutySummary } : {}),
        ...(ctx.threadProjects ? { projects: ctx.threadProjects } : {})
      })),
      // Another thread, given as background: read as the personal agent reads one.
      buildReadThreadTool({ agentStore: ctx.agentStore })
    ])
  ],
  // A subagent's scope sits with the agent module's: it is no worker's and
  // no personal agent's.
  scopePacks: (ctx) => [buildManagerScopePack(ctx.manager), scopePack("subagent", () => buildSubagentScope(ctx.subagent))]
};
