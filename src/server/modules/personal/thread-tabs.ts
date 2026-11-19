import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";
import { isRecord } from "../../../shared/guards.js";
import { API_ROUTES } from "../../../shared/api/routes.js";
import { SSE_EVENTS } from "../../../shared/api/sse.js";
import type { ThreadTabDto, ThreadTabsResponse } from "../../../shared/api/thread-tabs.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";

interface ThreadTabRow {
  thread_id: string;
  created_at: string;
}

const toDto = (row: ThreadTabRow): ThreadTabDto => ({ threadId: row.thread_id, createdAt: row.created_at });

/** The manager threads opened beside the personal agent (personal_thread_tabs), in the
 *  order they were opened. A thread's delete takes its row; its archive does
 *  not. The agents never read them. */
export class ThreadTabStore {
  constructor(private readonly db: Database) {}

  list(): ThreadTabDto[] {
    const rows = this.db.prepare(
      `select thread_id, created_at from personal_thread_tabs order by created_at, rowid`
    ).all() as ThreadTabRow[];
    return rows.map(toDto);
  }

  /** Opens the thread's tab; false when it had one already. */
  add(threadId: string): boolean {
    return this.db.prepare(
      `insert into personal_thread_tabs (thread_id, created_at) values (?, ?) on conflict (thread_id) do nothing`
    ).run(threadId, new Date().toISOString()).changes > 0;
  }

  remove(threadId: string): boolean {
    return this.db.prepare(`delete from personal_thread_tabs where thread_id = ?`).run(threadId).changes > 0;
  }
}

interface ThreadTabRouteDeps {
  store: ThreadTabStore;
  agentStore: Pick<AgentStore, "getThreadById">;
  sse: Pick<AgentSseEmitter, "emit">;
}

export function mountThreadTabRoutes(app: Hono, deps: ThreadTabRouteDeps): void {
  const tabs = () => ({ tabs: deps.store.list() }) satisfies ThreadTabsResponse;
  const changed = () => deps.sse.emit(SSE_EVENTS.threadTabsChanged, {});

  app.get(API_ROUTES.agentPersonalThreadTabs, (c) => c.json(tabs()));

  app.post(API_ROUTES.agentPersonalThreadTabs, async (c) => {
    const body = await readJsonBody(c);
    if (body === INVALID_JSON || !isRecord(body)) return c.json({ error: "invalid JSON" } satisfies ThreadTabsResponse, 400);
    const { threadId } = body;
    if (typeof threadId !== "string") return c.json({ error: "threadId must be a string" } satisfies ThreadTabsResponse, 400);
    // A manager thread, archived or not: the personal agent's own and workers' are
    // not threads of the sidebar.
    if (deps.agentStore.getThreadById(threadId)?.scope !== "manager") {
      return c.json({ error: "thread not found" } satisfies ThreadTabsResponse, 404);
    }
    if (deps.store.add(threadId)) changed();
    return c.json(tabs());
  });

  app.delete(API_ROUTES.agentPersonalThreadTab, (c) => {
    if (!deps.store.remove(c.req.param("threadId"))) return c.json({ error: "thread tab not found" } satisfies ThreadTabsResponse, 404);
    changed();
    return c.json(tabs());
  });
}
