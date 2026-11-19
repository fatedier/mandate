import type { Database } from "bun:sqlite";
import type { AgentStore } from "../agent/agent-store.js";
import type { WorkersStore } from "../workers/workers-store.js";

/** Holds in a row after which a thread is marked as needing the user. */
export const HELD_STREAK_MARK = 3;

/** A thread's mark: how many holds in a row, and the last one's reason. */
export interface HeldBack {
  times: number;
  reason: string;
}

export function initializeToolReviewSchema(db: Database): void {
  db.exec(`
    create table if not exists tool_review_streaks (
      thread_id text primary key,
      streak integer not null,
      reason text not null default '',
      updated_at text not null
    )
  `);
}

/** Each thread's run of holds by the tool-call review. A call the review
 *  lets through ends it; so does the user's own message, the moment it is
 *  stored: in the thread, or for a worker in its manager's thread. */
export class ToolReviewStreaks {
  constructor(private readonly deps: {
    db: Database;
    agentStore: Pick<AgentStore, "onUserStatement" | "getThreadByScope">;
    workers: Pick<WorkersStore, "listActiveOwnedBy" | "listArchivedOwnedBy">;
    /** A run ended by the user's words: what shows the mark reads it again. */
    onChanged?: () => void;
  }) {
    deps.agentStore.onUserStatement((threadId, message) => {
      // One that waited behind a running turn was heard as it was taken in
      // (the queue's onUserWords): landing now, it would end a run that
      // began after it.
      if (message.content.type === "text" && message.content.arrivedAt) return;
      this.answered(threadId);
    });
  }

  hold(threadId: string, reason: string): void {
    this.deps.db.prepare(`
      insert into tool_review_streaks (thread_id, streak, reason, updated_at) values (?, 1, ?, ?)
      on conflict(thread_id) do update set streak = streak + 1, reason = excluded.reason, updated_at = excluded.updated_at
    `).run(threadId, reason, new Date().toISOString());
  }

  clear(threadId: string): void {
    this.deps.db.prepare(`delete from tool_review_streaks where thread_id = ?`).run(threadId);
  }

  /** The thread's mark while it stands, or null. */
  mark(threadId: string): HeldBack | null {
    const row = this.deps.db.prepare(`select streak, reason from tool_review_streaks where thread_id = ?`)
      .get(threadId) as { streak: number; reason: string } | null;
    return row && row.streak >= HELD_STREAK_MARK ? { times: row.streak, reason: row.reason } : null;
  }

  /** The user spoke in a thread (or their words wait behind its running
   *  turn): its run ends, and so do those of the workers its manager owns,
   *  archived ones too (a restore brings them back). */
  answered(threadId: string): void {
    this.endRuns(threadId);
    this.deps.onChanged?.();
  }

  private endRuns(threadId: string): void {
    this.clear(threadId);
    for (const owned of [...this.deps.workers.listActiveOwnedBy(threadId), ...this.deps.workers.listArchivedOwnedBy(threadId)]) {
      const worker = this.deps.agentStore.getThreadByScope("worker", owned.id);
      if (worker) this.clear(worker.id);
    }
  }
}
