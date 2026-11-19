import { historyOldIndexInUse, historyWordsAvailable } from "./history-words.js";
import type { Database } from "bun:sqlite";
import type { AgentStore } from "./agent-store.js";
import type { CanvasStore } from "../canvas/canvas-store.js";
import { BackgroundTaskStore } from "./background-task-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { ArchivedThreadDto } from "../../../shared/api/agents.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { threadDisplayTitle } from "./manager-threads.js";
import * as fs from "node:fs";
import { toolOutputDirsOfThread } from "../../platform/db/tool-output-retention.js";
import { threadResourcesDir } from "../../platform/fs/resources.js";
import { logError } from "../../platform/logger.js";

interface ThreadDeletionDeps {
  db: Database;
  agentStore: AgentStore;
  canvases: Pick<CanvasStore, "delete">;
  /** Work the runtime holds for a thread that writes to it when it ends: a
   *  turn still stopping, a memory extraction under way. */
  isBusy?: (threadId: string) => boolean;
  sse?: Pick<AgentSseEmitter, "emit">;
  /** Where the threads' tool output lies; the data dir unless a test's. */
  dataDir?: string;
  /** Called before a thread's rows go; what it returns runs once they have
   *  (a duty thread's schedules: the personal agent is told). */
  onDelete?: (threadId: string) => (() => void) | null;
  /** The projects a thread's workers ran in, by name, for the archived list. */
  projects?: (threadId: string) => readonly string[];
}

export type ThreadDeleteResult =
  | { ok: true; deleted: { threads: number; workers: number; canvases: number } }
  | { ok: false; status: 404 | 409; error: string };

/** What a thread's delete takes: the thread, the workers it owned, their
 *  worker threads, the subagents' threads of all of these, and their canvases. */
interface Holdings {
  threads: string[];
  workers: string[];
  canvases: string[];
}

const STILL_STOPPING = "Its work is still stopping. Try again in a moment.";

/** Rows kept per thread, deleted with it. */
const PER_THREAD = [
  "agent_mailbox", "agent_alarms", "agent_monitors", "agent_monitor_runs", "agent_pane_monitors", "agent_wakes", "manager_stop_checks",
  "agent_reply_tabs", "tool_review_streaks", "personal_thread_tabs", "agent_message_deletions", "agent_message_seq_floors", "thread_labels",
  "agent_schedules", "agent_schedule_runs", "agent_duty_threads", "agent_duty_reports", "agent_duty_sidebar"
] as const;

/**
 * Archived manager threads: the list of them, and their deletion for good.
 * Only an archived thread can be deleted (an open one is archived first, which
 * stops its work). A delete takes the thread, the workers it owned (their
 * threads and workers: plans, steps and work items go by their keys), the
 * subagents of both (their threads and tasks), every
 * row kept per thread, the search index, and their canvases with their files.
 * Usage stays — llm calls keep their numbers and lose their words — and so do
 * memories and the personal agent's own records.
 */
export class ThreadDeletion {
  constructor(private readonly deps: ThreadDeletionDeps) {}

  archivedThreads(): ArchivedThreadDto[] {
    const rows = this.deps.db.prepare(
      `select id, archived_at, created_at from agent_threads
        where scope = 'manager' and archived_at is not null
        order by archived_at desc, rowid desc`
    ).all() as Array<{ id: string; archived_at: string; created_at: string }>;
    return rows.map((row) => {
      const held = this.holdings(row.id);
      return {
        id: row.id,
        title: threadDisplayTitle(this.deps.agentStore, row.id),
        archivedAt: row.archived_at,
        lastActivityAt: this.deps.agentStore.lastActivityAt(row.id) ?? row.created_at,
        workers: held.workers.length,
        canvases: held.canvases.length,
        labels: this.deps.agentStore.threadLabels(row.id),
        projects: [...(this.deps.projects?.(row.id) ?? [])]
      };
    });
  }

