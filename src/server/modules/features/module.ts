import type { MandateModule } from "../module.js";
import { mountFeaturesRoutes } from "./feature-routes.js";
import { buildWorkerScopePack } from "./worker-scope-pack.js";
import { buildFeatureCatalogToolPacks, buildFeatureLifecycleToolPacks } from "./feature-tool-packs.js";
import { initializeFeaturesSchema } from "./schema.js";

export const featuresModule: MandateModule = {
  id: "features",
  schema: [initializeFeaturesSchema],
  mountRoutes: (app, { deps }) =>
    mountFeaturesRoutes(app, {
      projects: deps.projects,
      features: deps.features,
      tmuxClient: deps.tmuxClient,
      gitClient: deps.gitClient,
      paneRuntimes: deps.paneRuntimes,
      paneMetadata: deps.paneMetadata,
      agentStore: deps.agentStore,
      workItems: deps.workStore,
      sse: deps.sse,
      broadcast: deps.broadcast,
      beforeFeatureArchive: deps.beforeFeatureArchive,
      refreshWindows: (windowIds) => {
        void deps.pollTmux({ forceWindowIds: windowIds });
      },
      refreshTmux: () => {
        void deps.pollTmux({});
      }
    }),
  managerToolPacks: (ctx) => [
    ...buildFeatureCatalogToolPacks({
      agentStore: ctx.agentStore,
      projectsStore: ctx.projectsStore,
      featuresStore: ctx.featuresStore,
      getSnapshot: ctx.getSnapshot
    }),
    ...buildFeatureLifecycleToolPacks({
      agentStore: ctx.agentStore,
      projectsStore: ctx.projectsStore,
      featuresStore: ctx.featuresStore,
      tmuxClient: ctx.tmuxClient,
      gitClient: ctx.gitClient,
      paneRuntimes: ctx.paneRuntimes,
      publishLifecycle: ctx.publishLifecycle,
      beforeFeatureArchive: ctx.beforeFeatureArchive
    })
  ],
  scopePacks: (ctx) => [buildWorkerScopePack(ctx.worker)]
};
