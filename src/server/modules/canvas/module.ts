import type { MandateModule } from "../module.js";
import { initializeCanvasSchema } from "./schema.js";
import { mountCanvasRoutes } from "./canvas-routes.js";
import { buildCanvasToolPacks } from "./tool-packs.js";
import { canvasPageContract } from "./canvas-contract.js";

export const canvasModule: MandateModule = {
  id: "canvas",
  schema: [initializeCanvasSchema],
  mountRoutes: (app, { deps }) => mountCanvasRoutes(app, deps),
  commonToolPacks: (ctx) => buildCanvasToolPacks({
    scope: ctx.scope,
    agentStore: ctx.agentStore,
    canvasStore: ctx.canvasStore,
    sse: ctx.sse
  }),
  // Read with the skill that makes a canvas, so it is not in every step's tool list.
  skillAppendices: { "canvas-artifact": canvasPageContract, "canvas-design": canvasPageContract }
};