  delete(threadId: string): ThreadDeleteResult {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.scope !== "manager") return { ok: false, status: 404, error: "thread not found" };
    if (!thread.archivedAt) return { ok: false, status: 409, error: "Archive the thread first." };
    const held = this.holdings(threadId);
    // An archive asks its work to stop and does not wait: what is still
    // running would write its result back into rows deleted here.
    if (this.stillWorking(held)) return { ok: false, status: 409, error: STILL_STOPPING };
    // Asked while its rows are there, told once they are gone.
    const tell = this.deps.onDelete?.(threadId);
    this.remove(held, null);
    this.deps.sse?.emit(SSE_EVENTS.managerThreadDeleted, { threadId });
    tell?.();
    return { ok: true, deleted: { threads: held.threads.length, workers: held.workers.length, canvases: held.canvases.length } };
  }

  /** A side chat that ended, as an archived thread is deleted: its canvases
   *  go with it, or pass to `canvasesTo` (the conversation it was sent to).
   *  Its work is stopped first (SideChatService); refused while some of it
   *  is still stopping. */
  deleteSideChat(threadId: string, opts: { canvasesTo: string | null }): ThreadDeleteResult {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.scope !== "side_chat") return { ok: false, status: 404, error: "side chat not found" };
    const held = this.holdings(threadId);
    if (this.stillWorking(held)) return { ok: false, status: 409, error: STILL_STOPPING };
    this.remove(held, opts.canvasesTo);
    return { ok: true, deleted: { threads: held.threads.length, workers: held.workers.length, canvases: opts.canvasesTo ? 0 : held.canvases.length } };
  }

  /** Whether a side chat's delete would be refused now: a turn, a running
   *  wake or a model call of it still going. Its end waits for this to be
   *  false before anything is sent. */
  sideChatStillWorking(threadId: string): boolean {
    return this.stillWorking(this.holdings(threadId));
  }

  /** The rows, files and canvases of what a delete takes; its canvases go,
   *  or pass to `canvasesTo`'s thread. */
  private remove(held: Holdings, canvasesTo: string | null): void {
    const moved = canvasesTo ? held.canvases : [];
    if (canvasesTo && moved.length > 0) {
      this.deps.db.prepare(`update canvas_documents set thread_id = ? where id in (${marks(moved)})`).run(canvasesTo, ...moved);
    }
    // Files first, one canvas at a time: a folder that cannot go keeps
    // everything after it, to try again.
    const gone = canvasesTo ? [] : held.canvases.flatMap((id) => {
      const canvas = this.deps.canvases.delete(id);
      return canvas ? [canvas] : [];
    });
    this.deps.db.transaction(() => this.deleteRows(held)).immediate();
    // Their tool output (spooled results, background commands' output) goes
    // with them, one that cannot go left for the retention pass; and their
    // notes.
    for (const id of held.threads) {
      const dirs = [...toolOutputDirsOfThread(id, this.deps.dataDir), threadResourcesDir(id, this.deps.dataDir)];
      for (const dir of dirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          logError("thread delete", err, `could not remove ${dir}`);
        }
      }
    }
    // Each canvas gone (or moved) is told of as one changed on its own is:
    // whatever names it elsewhere (a mention, a link's title, a tab) reads it again.
    for (const canvas of gone) {
      this.deps.sse?.emit(SSE_EVENTS.canvasUpdated, { canvasId: canvas.id, workerId: canvas.scope === "worker" ? canvas.scopeId : null });
    }
    for (const id of moved) this.deps.sse?.emit(SSE_EVENTS.canvasUpdated, { canvasId: id, workerId: null });
  }

  /** Every archived thread whose work has stopped; `skipped`: those still stopping. */
  deleteAllArchived(): { ok: true; count: number; skipped: number } {
    let count = 0;
    let skipped = 0;
    for (const thread of this.archivedThreads()) {
      const result = this.delete(thread.id);
      if (result.ok) count += 1;
      else if (result.status === 409) skipped += 1;
    }
    return { ok: true, count, skipped };
  }

  private stillWorking(held: Holdings): boolean {
    if (held.threads.some((id) => this.deps.isBusy?.(id))) return true;
    const db = this.deps.db;
    const t = marks(held.threads);
    if (db.prepare(`select 1 from agent_wakes where thread_id in (${t}) and status = 'running' limit 1`).get(...held.threads)) return true;
    const ids = [...held.threads, ...held.workers];
    return Boolean(db.prepare(`select 1 from llm_calls where scope_id in (${marks(ids)}) and status = 'running' limit 1`).get(...ids));
  }

  private holdings(threadId: string): Holdings {
    const db = this.deps.db;
    const workers = (db.prepare("select id from workers where owner_thread_id = ?").all(threadId) as Array<{ id: string }>).map((r) => r.id);
    const workerThreads = workers.length === 0 ? [] : (db.prepare(
      `select id from agent_threads where scope = 'worker' and scope_id in (${marks(workers)})`
    ).all(...workers) as Array<{ id: string }>).map((r) => r.id);
    // Their subagents' hidden threads go with them.
    const parents = [threadId, ...workerThreads];
    const threads = [...parents, ...new BackgroundTaskStore(db).childThreadIdsOf(parents)];
    const canvases = (db.prepare(
      `select id from canvas_documents
        where thread_id in (${marks(threads)})
           ${workers.length > 0 ? `or (scope = 'worker' and scope_id in (${marks(workers)}))` : ""}`
    ).all(...threads, ...workers) as Array<{ id: string }>).map((r) => r.id);
    return { threads, workers, canvases };
  }

  private deleteRows(held: Holdings): void {
    const db = this.deps.db;
    const t = marks(held.threads);
    const threads = held.threads;
    // The search index: an entry's words live in the words index by the rowid
    // kept for it, or in the old index by its id where that one is in use.
    if (historyOldIndexInUse(db)) db.prepare(`delete from agent_message_search_fts where entry_id in (select id from agent_message_search_entries where thread_id in (${t}))`).run(...threads);
    if (historyWordsAvailable(db)) db.prepare(`delete from agent_message_search_words where rowid in (select k.word_rowid from agent_message_search_word_keys k join agent_message_search_entries e on e.id = k.entry_id where e.thread_id in (${t}))`).run(...threads);
    db.prepare(`delete from agent_message_search_word_keys where entry_id in (select id from agent_message_search_entries where thread_id in (${t}))`).run(...threads);
    db.prepare(`delete from agent_message_search_entries where thread_id in (${t})`).run(...threads);
    db.prepare(`delete from agent_message_search_skipped where message_id in (select id from agent_messages where thread_id in (${t}))`).run(...threads);
    db.prepare(`delete from agent_messages where thread_id in (${t})`).run(...threads);
    for (const table of PER_THREAD) db.prepare(`delete from ${table} where thread_id in (${t})`).run(...threads);
    // Usage stays for Activity's totals; what was said goes. A call is kept
    // under whichever of these ids it was made for (a worker's extraction is
    // recorded under the project scope with the worker's id); ids are unique
    // across kinds, so the scope's kind is not asked.
    const ids = [...threads, ...held.workers];
    // The scope kinds there are, listed by stepping through the index one
    // kind at a time, let the update look each id up under each kind: with
    // the id alone SQLite walks every call there is.
    db.prepare(`
      with recursive kinds(kind) as (
        select (select min(scope_type) from llm_calls)
        union all
        select (select min(scope_type) from llm_calls where scope_type > kind) from kinds where kind is not null
      )
      update llm_calls set request_json = null, response_json = null, output_json = null
       where scope_type in (select kind from kinds where kind is not null) and scope_id in (${marks(ids)})
    `).run(...ids);
    if (held.workers.length > 0) {
      const workerMarks = marks(held.workers);
      const workers = held.workers;
      db.prepare(`delete from pane_metadata where worker_id in (${workerMarks})`).run(...workers);
      db.prepare(`delete from workers where id in (${workerMarks})`).run(...workers);
    }
    // The subagents' tasks, by their parents (the children are among these threads).
    db.prepare(`delete from background_tasks where parent_thread_id in (${t})`).run(...threads);
    db.prepare(`delete from agent_threads where id in (${t})`).run(...threads);
  }
}

function marks(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}
