import type { MandateModule } from "../module.js";
import { mountWorkersRoutes } from "./worker-routes.js";
import { buildWorkerScopePack } from "./worker-scope-pack.js";
import { buildWorkerCatalogToolPacks, buildWorkerLifecycleToolPacks } from "./worker-tool-packs.js";
import { initializeWorkersSchema } from "./schema.js";

export const workersModule: MandateModule = {
  id: "workers",
  schema: [initializeWorkersSchema],
  mountRoutes: (app, { deps }) =>
    mountWorkersRoutes(app, {
      projects: deps.projects,
      workers: deps.workers,
      tmuxClient: deps.tmuxClient,
      gitClient: deps.gitClient,
      tmuxRuntime: deps.tmuxRuntime,
      agentStore: deps.agentStore,
      broadcast: deps.broadcast,
      beforeWorkerArchive: deps.beforeWorkerArchive,
      refreshWindows: (windowIds) => {
        void deps.pollTmux({ forceWindowIds: windowIds });
      },
      refreshTmux: () => {
        void deps.pollTmux({});
      }
    }),
  managerToolPacks: (ctx) => [
    ...buildWorkerCatalogToolPacks({
      agentStore: ctx.agentStore,
      projectsStore: ctx.projectsStore,
      workersStore: ctx.workersStore,
      getSnapshot: ctx.getSnapshot,
      ...(ctx.taskList ? { tasksOfThread: (threadId: string) => ctx.taskList!.list(threadId) } : {})
    }),
    ...buildWorkerLifecycleToolPacks({
      agentStore: ctx.agentStore,
      projectsStore: ctx.projectsStore,
      workersStore: ctx.workersStore,
      tmuxClient: ctx.tmuxClient,
      gitClient: ctx.gitClient,
      tmuxRuntime: ctx.tmuxRuntime,
      publishLifecycle: ctx.publishLifecycle,
      memory: ctx.memory,
      beforeWorkerArchive: ctx.beforeWorkerArchive
    })
  ],
  scopePacks: (ctx) => [buildWorkerScopePack(ctx.worker)]
};
