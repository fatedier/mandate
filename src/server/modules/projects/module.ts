import type { MandateModule } from "../module.js";
import { buildProjectToolPacks } from "./project-tool-packs.js";
import { mountProjectsRoutes } from "./project-routes.js";
import { initializeProjectsSchema } from "./schema.js";
import { noteWorkingDirChanged } from "./working-dir-notes.js";

export const projectsModule: MandateModule = {
  id: "projects",
  schema: [initializeProjectsSchema],
  mountRoutes: (app, { deps }) =>
    mountProjectsRoutes(app, {
      projects: deps.projects,
      workers: deps.workers,
      tmuxClient: deps.tmuxClient,
      gitClient: deps.gitClient,
      broadcast: deps.broadcast,
      sessionDataDir: deps.sessionDataDir,
      onWorkingDirChanged: (change) => noteWorkingDirChanged({
        agentStore: deps.agentStore,
        workers: deps.workers,
        sse: deps.sse,
        isThreadBusy: (threadId) => Boolean(deps.wakeScheduler.isThreadBusy?.(threadId) || deps.wakeScheduler.getRunningWakeForThread?.(threadId))
      }, change)
    }),
  managerToolPacks: (ctx) => buildProjectToolPacks({
    projectsStore: ctx.projectsStore,
    workersStore: ctx.workersStore,
    tmuxClient: ctx.tmuxClient,
    gitClient: ctx.gitClient,
    sessionDataDir: ctx.sessionDataDir,
    publishLifecycle: ctx.publishLifecycle
  })
};
