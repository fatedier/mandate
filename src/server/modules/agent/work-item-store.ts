import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import { WorkItemChangeEmitter } from "./work-item-events.js";
import type { WorkItemChangeKind, WorkItemChangeListener } from "./work-item-events.js";

/** What the work_item is currently asking from the user. Null = nothing.
 *  `review` = user should glance and verify a completion.
 *  `input`  = agent is waiting for a decision / clarification / approval.
 *
 *  Set indirectly:
 *  - task_complete on an overview-dispatched task → null → 'review'
 *  - update_my_work_item({ phase: 'done' })      → null → 'review'
 *  - task_notify_caller(blocked|needs_user)     → ?    → 'input'
 *  - direct user message to the feature thread   → 'review' → null
 *  - overview's update_work_item                → any  → any
 *  - user dismisses the prompt in UI            → null
 *
 *  Lifecycle (alive vs done) lives on the feature itself (features.archived_at).
 *  When a feature is archived, its work_item disappears from the dashboard too. */
export type WorkItemNeedsUser = "review" | "input" | null;

export const WORK_ITEM_NEEDS_USER_VALUES = ["review", "input"] as const;
export const WORK_ITEM_SUMMARY_MAX_CHARS = 500;

/** Who last wrote `summary`. Two agents can write the same field —
 *  `update_my_work_item` (feature agent) and `update_work_item` (overview) —
 *  so the reader needs the writer's identity rather than an assumption.
 *  Taken from the calling tool's scope, never from the UI. */
export const WORK_ITEM_SUMMARY_AUTHORS = ["worker", "manager"] as const;
export type WorkItemSummaryAuthor = typeof WORK_ITEM_SUMMARY_AUTHORS[number];

function summaryAuthorFromRow(value: string | null): WorkItemSummaryAuthor | null {
  return (WORK_ITEM_SUMMARY_AUTHORS as readonly string[]).includes(value ?? "")
    ? (value as WorkItemSummaryAuthor)
    : null;
}

export type WorkItemPhase = "design" | "working" | "verifying" | "done";

export const WORK_ITEM_PHASES: readonly WorkItemPhase[] = [
  "design",
  "working",
  "verifying",
  "done"
] as const;

export interface WorkItem {
  id: string;
  featureId: string;
  projectId: string;
  title: string;
  summary: string | null;
  canvasId: string | null;
  needsUser: WorkItemNeedsUser;
  phase: WorkItemPhase;
  phaseDetail: string | null;
  /** When `summary`'s text last actually changed. Null when there is no
   *  summary, or the row predates the column. NOT a freshness verdict —
   *  it is the write time and nothing more. */
  summaryUpdatedAt: string | null;
  summaryUpdatedBy: WorkItemSummaryAuthor | null;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkItemInput {
  featureId: string;
  projectId: string;
  title: string;
  needsUser?: WorkItemNeedsUser;
  phase?: WorkItemPhase;
  phaseDetail?: string | null;
}

export interface UpdateWorkItemPatch {
  title?: string;
  summary?: string | null;
  /** Identity of the writer, recorded only when `summary`'s text actually
   *  changes. Optional so pre-existing callers that never touch summary (and
   *  older ones that do) keep compiling; when absent the author is stored as
   *  NULL rather than guessed. */
  summaryBy?: WorkItemSummaryAuthor;
  canvasId?: string | null;
  needsUser?: WorkItemNeedsUser;
  phase?: WorkItemPhase;
  phaseDetail?: string | null;
}

interface RawWorkItem {
  id: string;
  feature_id: string;
  project_id: string;
  title: string;
  summary: string | null;
  canvas_id: string | null;
  needs_user: WorkItemNeedsUser;
  phase: string;
  phase_detail: string | null;
  summary_updated_at: string | null;
  summary_updated_by: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

// HTTP lists follow the same project/feature membership as the dashboard.
// Internal history readers and direct item lookups can still see archived work.
const UNARCHIVED_WORK_ITEM_SCOPE = `exists (
  select 1 from features f
  join projects p on p.id = f.project_id
  where f.id = work_items.feature_id and f.project_id = work_items.project_id
    and f.archived_at is null and p.archived_at is null
)`;

export class WorkItemStore {
  constructor(
    private readonly db: Database,
    private readonly changes = new WorkItemChangeEmitter()
  ) {}

  onChange(listener: WorkItemChangeListener): () => void {
    return this.changes.onChange(listener);
  }

