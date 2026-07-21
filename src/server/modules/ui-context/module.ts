import { mountUiContextRoutes } from "./ui-context-routes.js";
import type { MandateModule } from "../module.js";
import { buildManagerUiToolPacks, buildUiPageSummaryToolPacks } from "./tool-packs.js";

export const uiContextModule: MandateModule = {
  id: "ui-context",
  mountRoutes: (app, { deps }) =>
    mountUiContextRoutes(app, { uiContextRegistry: deps.uiContextRegistry }),
  commonToolPacks: (ctx) => buildUiPageSummaryToolPacks({
    scope: ctx.scope,
    uiContextRegistry: ctx.uiContextRegistry
  }),
  managerToolPacks: (ctx) => buildManagerUiToolPacks({
    projectsStore: ctx.projectsStore,
    featuresStore: ctx.featuresStore,
    getSnapshot: ctx.getSnapshot,
    tmuxClient: ctx.tmuxClient,
    sse: ctx.sse
  })
};
