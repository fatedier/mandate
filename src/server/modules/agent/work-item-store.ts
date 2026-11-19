import type { Database } from "bun:sqlite";
import { WorkItemChangeEmitter } from "./work-item-events.js";
import type { WorkItemChangeKind, WorkItemChangeListener } from "./work-item-events.js";
import type { SqlValue } from "../../platform/db/sql-value.js";

/** A worker's item: what it is called, when it last moved, and how its last
 *  wake ended. What a worker asks is an open question in its plan; what it
 *  has done and left is the plan itself.
 *
 *  Lifecycle (alive vs done) lives on the worker itself (workers.archived_at).
 *  When a worker is archived, its work_item disappears from the dashboard too. */
export interface WorkItem {
  id: string;
  workerId: string;
  projectId: string;
  title: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
  failedAt: string | null;
  failedMessage: string | null;
  /** Why the last wake ended without finishing: an error, or a stop (stuck). */
  failedKind: "error" | "stopped" | null;
}

interface RawWorkItem {
  id: string;
  worker_id: string;
  project_id: string;
  title: string;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  failed_at: string | null;
  failed_message: string | null;
  failed_kind: string | null;
}

// HTTP lists follow the same project/worker membership as the dashboard.
// Internal history readers and direct item lookups can still see archived work.
const UNARCHIVED_WORK_ITEM_SCOPE = `exists (
  select 1 from workers wk
  join projects p on p.id = wk.project_id
  where wk.id = work_items.worker_id and wk.project_id = work_items.project_id
    and wk.archived_at is null and p.archived_at is null
)`;

/** What makes a work item stalled, over w (the item), wk (its worker) and t
 *  (its worker's open thread), as a WHERE: a caller adds `and …` clauses. */
const STALLED_RULE = `wk.archived_at is null
          and exists (select 1 from worker_plan_steps s
                      where s.worker_id = w.worker_id and s.status in ('pending','in_progress'))
          and not exists (select 1 from worker_plans p
                          where p.worker_id = w.worker_id and json_array_length(p.open_questions) > 0)
          and not exists (select 1 from agent_wakes a
                          where a.thread_id = t.id and a.finished_at is null)
          and not exists (select 1 from agent_alarms al
                          where al.thread_id = t.id and al.status = 'pending')
          and not exists (select 1 from agent_mailbox m
                          where m.thread_id = t.id and m.delivered_at is null)
          and not exists (select 1 from agent_pane_monitors pm
                          where pm.thread_id = t.id)
          and not exists (select 1 from agent_monitors mo
                          where mo.thread_id = t.id)
          and not exists (select 1 from background_tasks bt
                          where bt.parent_thread_id = t.id and bt.status in ('queued', 'running'))`;

/** Every stalled item, walked from the workers (cross join keeps that
 *  order): from the threads, SQLite starts with every open worker thread,
 *  and archived workers keep theirs open. */
const STALLED_ALL = `workers wk
        cross join work_items w on w.worker_id = wk.id
        cross join agent_threads t
          on t.scope = 'worker' and t.scope_id = w.worker_id and t.archived_at is null
        where ${STALLED_RULE}`;

/** One worker's item, found by its worker. */
const STALLED_ONE = `work_items w
        join workers wk on wk.id = w.worker_id
        join agent_threads t
          on t.scope = 'worker' and t.scope_id = w.worker_id and t.archived_at is null
        where ${STALLED_RULE}`;

/** The item's worker belongs to the bound thread. One `?` to bind. */
const OWNED_BY = (table: string) => `exists (
  select 1 from workers fo
  where fo.id = ${table}.worker_id
    and fo.owner_thread_id = ?
)`;

export class WorkItemStore {
  constructor(
    private readonly db: Database,
    private readonly changes = new WorkItemChangeEmitter()
  ) {}

  onChange(listener: WorkItemChangeListener): () => void {
    return this.changes.onChange(listener);
  }

  get(id: string): WorkItem | null {
    const row = this.db.prepare(`select * from work_items where id = ?`).get(id) as
      | RawWorkItem
      | undefined;
    return row ? this.toItem(row) : null;
  }

  getByWorker(workerId: string): WorkItem | null {
    const row = this.db.prepare(`select * from work_items where worker_id = ?`).get(workerId) as
      | RawWorkItem
      | undefined;
    return row ? this.toItem(row) : null;
  }

  /** Marks the item as having just moved (its plan changed, or the user
   *  acknowledged it) and tells the listeners. */
  touch(id: string): WorkItem | null {
    const cur = this.get(id);
    if (!cur) return null;
    const now = new Date().toISOString();
    this.db
      .prepare(`update work_items set updated_at = ?, last_activity_at = ? where id = ?`)
      .run(now, now, id);
    const item = this.get(id);
    if (item) this.emitChange("updated", item);
    return item;
  }

  /** Records (or clears) a failed or stopped wake. Returns the item only when
   *  something changed, so callers broadcast only real changes. Not an activity bump. */
  setFailure(workerId: string, failure: { at: string; message: string; kind: "error" | "stopped" } | null): WorkItem | null {
    const cur = this.getByWorker(workerId);
    if (!cur) return null;
    const at = failure?.at ?? null;
    const message = failure ? failure.message.slice(0, 200) : null;
    const kind = failure?.kind ?? null;
    if (cur.failedAt === at && cur.failedMessage === message && cur.failedKind === kind) return null;
    this.db.prepare(`update work_items set failed_at = ?, failed_message = ?, failed_kind = ? where worker_id = ?`)
      .run(at, message, kind, workerId);
    const item = this.getByWorker(workerId)!;
    this.emitChange("updated", item);
    return item;
  }

