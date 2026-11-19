import type { Database } from "bun:sqlite";
import type { StopVerdict } from "../../../../shared/thread-dot.js";

/** A thread's manager-stop-check verdict: the reply it judged, what it found
 *  (`nothing` included) and when. */
export interface StoredVerdict {
  replySeq: number;
  outcome: StopVerdict;
  judgedAt: string;
}

export type ManagerStopCheckStore = ReturnType<typeof createManagerStopCheckStore>;

/** One verdict per thread, the latest; it survives restarts and goes with
 *  its thread (thread-delete's PER_THREAD). */
export function createManagerStopCheckStore(db: Database) {
  return {
    get(threadId: string): StoredVerdict | null {
      const row = db.prepare("select reply_seq, outcome, judged_at from manager_stop_checks where thread_id = ?")
        .get(threadId) as { reply_seq: number; outcome: StopVerdict; judged_at: string } | null;
      return row ? { replySeq: row.reply_seq, outcome: row.outcome, judgedAt: row.judged_at } : null;
    },
    set(threadId: string, verdict: StoredVerdict): void {
      db.prepare(`insert into manager_stop_checks (thread_id, reply_seq, outcome, judged_at) values (?, ?, ?, ?)
        on conflict(thread_id) do update set reply_seq = excluded.reply_seq, outcome = excluded.outcome, judged_at = excluded.judged_at`)
        .run(threadId, verdict.replySeq, verdict.outcome, verdict.judgedAt);
    }
  };
}
