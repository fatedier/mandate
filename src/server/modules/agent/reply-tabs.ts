import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { newId } from "../../platform/ids.js";
import { INVALID_JSON, readJsonBody } from "../../platform/http/json-body.js";
import { isRecord } from "../../../shared/guards.js";
import { API_ROUTES } from "../../../shared/api/routes.js";
import { SSE_EVENTS } from "../../../shared/api/sse.js";
import { MAX_REPLY_TAB_CHARS, type ReplyTabDto, type ReplyTabsResponse } from "../../../shared/api/reply-tabs.js";
import type { AgentStore } from "./agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";

interface ReplyTabRow {
  id: string;
  thread_id: string;
  message_id: string;
  text: string;
  replied_at: string;
  created_at: string;
}

const toDto = (row: ReplyTabRow): ReplyTabDto => ({
  id: row.id,
  threadId: row.thread_id,
  messageId: row.message_id,
  text: row.text,
  repliedAt: row.replied_at,
  createdAt: row.created_at
});

/** The replies opened in each thread's right panel (agent_reply_tabs), in the
 *  order they were opened. The agents never read them. */
export class ReplyTabStore {
  constructor(private readonly db: Database) {}

  list(threadId: string): ReplyTabDto[] {
    const rows = this.db.prepare(
      `select id, thread_id, message_id, text, replied_at, created_at from agent_reply_tabs
        where thread_id = ? order by created_at, rowid`
    ).all(threadId) as ReplyTabRow[];
    return rows.map(toDto);
  }

  /** The reply's tab; one it already has is returned as it is. */
  add(input: { threadId: string; messageId: string; text: string; repliedAt: string }): ReplyTabDto {
    this.db.prepare(
      `insert into agent_reply_tabs (id, thread_id, message_id, text, replied_at, created_at)
        values (?, ?, ?, ?, ?, ?) on conflict (thread_id, message_id) do nothing`
    ).run(newId("rtab"), input.threadId, input.messageId, input.text, input.repliedAt, new Date().toISOString());
    const row = this.db.prepare(
      `select id, thread_id, message_id, text, replied_at, created_at from agent_reply_tabs where thread_id = ? and message_id = ?`
    ).get(input.threadId, input.messageId) as ReplyTabRow;
    return toDto(row);
  }

  has(threadId: string, messageId: string): boolean {
    return this.db.prepare(`select 1 from agent_reply_tabs where thread_id = ? and message_id = ?`).get(threadId, messageId) != null;
  }

  remove(threadId: string, tabId: string): boolean {
    return this.db.prepare(`delete from agent_reply_tabs where id = ? and thread_id = ?`).run(tabId, threadId).changes > 0;
  }
}

interface ReplyTabRouteDeps {
  store: ReplyTabStore;
  agentStore: Pick<AgentStore, "getThreadById" | "getMessageById">;
  sse: Pick<AgentSseEmitter, "emit">;
}

/** The personal agent's thread and manager threads have a right panel; an archived
 *  one still shows its tabs. */
const hasPanel = (deps: ReplyTabRouteDeps, threadId: string): boolean => {
  const scope = deps.agentStore.getThreadById(threadId)?.scope;
  return scope === "manager" || scope === "personal";
};

export function mountReplyTabRoutes(app: Hono, deps: ReplyTabRouteDeps): void {
  const changed = (threadId: string) => deps.sse.emit(SSE_EVENTS.replyTabsChanged, { threadId });

  app.get(API_ROUTES.agentThreadReplyTabs, (c) => {
    const threadId = c.req.param("threadId");
    if (!hasPanel(deps, threadId)) return c.json({ error: "thread not found" } satisfies ReplyTabsResponse, 404);
    return c.json({ tabs: deps.store.list(threadId) } satisfies ReplyTabsResponse);
  });

  app.post(API_ROUTES.agentThreadReplyTabs, async (c) => {
    const threadId = c.req.param("threadId");
    if (!hasPanel(deps, threadId)) return c.json({ error: "thread not found" } satisfies ReplyTabsResponse, 404);
    const body = await readJsonBody(c);
    if (body === INVALID_JSON || !isRecord(body)) return c.json({ error: "invalid JSON" } satisfies ReplyTabsResponse, 400);
    const { messageId, text } = body;
    if (typeof messageId !== "string") return c.json({ error: "messageId must be a string" } satisfies ReplyTabsResponse, 400);
    if (typeof text !== "string" || !text.trim()) return c.json({ error: "text must not be empty" } satisfies ReplyTabsResponse, 400);
    if (text.length > MAX_REPLY_TAB_CHARS) {
      return c.json({ error: `text is longer than ${MAX_REPLY_TAB_CHARS.toLocaleString("en-US")} characters` } satisfies ReplyTabsResponse, 400);
    }
    const message = deps.agentStore.getMessageById(messageId);
    if (!message || message.threadId !== threadId || message.role !== "assistant") {
      return c.json({ error: "reply not found in this thread" } satisfies ReplyTabsResponse, 404);
    }
    const known = deps.store.has(threadId, messageId);
    deps.store.add({ threadId, messageId, text, repliedAt: message.createdAt });
    if (!known) changed(threadId);
    return c.json({ tabs: deps.store.list(threadId) } satisfies ReplyTabsResponse);
  });

  app.delete(API_ROUTES.agentThreadReplyTab, (c) => {
    const threadId = c.req.param("threadId");
    if (!hasPanel(deps, threadId)) return c.json({ error: "thread not found" } satisfies ReplyTabsResponse, 404);
    if (!deps.store.remove(threadId, c.req.param("tabId"))) return c.json({ error: "reply tab not found" } satisfies ReplyTabsResponse, 404);
    changed(threadId);
    return c.json({ tabs: deps.store.list(threadId) } satisfies ReplyTabsResponse);
  });
}
