import type { Hono } from "hono";
import type { AgentStore } from "./agent-store.js";
import type { WorkItemStore, WorkItemNeedsUser } from "./work-item-store.js";
import { WORK_ITEM_NEEDS_USER_VALUES } from "./work-item-store.js";
import type { AgentWakeReason } from "../../../shared/api/agents.js";
import type { WorkItemResponse, WorkItemsListResponse } from "../../../shared/api/work-items.js";
import { API_ROUTES } from "../../../shared/api/routes.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api/sse.js";
import { toWorkItemDto } from "./work-item-dto.js";

export interface WorkItemsRoutesDeps {
  agentStore: AgentStore;
  workStore: WorkItemStore;
  sse: AgentSseEmitter;
  wake: (threadId: string, reason: AgentWakeReason) => string | null;
}

export function registerWorkItemsRoutes(app: Hono, deps: WorkItemsRoutesDeps): void {
  // Lists default to unarchived projects and workers. Filter in SQL before
  // applying limits/cursors; old chat references use the single-item GET below.
  app.get(API_ROUTES.workItems, (c) => {
    const needsUserParam = c.req.query("needsUser");
    // "none" means needsUser IS null; "any" or absent means no filter
    let needsUserFilter: WorkItemNeedsUser | "any" | undefined = undefined;
    if (needsUserParam === "none") {
      needsUserFilter = null;
    } else if (needsUserParam === "any") {
      needsUserFilter = "any";
    } else if (needsUserParam && (WORK_ITEM_NEEDS_USER_VALUES as readonly string[]).includes(needsUserParam)) {
      needsUserFilter = needsUserParam as WorkItemNeedsUser;
    }
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
      : deps.workStore.list({ needsUser: needsUserFilter, before, limit, unarchivedOnly: true });

    const nextCursor = items.length === limit && items.length > 0
      ? items.at(-1)?.lastActivityAt ?? null
      : null;
    return c.json({
      items: items.map((item) => toWorkItemDto(item)),
      nextCursor
    } satisfies WorkItemsListResponse);
  });

  app.get(API_ROUTES.workItem, (c) => {
    const id = c.req.param("id");
    const item = deps.workStore.get(id);
    if (!item) return c.json({ error: "not_found" }, 404);
    return c.json({ item: toWorkItemDto(item) } satisfies WorkItemResponse);
  });

  app.post(API_ROUTES.workItemPromote, async (c) => {
    const id = c.req.param("id");
    const item = deps.workStore.get(id);
    if (!item) return c.json({ error: "not_found" }, 404);
    await injectPromoteMessage(deps, item);
    return c.json({ ok: true });
  });

  app.patch(API_ROUTES.workItem, async (c) => {
    const id = c.req.param("id");
    const item = deps.workStore.get(id);
    if (!item) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json() as { needsUser?: WorkItemNeedsUser | "null" };
    // Accept null (JSON null) or one of the known string values
    const needsUserRaw = (body as { needsUser?: unknown }).needsUser;
    let needsUser: WorkItemNeedsUser | undefined;
    if (needsUserRaw === null) {
      needsUser = null;
    } else if (typeof needsUserRaw === "string" && (WORK_ITEM_NEEDS_USER_VALUES as readonly string[]).includes(needsUserRaw)) {
      needsUser = needsUserRaw as WorkItemNeedsUser;
    } else {
      return c.json({ error: `needsUser must be null or one of ${WORK_ITEM_NEEDS_USER_VALUES.join("|")}` }, 400);
    }
    const updated = deps.workStore.update(id, { needsUser });
    if (!updated) return c.json({ error: "not_found" }, 404);
    deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(updated) });
    return c.json({ item: toWorkItemDto(updated) } satisfies WorkItemResponse);
  });
}

async function injectPromoteMessage(
  deps: WorkItemsRoutesDeps,
  item: import("./work-item-store.js").WorkItem
): Promise<void> {
  const overview = deps.agentStore.getOrCreateThread("manager", null);
  const text = [
    `📌 [Work item: ${item.title}]`,
    item.summary ? `\n${item.summary}` : "",
    `\nphase: ${item.phase}${item.phaseDetail ? ` · ${item.phaseDetail}` : ""}`
  ].join("");
  deps.agentStore.enqueueMailboxMessage({
    threadId: overview.id,
    role: "user",
    source: "user",
    content: {
      type: "text",
      text,
      attachments: [],
      metadata: {
        workItemRef: { itemId: item.id, snapshotAt: new Date().toISOString() }
      }
    }
  });
  deps.wake(overview.id, "work-item-promote");
}
