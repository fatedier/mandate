import type { MandateModule } from "../module.js";
import { buildProjectToolPacks } from "./project-tool-packs.js";
import { mountProjectsRoutes } from "./project-routes.js";
import { initializeProjectsSchema } from "./schema.js";
import { projectsMigrations } from "./migrations.js";

export const projectsModule: MandateModule = {
  id: "projects",
  schema: [initializeProjectsSchema],
  migrations: projectsMigrations,
  mountRoutes: (app, { deps }) =>
    mountProjectsRoutes(app, {
      projects: deps.projects,
      features: deps.features,
      tmuxClient: deps.tmuxClient,
      gitClient: deps.gitClient,
      broadcast: deps.broadcast,
      sessionDataDir: deps.sessionDataDir
    }),
  managerToolPacks: (ctx) => buildProjectToolPacks({
    projectsStore: ctx.projectsStore,
    featuresStore: ctx.featuresStore,
    tmuxClient: ctx.tmuxClient,
    gitClient: ctx.gitClient,
    sessionDataDir: ctx.sessionDataDir,
    publishLifecycle: ctx.publishLifecycle
  })
};
