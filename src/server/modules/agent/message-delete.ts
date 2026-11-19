import type { Database } from "bun:sqlite";
import type { AgentStore } from "./agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { isOwnTypedMessage, rowAfterMessage } from "../../../shared/own-message.js";
import { forgetIndexedMessage } from "./history-store.js";

/** What the owner is told when a message cannot be deleted. */
export const MESSAGE_ANSWERED = "The agent has answered this message, so it can't be deleted.";
export const MESSAGE_IN_WORK = "The agent is working on this message. Stop it first.";

/** How long it is kept that a message was deleted, for a page to be told. */
const DELETION_KEPT_MS = 30 * 24 * 3_600_000;

export type MessageDeleteResult =
  | { ok: true; removed: string[] }
  | { ok: false; status: 404 | 409; error: string };

interface MessageDeletionDeps {
  db: Database;
  agentStore: Pick<AgentStore, "getMessageById" | "getRunningWakeForThread" | "removeMessages">;
  /** A turn of the thread is under way; the store's running wake unless given. */
  isRunning?: (threadId: string) => boolean;
  sse?: Pick<AgentSseEmitter, "emit">;
  now?: () => number;
  /** Called once the rows are gone: what the thread shows of itself (its
   *  latest activity, an unnamed thread's title) may have changed. */
  onDeleted?: (threadId: string) => void;
}

/**
 * The owner deletes a message of their own that the agent has not answered:
 * a turn stopped or failed before it wrote anything, and what was typed
 * should not be taken up later. Unanswered means no reply and no tool call
 * after it before the next message that came in; and, for the last message,
 * no turn still running (it is stopped first).
 *
 * The row goes, with the line a failed turn left under it, and what search
 * kept of them. The agent's window is read from the rows (a deleted row moves
 * the conversation's version), so the next step no longer holds it. What a
 * summary already says of it, and past calls' records, stay.
 *
 * That it went is kept by id (agent_message_deletions): the event below
 * reaches the pages listening, and one whose stream was down is told at its
 * next read on from where it was (deletedIn).
 */
export class MessageDeletion {
  constructor(private readonly deps: MessageDeletionDeps) {}

  delete(threadId: string, messageId: string): MessageDeleteResult {
    const message = this.deps.agentStore.getMessageById(messageId);
    if (!message || message.threadId !== threadId || !isOwnTypedMessage(message)) return { ok: false, status: 404, error: "message not found" };
    const after = this.deps.db.prepare(
      `select id, role, source from agent_messages where thread_id = ? and seq > ? order by seq asc, created_at asc, id asc`
    ).all(threadId, message.seq) as Array<{ id: string; role: string; source: string }>;
    const removed = [message.id];
    let followed = false;
    for (const row of after) {
      const kind = rowAfterMessage(row);
      if (kind === "aside") continue;
      if (kind === "answer") return { ok: false, status: 409, error: MESSAGE_ANSWERED };
      if (kind === "failure") {
        removed.push(row.id);
        continue;
      }
      followed = true;
      break;
    }
    const running = this.deps.isRunning ?? ((id: string) => Boolean(this.deps.agentStore.getRunningWakeForThread(id)));
    if (!followed && running(threadId)) return { ok: false, status: 409, error: MESSAGE_IN_WORK };
    const db = this.deps.db;
    const now = this.deps.now?.() ?? Date.now();
    db.transaction(() => {
      db.prepare(`delete from agent_message_deletions where deleted_at < ?`).run(new Date(now - DELETION_KEPT_MS).toISOString());
      for (const id of removed) {
        forgetIndexedMessage(db, id);
        db.prepare(`insert or replace into agent_message_deletions (message_id, thread_id, deleted_at) values (?, ?, ?)`).run(id, threadId, new Date(now).toISOString());
      }
      this.deps.agentStore.removeMessages(threadId, removed);
    }).immediate();
    this.deps.sse?.emit(SSE_EVENTS.agentMessageDeleted, { threadId, messageIds: removed });
    this.deps.onDeleted?.(threadId);
    return { ok: true, removed };
  }

  /** The messages deleted from a thread, in the order they went. */
  deletedIn(threadId: string): string[] {
    const rows = this.deps.db.prepare(
      `select message_id from agent_message_deletions where thread_id = ? order by deleted_at asc, rowid asc`
    ).all(threadId) as Array<{ message_id: string }>;
    return rows.map((row) => row.message_id);
  }
}
