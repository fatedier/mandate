import type { Database } from "bun:sqlite";
import type { AgentWakeMetadata } from "../../../shared/api/agents.js";
import type { AgentStore, AgentThread } from "./agent-store.js";

export const INTERRUPTED_TOOL_RESULT = "The server restarted before this tool result was recorded. "
  + "The operation may or may not have completed. Check the current state before retrying.";

export const RESTART_RECOVERY_MESSAGE = "The Mandate server restarted while this conversation was running. "
  + "Follow the latest user instructions and continue previously authorized unfinished work. "
  + "First inspect the saved conversation and current environment to determine what has already completed. "
  + "Missing tool results have been marked as unknown; verify their effects before deciding whether to retry. "
  + "If the work is already complete, report the result and stop.";

export function pendingWakeRecovery(db: Database, threadId: string): AgentWakeMetadata["recovery"] | undefined {
  const row = db.prepare(`select content from agent_mailbox
    where thread_id = ? and source = 'restart-recovery' and status = 'queued'
    order by created_at, id limit 1`).get(threadId) as { content: string } | undefined;
  return row ? JSON.parse(row.content).metadata?.recovery : undefined;
}

/** All repair writes and the durable wake request commit together. A second
 * startup either sees the original running wake or its queued recovery. */
export function recoverInterruptedWakes(
  db: Database,
  store: AgentStore,
  errorMessage: string,
  canRecoverThread: (thread: AgentThread) => boolean
): number {
  db.exec("begin immediate");
  try {
    // Discard stale recovery requests before they can wake an archived scope.
    const pending = db.prepare(`select distinct thread_id from agent_mailbox
      where source = 'restart-recovery' and status = 'queued'`).all() as Array<{ thread_id: string }>;
    for (const row of pending) {
      const thread = store.getThreadById(row.thread_id);
      if (!isRecoverable(thread, canRecoverThread)) discardRecovery(db, row.thread_id);
    }
    const rows = db.prepare(`select id, thread_id, cancel_requested_at from agent_wakes
      where status = 'running' order by started_at, rowid`).all() as Array<{
      id: string; thread_id: string; cancel_requested_at: string | null;
    }>;
    for (const row of rows) {
      const wake = store.getWakeById(row.id)!;
      const canceled = row.cancel_requested_at !== null;
      store.finishWake(row.id, canceled ? "canceled" : "error", canceled ? "Stopped by user." : errorMessage);
      if (canceled) discardRecovery(db, row.thread_id);
      const thread = store.getThreadById(row.thread_id);
      if (!isRecoverable(thread, canRecoverThread)) continue;

      const messages = store.getActiveMessages(row.thread_id);
      const results = new Set(messages.flatMap((message) =>
        message.content.type === "tool_result" ? [message.content.toolCallId] : []));
      for (const message of messages) {
        if (message.wakeId !== row.id || message.content.type !== "assistant") continue;
        for (const call of message.content.toolCalls ?? []) {
          if (results.has(call.toolCallId)) continue;
          store.appendMessage({
            threadId: row.thread_id, role: "tool", source: "self", wakeId: row.id,
            content: {
              type: "tool_result", toolCallId: call.toolCallId, toolName: call.toolName,
              isError: true, error: canceled ? "Stopped by user. Execution outcome is unknown." : INTERRUPTED_TOOL_RESULT
            }
          });
          results.add(call.toolCallId);
        }
      }
      if (canceled) continue;

      const pendingRecovery = pendingWakeRecovery(db, row.thread_id);
      const original = pendingRecovery ?? wake.metadata?.recovery;
      const recovery: NonNullable<AgentWakeMetadata["recovery"]> = {
        wakeIds: [...new Set([...(pendingRecovery?.wakeIds ?? []), ...(wake.metadata?.recovery?.wakeIds ?? []), wake.id])],
        originalReason: original?.originalReason ?? wake.reason,
        originalTriggerMessageId: original?.originalTriggerMessageId ?? wake.triggerMessageId
      };
      const content = { type: "text" as const, text: RESTART_RECOVERY_MESSAGE, metadata: { recovery } };
      if (pendingRecovery) {
        db.prepare(`update agent_mailbox set content = ?
          where thread_id = ? and source = 'restart-recovery' and status = 'queued'`)
          .run(JSON.stringify(content), row.thread_id);
      } else {
        store.enqueueMailboxMessage({ threadId: row.thread_id, role: "user", source: "restart-recovery", content });
      }
    }
    db.exec("commit");
    return rows.length;
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

function isRecoverable(thread: AgentThread | null, canRecover: (thread: AgentThread) => boolean): thread is AgentThread {
  return Boolean(thread && thread.kind === "main" && !thread.archivedAt && !thread.closedAt && canRecover(thread));
}

export function discardRecovery(db: Database, threadId: string): void {
  db.prepare(`delete from agent_mailbox
    where thread_id = ? and source = 'restart-recovery' and status = 'queued'`).run(threadId);
}
