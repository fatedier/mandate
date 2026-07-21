import type { MandateModule } from "../module.js";
import { mountAgentModuleRoutes } from "./agent-routes.js";
import { buildManagerScopePack } from "./manager-scope-pack.js";
import { initializeAgentHistorySchema } from "./history-schema.js";
import { agentMigrations } from "./migrations.js";
import { initializeAgentSchema } from "./schema.js";
import {
  buildAlarmToolPacks,
  buildSweepToolPacks,
  buildFeatureDigestToolPacks,
  buildFeatureTaskToolPacks,
  buildFeatureWorkItemToolPacks,
  buildFileToolPacks,
  buildWatchToolPacks
} from "./tool-packs.js";
import { buildChatHistoryTools } from "./tools/chat-history.js";
import { buildWorkItemTools } from "./tools/work-item-tools.js";
import { toolPack } from "../../runtime/tool-packs.js";

export const agentModule: MandateModule = {
  id: "agents",
  schema: [initializeAgentSchema, initializeAgentHistorySchema],
  migrations: agentMigrations,
  mountRoutes: (app, { deps }) => mountAgentModuleRoutes(app, deps),
  commonToolPacks: (ctx) => [
    ...buildFileToolPacks(ctx.scope, {
      supportsInputForScope: ctx.supportsInputForScope,
      supportsInputForThread: ctx.supportsInputForThread,
      supportsToolResultImagesForThread: ctx.supportsToolResultImagesForThread
    }),
    ...buildWatchToolPacks({
      scope: ctx.scope,
      watchManager: ctx.watchManager,
      projectsStore: ctx.projectsStore,
      featuresStore: ctx.featuresStore
    }),
    ...(ctx.alarmManager
      ? buildAlarmToolPacks({ scope: ctx.scope, alarmManager: ctx.alarmManager })
      : []),
    ...buildSweepToolPacks({ scope: ctx.scope, sweepController: ctx.sweepController }),
    ...(ctx.agentStore && ctx.featuresStore && ctx.sse && ctx.getWakeScheduler
      ? buildFeatureTaskToolPacks({
          scope: ctx.scope,
          agentStore: ctx.agentStore,
          projectsStore: ctx.projectsStore,
          featuresStore: ctx.featuresStore,
          workStore: ctx.workStore,
          sse: ctx.sse,
          getWakeScheduler: ctx.getWakeScheduler,
          userMessageQueue: ctx.userMessageQueue,
          markPendingTaskWake: ctx.markPendingTaskWake,
          markPendingMailboxWake: ctx.markPendingMailboxWake
        })
      : []),
    ...(ctx.agentStore
      ? buildFeatureDigestToolPacks({
          scope: ctx.scope,
          agentStore: ctx.agentStore
        })
      : []),
    ...(ctx.agentStore && ctx.workStore && ctx.sse
      ? buildFeatureWorkItemToolPacks({
          scope: ctx.scope,
          agentStore: ctx.agentStore,
          workStore: ctx.workStore,
          sse: ctx.sse
        })
      : []),
    ...(ctx.store
      ? [toolPack("agent.chat-history", [ctx.scope], buildChatHistoryTools({ db: ctx.store.db, scope: ctx.scope }))]
      : [])
  ],
  managerToolPacks: (ctx) => [
    toolPack("agent.work-items", ["manager"], buildWorkItemTools({ workStore: ctx.workStore, sse: ctx.sse }))
  ],
  scopePacks: (ctx) => [buildManagerScopePack(ctx.manager)]
};