  create(input: CreateWorkItemInput): WorkItem {
    const id = newId("wi");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `insert into work_items
        (id, feature_id, project_id, title, needs_user, phase, phase_detail,
         last_activity_at, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.featureId,
        input.projectId,
        input.title,
        input.needsUser ?? null,
        input.phase ?? "design",
        input.phaseDetail ?? null,
        now,
        now,
        now
      );
    const item = this.get(id)!;
    this.emitChange("created", item, null);
    return item;
  }

  get(id: string): WorkItem | null {
    const row = this.db.prepare(`select * from work_items where id = ?`).get(id) as
      | RawWorkItem
      | undefined;
    return row ? this.toItem(row) : null;
  }

  getByFeature(featureId: string): WorkItem | null {
    const row = this.db.prepare(`select * from work_items where feature_id = ?`).get(featureId) as
      | RawWorkItem
      | undefined;
    return row ? this.toItem(row) : null;
  }

  update(id: string, patch: UpdateWorkItemPatch): WorkItem | null {
    const cur = this.get(id);
    if (!cur) return null;
    const now = new Date().toISOString();
    const summaryValue =
      patch.summary === undefined
        ? cur.summary
        : patch.summary === null
          ? null
          : patch.summary.slice(0, WORK_ITEM_SUMMARY_MAX_CHARS);
    // The provenance pair moves only when the stored text differs. Rewriting
    // the identical summary, or patching title/canvas/phase/phaseDetail/
    // needsUser, leaves it exactly where it was — that is the whole point of
    // keeping it out of last_activity_at.
    const summaryChanged = summaryValue !== cur.summary;
    const summaryMeta = !summaryChanged
      ? { at: cur.summaryUpdatedAt, by: cur.summaryUpdatedBy }
      : summaryValue === null
        // Clearing the summary clears its provenance: metadata describes a
        // text that no longer exists.
        ? { at: null, by: null }
        : { at: now, by: patch.summaryBy ?? null };
    const next = {
      title: patch.title ?? cur.title,
      summary: summaryValue,
      canvas_id: patch.canvasId !== undefined ? patch.canvasId : cur.canvasId,
      phase: patch.phase ?? cur.phase,
      phase_detail: patch.phaseDetail !== undefined ? patch.phaseDetail : cur.phaseDetail,
      needs_user: patch.needsUser !== undefined ? patch.needsUser : cur.needsUser,
      summary_updated_at: summaryMeta.at,
      summary_updated_by: summaryMeta.by
    };
    this.db
      .prepare(
        `update work_items
         set title = ?, summary = ?, canvas_id = ?,
             needs_user = ?, phase = ?, phase_detail = ?,
             summary_updated_at = ?, summary_updated_by = ?,
             updated_at = ?, last_activity_at = ?
       where id = ?`
      )
      .run(
        next.title,
        next.summary,
        next.canvas_id,
        next.needs_user,
        next.phase,
        next.phase_detail,
        next.summary_updated_at,
        next.summary_updated_by,
        now,
        now,
        id
      );
    const item = this.get(id);
    if (item) this.emitChange("updated", item, cur);
    return item;
  }

  /** Items asking for the user's attention right now. */
  listAttention(opts: { limit?: number; unarchivedOnly?: boolean } = {}): WorkItem[] {
    const limit = opts.limit ?? 30;
    const rows = this.db
      .prepare(
        `select * from work_items
        where needs_user is not null
          ${opts.unarchivedOnly ? `and ${UNARCHIVED_WORK_ITEM_SCOPE}` : ""}
        order by case needs_user when 'input' then 0 else 1 end,
                 last_activity_at desc
        limit ?`
      )
      .all(limit) as RawWorkItem[];
    return rows.map((r) => this.toItem(r));
  }

  /**
   * Items that are not finished, that nobody is waiting on, and that nothing
   * will make move. The overview sweep's list.
   *
   * The four `not exists` clauses are the complete set of wake sources other
   * than the user: a wake already running, a pending alarm, an undelivered
   * mailbox event, a window watch. The user is excluded on purpose — waiting
   * for a person to notice is the thing this removes.
   *
   * `needs_user is null` is load-bearing rather than tidy. Without it the sweep
   * re-raises what the agent already escalated, every 30 minutes, and a list
   * that repeats itself is a list that gets ignored.
   *
   * Deliberately no time threshold. Stalled is a state, not a duration: every
   * clause below is true the moment the turn ends, so a cutoff would only delay
   * the finding.
   */
  listStalled(opts: { limit?: number } = {}): WorkItem[] {
    const limit = opts.limit ?? 30;
    const rows = this.db
      .prepare(
        `select w.* from work_items w
        join features f on f.id = w.feature_id and f.archived_at is null
        join agent_threads t
          on t.scope = 'worker' and t.scope_id = w.feature_id and t.archived_at is null
        where w.phase <> 'done'
          and w.needs_user is null
          and not exists (select 1 from agent_wakes a
                          where a.thread_id = t.id and a.finished_at is null)
          and not exists (select 1 from agent_alarms al
                          where al.thread_id = t.id and al.status = 'pending')
          and not exists (select 1 from agent_mailbox m
                          where m.thread_id = t.id and m.delivered_at is null)
          and not exists (select 1 from agent_window_watches ww
                          where ww.thread_id = t.id)
        order by w.last_activity_at asc, w.id asc
        limit ?`
      )
      .all(limit) as RawWorkItem[];
    return rows.map((r) => this.toItem(r));
  }

  /** Items that are alive but not asking for anything (idle). Used by overview's
   *  wake context as the FYI section. */
  listIdle(opts: { limit?: number; sinceMs?: number } = {}): WorkItem[] {
    const limit = opts.limit ?? 20;
    const cutoff = new Date(Date.now() - (opts.sinceMs ?? 24 * 60 * 60 * 1000)).toISOString();
    const rows = this.db
      .prepare(
        `select * from work_items
        where needs_user is null and last_activity_at >= ?
        order by last_activity_at desc
        limit ?`
      )
      .all(cutoff, limit) as RawWorkItem[];
    return rows.map((r) => this.toItem(r));
  }

  list(
    opts: {
      needsUser?: WorkItemNeedsUser | "any";
      limit?: number;
      before?: string;
      featureId?: string;
      unarchivedOnly?: boolean;
    } = {}
  ): WorkItem[] {
    const where: string[] = opts.unarchivedOnly ? [UNARCHIVED_WORK_ITEM_SCOPE] : [];
    const args: unknown[] = [];
    if (opts.featureId !== undefined) {
      where.push("feature_id = ?");
      args.push(opts.featureId);
    }
    if (opts.needsUser !== undefined && opts.needsUser !== "any") {
      if (opts.needsUser === null) {
        where.push("needs_user is null");
      } else {
        where.push("needs_user = ?");
        args.push(opts.needsUser);
      }
    }
    if (opts.before) {
      where.push("last_activity_at < ?");
      args.push(opts.before);
    }
    const clause = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const limit = opts.limit ?? 100;
    args.push(limit);
    const rows = this.db
      .prepare(`select * from work_items ${clause} order by last_activity_at desc limit ?`)
      .all(...args) as RawWorkItem[];
    return rows.map((r) => this.toItem(r));
  }

  deleteByFeature(featureId: string): void {
    const cur = this.getByFeature(featureId);
    this.db.prepare(`delete from work_items where feature_id = ?`).run(featureId);
    if (cur) this.emitChange("deleted", cur, cur);
  }

  setCanvasIdForFeature(featureId: string, canvasId: string | null): boolean {
    const cur = this.getByFeature(featureId);
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `update work_items
         set canvas_id = ?, updated_at = ?, last_activity_at = ?
       where feature_id = ?`
      )
      .run(canvasId, now, now, featureId);
    if (result.changes > 0) {
      const item = this.getByFeature(featureId);
      if (item) this.emitChange("updated", item, cur);
    }
    return result.changes > 0;
  }

  private toItem(row: RawWorkItem): WorkItem {
    return {
      id: row.id,
      featureId: row.feature_id,
      projectId: row.project_id,
      title: row.title,
      summary: row.summary,
      canvasId: row.canvas_id,
      needsUser: row.needs_user,
      phase: workItemPhaseFromRow(row.phase),
      phaseDetail: row.phase_detail,
      // `?? null` rather than a direct read: a database migrated from before
      // these columns existed answers `undefined` for them on rows selected
      // with `select *` prior to the ALTER landing in the same process.
      summaryUpdatedAt: row.summary_updated_at ?? null,
      summaryUpdatedBy: summaryAuthorFromRow(row.summary_updated_by ?? null),
      lastActivityAt: row.last_activity_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private emitChange(
    kind: WorkItemChangeKind,
    item: WorkItem,
    previous: WorkItem | null
  ): void {
    this.changes.emit({
      kind,
      featureId: item.featureId,
      projectId: item.projectId,
      itemId: item.id,
      item,
      ...(previous ? { previous } : {}),
      at: new Date().toISOString()
    });
  }
}

function workItemPhaseFromRow(value: string): WorkItemPhase {
  switch (value) {
    case "design":
    case "working":
    case "verifying":
    case "done":
      return value;
    default:
      return "working";
  }
}
