import type { Hono } from "hono";
import type { AppDeps } from "../../app/deps.js";
import { API_ROUTES, type WorkerPlanResponse, type WorkerRecordResponse } from "../../../shared/api-contracts.js";
import { planForPage } from "../../../shared/plan-rounds.js";
import { PlanStore } from "./plan-store.js";
import { WorkerRecordStore } from "./record-store.js";

export function mountPlanRoutes(app: Hono, deps: Pick<AppDeps, "store" | "workers">): void {
  const plans = new PlanStore(deps.store.db);
  const records = new WorkerRecordStore(deps.store.db);
  app.get(API_ROUTES.workerPlan, (c) => {
    c.header("Cache-Control", "no-store");
    const worker = deps.workers.getById(c.req.param("id"));
    if (!worker) return c.json({ error: "worker not found" } satisfies WorkerPlanResponse, 404);
    // The page's plan, as pushes send it; the whole one when earlier work is opened.
    const plan = plans.get(worker.id);
    return c.json({ plan: c.req.query("history") === "1" ? plan : planForPage(plan) } satisfies WorkerPlanResponse);
  });
  // The worker's task record, for its Plan tab.
  app.get(API_ROUTES.workerRecord, (c) => {
    c.header("Cache-Control", "no-store");
    const worker = deps.workers.getById(c.req.param("id"));
    if (!worker) return c.json({ error: "worker not found" } satisfies WorkerRecordResponse, 404);
    const record = records.get(worker.id);
    return c.json({ record: record ? { id: record.id, content: record.content, updatedAt: record.updatedAt } : null } satisfies WorkerRecordResponse);
  });
}
