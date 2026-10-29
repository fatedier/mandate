import type { Hono } from "hono";
import type { AppDeps } from "../../app/deps.js";
import { API_ROUTES, type FeaturePlanResponse, type FeatureRecordResponse } from "../../../shared/api-contracts.js";
import { planForPage } from "../../../shared/plan-rounds.js";
import { PlanStore } from "./plan-store.js";
import { FeatureRecordStore } from "./record-store.js";

export function mountPlanRoutes(app: Hono, deps: Pick<AppDeps, "store" | "features">): void {
  const plans = new PlanStore(deps.store.db);
  const records = new FeatureRecordStore(deps.store.db);
  app.get(API_ROUTES.featurePlan, (c) => {
    c.header("Cache-Control", "no-store");
    const feature = deps.features.getById(c.req.param("id"));
    if (!feature) return c.json({ error: "feature not found" } satisfies FeaturePlanResponse, 404);
    // The page's plan, as pushes send it; the whole one when earlier work is opened.
    const plan = plans.get(feature.id);
    return c.json({ plan: c.req.query("history") === "1" ? plan : planForPage(plan) } satisfies FeaturePlanResponse);
  });
  // The worker's task record, for its Plan tab.
  app.get(API_ROUTES.featureRecord, (c) => {
    c.header("Cache-Control", "no-store");
    const feature = deps.features.getById(c.req.param("id"));
    if (!feature) return c.json({ error: "feature not found" } satisfies FeatureRecordResponse, 404);
    const record = records.get(feature.id);
    return c.json({ record: record ? { id: record.id, content: record.content, updatedAt: record.updatedAt } : null } satisfies FeatureRecordResponse);
  });
}
