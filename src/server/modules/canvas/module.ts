import type { MandateModule } from "../module.js";
import { initializeCanvasSchema } from "./schema.js";
import { canvasMigrations } from "./migrations.js";
import { mountCanvasRoutes } from "./canvas-routes.js";
import { buildCanvasToolPacks } from "./tool-packs.js";

export const canvasModule: MandateModule = {
  id: "canvas",
  schema: [initializeCanvasSchema],
  migrations: canvasMigrations,
  mountRoutes: (app, { deps }) => mountCanvasRoutes(app, deps),
  commonToolPacks: (ctx) => buildCanvasToolPacks({
    scope: ctx.scope,
    agentStore: ctx.agentStore,
    canvasStore: ctx.canvasStore,
    sse: ctx.sse,
    workStore: ctx.workStore
  })
};