  getReportedState(workerId: string): string | null {
    const r = this.db.prepare(`select reported_state from work_items where worker_id = ?`)
      .get(workerId) as { reported_state: string | null } | undefined;
    return r?.reported_state ?? null;
  }

  /** Internal bookkeeping for the report gate: no event, no activity bump. */
  setReportedState(workerId: string, key: string): void {
    this.db.prepare(`update work_items set reported_state = ? where worker_id = ?`).run(key, workerId);
  }

  /** True when the worker belongs to the thread. */
  isOwnedBy(workerId: string, threadId: string): boolean {
    const row = this.db.prepare(
      `select 1 as ok from work_items where worker_id = ? and ${OWNED_BY("work_items")}`
    ).get(workerId, threadId) as { ok: number } | undefined;
    return Boolean(row);
  }

  /** Workers whose last wake failed or stopped: their manager's to look at,
   *  the most recent failure first. With `ownerThreadId`, only that thread's
   *  workers. */
  listAttention(opts: { limit?: number; unarchivedOnly?: boolean; ownerThreadId?: string } = {}): WorkItem[] {
    const limit = opts.limit ?? 30;
    const owner = opts.ownerThreadId;
    const rows = this.db
      .prepare(
        `select * from work_items
        where failed_at is not null
          ${opts.unarchivedOnly ? `and ${UNARCHIVED_WORK_ITEM_SCOPE}` : ""}
          ${owner !== undefined ? `and ${OWNED_BY("work_items")}` : ""}
        order by failed_at desc, id desc
        limit ?`
      )
      .all(...(owner !== undefined ? [owner] : []), limit) as RawWorkItem[];
    return rows.map((r) => this.toItem(r));
  }

  /**
   * Items that are not finished, that nobody is waiting on, and that nothing
   * will make move. A manager's sweep list.
   *
   * The `not exists` clauses on the worker's thread are the complete set of
   * wake sources other than the user: a wake already running, a pending
   * alarm, an undelivered mailbox event, a pane monitor, a command monitor,
   * a subagent still queued or running (its result wakes the worker). The
   * user is excluded on purpose — waiting for a person to notice is the
   * thing this removes.
   *
   * A worker whose plan asks a question is left out: it waits for the
   * answer, and a list that re-raises it at every sweep gets ignored.
   *
   * Deliberately no time threshold. Stalled is a state, not a duration: every
   * clause below is true the moment the turn ends, so a cutoff would only delay
   * the finding.
   */
  listStalled(opts: { limit?: number; ownerThreadId?: string } = {}): WorkItem[] {
    const limit = opts.limit ?? 30;
    const owner = opts.ownerThreadId;
    const rows = this.db
      .prepare(
        `select w.* from ${STALLED_ALL}
          ${owner !== undefined ? `and ${OWNED_BY("w")}` : ""}
        order by w.last_activity_at asc, w.id asc
        limit ?`
      )
      .all(...(owner !== undefined ? [owner] : []), limit) as RawWorkItem[];
    return rows.map((r) => this.toItem(r));
  }

  /** Whether this one worker is stalled, by listStalled's own rule: asked
   *  at the end of its worker's turn, so a quiet stop is seen at once. */
  isStalled(workerId: string): boolean {
    return this.db.prepare(`select 1 from ${STALLED_ONE} and w.worker_id = ?`).get(workerId) != null;
  }

  /** Items that are alive but not asking for anything (idle). Used by a manager's
   *  wake context as the FYI section. */
  listIdle(opts: { limit?: number; ownerThreadId?: string } = {}): WorkItem[] {
    const limit = opts.limit ?? 20;
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const owner = opts.ownerThreadId;
    const rows = this.db
      .prepare(
        `select * from work_items
        where last_activity_at >= ? and failed_at is null
          ${owner !== undefined ? `and ${OWNED_BY("work_items")}` : ""}
        order by last_activity_at desc
        limit ?`
      )
      .all(cutoff, ...(owner !== undefined ? [owner] : []), limit) as RawWorkItem[];
    return rows.map((r) => this.toItem(r));
  }

  list(
    opts: {
      limit?: number;
      workerId?: string;
      unarchivedOnly?: boolean;
    } = {}
  ): WorkItem[] {
    const where: string[] = opts.unarchivedOnly ? [UNARCHIVED_WORK_ITEM_SCOPE] : [];
    const args: SqlValue[] = [];
    if (opts.workerId !== undefined) {
      where.push("worker_id = ?");
      args.push(opts.workerId);
    }
    const clause = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const limit = opts.limit ?? 100;
    args.push(limit);
    const rows = this.db
      .prepare(`select * from work_items ${clause} order by last_activity_at desc limit ?`)
      .all(...args) as RawWorkItem[];
    return rows.map((r) => this.toItem(r));
  }

  private toItem(row: RawWorkItem): WorkItem {
    return {
      id: row.id,
      workerId: row.worker_id,
      projectId: row.project_id,
      title: row.title,
      lastActivityAt: row.last_activity_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      failedAt: row.failed_at ?? null,
      failedMessage: row.failed_message ?? null,
      failedKind: row.failed_kind === "stopped" || row.failed_kind === "error" ? row.failed_kind : null
    };
  }

  private emitChange(kind: WorkItemChangeKind, item: WorkItem): void {
    this.changes.emit({ kind, workerId: item.workerId, itemId: item.id });
  }
}
