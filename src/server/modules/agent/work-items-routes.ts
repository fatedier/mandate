import type { Hono } from "hono";
import type { WorkItemStore } from "./work-item-store.js";
import type { WorkItemResponse, WorkItemsListResponse } from "../../../shared/api/work-items.js";
import { API_ROUTES } from "../../../shared/api/routes.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api/sse.js";
import { toWorkItemDto } from "./work-item-dto.js";
import type { PlanStore } from "../plans/plan-store.js";
import { clearWorkerQuestions } from "./clear-worker-questions.js";

interface WorkItemsRoutesDeps {
  workStore: WorkItemStore;
  sse: AgentSseEmitter;
  /** The workers' plans: acknowledging a worker clears the questions its plan asks. */
  planStore?: Pick<PlanStore, "get" | "update">;
}

export function registerWorkItemsRoutes(app: Hono, deps: WorkItemsRoutesDeps): void {
  // Lists default to unarchived projects and workers. Filter in SQL before
  // applying the limit.
  app.get(API_ROUTES.workItems, (c) => {
    const limitParam = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;

    // Direct lookup for the one item bound to a worker. The worker pane can
    // open before its work item has reached the client's list — a brand-new
    // worker, a created event that arrived while the page was elsewhere, or
    // an item past the list's limit — and needs a bounded fetch that cannot
    // return anything belonging to another worker. The binding is 1:1, so a
    // list limit sent with it means nothing.
    const workerId = c.req.query("workerId");
    if (workerId) {
      const items = deps.workStore.list({ workerId, unarchivedOnly: true, limit: 1 });
      return c.json({ items: items.map(toWorkItemDto) } satisfies WorkItemsListResponse);
    }

    const items = deps.workStore.list({ limit, unarchivedOnly: true });
    return c.json({ items: items.map((item) => toWorkItemDto(item)) } satisfies WorkItemsListResponse);
  });

  // The page's acknowledge control: what a worker asks is in its plan, so
  // its questions go, and the worker counts as active now.
  app.post(API_ROUTES.workItemAcknowledge, (c) => {
    const updated = deps.workStore.touch(c.req.param("id"));
    if (!updated) return c.json({ error: "not_found" }, 404);
    clearWorkerQuestions(deps, updated.workerId);
    deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(updated) });
    return c.json({ item: toWorkItemDto(updated) } satisfies WorkItemResponse);
  });
}
