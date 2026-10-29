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
  // applying limits/cursors; old chat references use the single-item GET below.
  app.get(API_ROUTES.workItems, (c) => {
    const attention = c.req.query("attention") === "1";
    const before = c.req.query("before") || undefined;
    const limitParam = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 200 ? limitParam : 50;

    // Direct lookup for the one item bound to a feature. The feature pane can
    // open before its work item has reached the client's list — a brand-new
    // feature, a created event that arrived while the page was elsewhere, or
    // an item past the list's limit — and needs a bounded fetch that cannot
    // return anything belonging to another feature. Exclusive with the list
    // filters by construction: the binding is 1:1, so paging it is meaningless.
    const featureId = c.req.query("featureId");
    if (featureId) {
      const items = deps.workStore.list({ featureId, unarchivedOnly: true, limit: 1 });
      return c.json({
        items: items.map(toWorkItemDto),
        nextCursor: null
      } satisfies WorkItemsListResponse);
    }

    const items = attention
      ? deps.workStore.listAttention({ limit, unarchivedOnly: true })
      : deps.workStore.list({ before, limit, unarchivedOnly: true });

    const nextCursor = items.length === limit && items.length > 0
      ? items.at(-1)?.lastActivityAt ?? null
      : null;
    return c.json({
      items: items.map((item) => toWorkItemDto(item)),
      nextCursor
    } satisfies WorkItemsListResponse);
  });

  // The page's acknowledge control: what a worker asks is in its plan, so
  // its questions go, and the worker counts as active now.
  app.post(API_ROUTES.workItemAcknowledge, (c) => {
    const updated = deps.workStore.touch(c.req.param("id"));
    if (!updated) return c.json({ error: "not_found" }, 404);
    clearWorkerQuestions(deps, updated.featureId);
    deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(updated) });
    return c.json({ item: toWorkItemDto(updated) } satisfies WorkItemResponse);
  });
}
