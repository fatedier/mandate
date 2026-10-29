import type { MandateModule } from "../module.js";
import { initializePlansSchema } from "./schema.js";
import { mountPlanRoutes } from "./plan-routes.js";
import { buildPlanToolPacks } from "./plan-tools.js";

export const plansModule: MandateModule = {
  id: "plans",
  schema: [initializePlansSchema],
  mountRoutes: (app, { deps }) => mountPlanRoutes(app, deps),
  commonToolPacks: (ctx) => buildPlanToolPacks({
    scope: ctx.scope,
    store: ctx.store,
    agentStore: ctx.agentStore,
    featuresStore: ctx.featuresStore,
    workStore: ctx.workStore,
    sse: ctx.sse,
    onQuestionAsked: ctx.onWorkerQuestion
  })
};
