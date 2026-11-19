import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { ThreadStatusSnapshotDto } from "../../../shared/api/thread-status.js";
import type { ThreadDot } from "../../../shared/thread-dot.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { TaskBoardService } from "./task-board-service.js";

/**
 * Sends a task again when what it shows of its threads moves: a thread's
 * turn ended (its latest reply), its dot changed, or it was deleted (its
 * workers with it). The dot is read from
 * the status snapshot after it is worked out, so the task's marks agree with
 * the sidebar. A worker made for a thread, or moving to it, changes where
 * the thread's work ran (and the one it left, which may never move again)
 * while its turn may still be running. Returns the unsubscribe.
 */
export function watchTaskThreads(
  sse: Pick<AgentSseEmitter, "addSink">,
  board: Pick<TaskBoardService, "threadChanged">,
  workers: Pick<WorkersStore, "onOwnerChange">
): () => void {
  let dots = new Map<string, ThreadDot>();
  const later = (ids: readonly string[]) => {
    if (ids.length > 0) queueMicrotask(() => { for (const id of ids) board.threadChanged(id); });
  };
  const stopMoves = workers.onOwnerChange(({ from, to }) => later(from ? [from, to] : [to]));
  const stopSink = sse.addSink((e) => {
    if (e.event === SSE_EVENTS.agentWakeFinished || e.event === SSE_EVENTS.managerThreadDeleted) {
      const threadId = (e.data as { threadId?: string }).threadId;
      if (threadId) later([threadId]);
      return;
    }
    if (e.event !== SSE_EVENTS.threadStatus) return;
    const next = new Map((e.data as ThreadStatusSnapshotDto).threads.map((t) => [t.threadId, t.state] as const));
    const changed = [...next].filter(([id, dot]) => dots.get(id) !== dot).map(([id]) => id);
    for (const id of dots.keys()) if (!next.has(id)) changed.push(id);
    dots = next;
    later(changed);
  });
  return () => { stopSink(); stopMoves(); };
}
