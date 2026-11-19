import type { Database } from "bun:sqlite";
import type { WorkerMode, WorkerOwnership } from "../../../shared/api-contracts.js";
import { newId } from "../../platform/ids.js";
import { WorkItemChangeEmitter } from "../agent/work-item-events.js";
import type { WorkItemChangeListener } from "../agent/work-item-events.js";
export type { WorkerMode } from "../../../shared/api-contracts.js";

export interface WorkerRow {
  id: string;
  projectId: string;
  name: string;
  mode: WorkerMode;
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  tmuxWindowName: string;
  ownership: WorkerOwnership;
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** The manager thread that started this worker; null only between a
   *  create's row and the owner it gives it. */
  ownerThreadId: string | null;
}

interface WorkerInsert {
  projectId: string;
  name: string;
  mode: WorkerMode;
  branch: string | null;
  baseRef?: string | null;
  worktreePath: string | null;
  tmuxWindowName: string;
  ownership: WorkerOwnership;
  ownerThreadId?: string | null;
}

interface RawWorkerRow {
  id: string;
  project_id: string;
  name: string;
  mode: string;
  branch: string | null;
  base_ref: string | null;
  worktree_path: string | null;
  tmux_window_name: string;
  ownership: string;
  pinned_at: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  owner_thread_id: string | null;
}

function toRow(raw: RawWorkerRow): WorkerRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: raw.name,
    mode: raw.mode as WorkerMode,
    branch: raw.branch,
    baseRef: raw.base_ref,
    worktreePath: raw.worktree_path,
    tmuxWindowName: raw.tmux_window_name,
    ownership: raw.ownership as WorkerOwnership,
    pinnedAt: raw.pinned_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    archivedAt: raw.archived_at,
    ownerThreadId: raw.owner_thread_id ?? null
  };
}

/** A worker that joined a thread: `from` is null when it had none (a worker
 *  made for the thread). */
export interface WorkerOwnerChange {
  workerId: string;
  from: string | null;
  to: string;
}

export class WorkersStore {
  private readonly ownerListeners = new Set<(change: WorkerOwnerChange) => void>();

  constructor(
    private db: Database,
    private readonly workItemChanges = new WorkItemChangeEmitter()
  ) {}

  /** Told after a worker joins a thread: made for it, or moved to it from
   *  another. Returns the unsubscribe. */
  onOwnerChange(listener: (change: WorkerOwnerChange) => void): () => void {
    this.ownerListeners.add(listener);
    return () => { this.ownerListeners.delete(listener); };
  }

  private ownerOf(workerId: string): string | null {
    const row = this.db.prepare(`select owner_thread_id from workers where id = ?`).get(workerId) as { owner_thread_id: string | null } | null;
    return row?.owner_thread_id ?? null;
  }

  private tellMove(workerId: string, from: string | null, to: string | null): void {
    if (!to || from === to) return;
    for (const listener of [...this.ownerListeners]) {
      try {
        listener({ workerId, from, to });
      } catch {
        // Best-effort, as work-item changes are: the move is already written.
      }
    }
  }

  onWorkItemChange(listener: WorkItemChangeListener): () => void {
    return this.workItemChanges.onChange(listener);
  }

  insert(input: WorkerInsert): string {
    const id = newId("wkr");
    const wiId = newId("wi");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        insert into workers
          (id, project_id, name, mode, branch, base_ref, worktree_path, tmux_window_name, ownership, created_at, updated_at, owner_thread_id)
        values
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          id,
          input.projectId,
          input.name,
          input.mode,
          input.branch,
          input.baseRef ?? null,
          input.worktreePath,
          input.tmuxWindowName,
          input.ownership,
          now,
          now,
          input.ownerThreadId ?? null
        );
      this.db
        .prepare(
          `
        insert into work_items
          (id, worker_id, project_id, title,
           last_activity_at, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(wiId, id, input.projectId, input.name, now, now, now);
    }).immediate();
    this.workItemChanges.emit({
      kind: "created",
      workerId: id,
      itemId: wiId
    });
    this.tellMove(id, null, input.ownerThreadId ?? null);
    return id;
  }

  getById(id: string): WorkerRow | null {
    const raw = this.db
      .prepare(
        `
      select id, project_id, name, mode, branch, base_ref, worktree_path,
             tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
      from workers where id = ?
    `
      )
      .get(id) as RawWorkerRow | undefined;
    return raw ? toRow(raw) : null;
  }

  listActiveByProject(projectId: string): WorkerRow[] {
    const rows = this.db
      .prepare(
        `
      select id, project_id, name, mode, branch, base_ref, worktree_path,
             tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
      from workers
      where project_id = ? and archived_at is null
      order by created_at asc
    `
      )
      .all(projectId) as RawWorkerRow[];
    return rows.map(toRow);
  }

  /** A project's workers, archived ones too, the most recently changed first. */
  listByProject(projectId: string): WorkerRow[] {
    const rows = this.db
      .prepare(
        `
      select id, project_id, name, mode, branch, base_ref, worktree_path,
             tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
      from workers
      where project_id = ?
      order by updated_at desc
    `
      )
      .all(projectId) as RawWorkerRow[];
    return rows.map(toRow);
  }

  listAllActive(): WorkerRow[] {
    const rows = this.db
      .prepare(
        `
      select id, project_id, name, mode, branch, base_ref, worktree_path,
             tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
      from workers
      where archived_at is null
      order by created_at asc
    `
      )
      .all() as RawWorkerRow[];
    return rows.map(toRow);
  }

  /** Moves a worker to a thread, and announces it as a work-item change so
   *  the new owner's sweep arms (the sweep keys on the worker's owner). */
  setOwner(workerId: string, threadId: string): void {
    const from = this.ownerOf(workerId);
    this.db.prepare(`update workers set owner_thread_id = ? where id = ?`).run(threadId, workerId);
    const item = this.db.prepare(`select id, project_id from work_items where worker_id = ?`)
      .get(workerId) as { id: string; project_id: string } | undefined;
    if (item) {
      this.workItemChanges.emit({
        kind: "updated", workerId, itemId: item.id
      });
    }
    this.tellMove(workerId, from, threadId);
  }

  listActiveOwnedBy(threadId: string): WorkerRow[] {
    const rows = this.db.prepare(
      `select id, project_id, name, mode, branch, base_ref, worktree_path,
              tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
         from workers where owner_thread_id = ? and archived_at is null
        order by created_at asc`
    ).all(threadId) as RawWorkerRow[];
    return rows.map(toRow);
  }

  /** A thread's archived workers, most recently archived first. */
  listArchivedOwnedBy(threadId: string): WorkerRow[] {
    const rows = this.db.prepare(
      `select id, project_id, name, mode, branch, base_ref, worktree_path,
              tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
         from workers where owner_thread_id = ? and archived_at is not null
        order by archived_at desc`
    ).all(threadId) as RawWorkerRow[];
    return rows.map(toRow);
  }

  setPinned(id: string, pinned: boolean): void {
    const now = new Date().toISOString();
    if (pinned) {
      this.db
        .prepare(
          `update workers set pinned_at = ?, updated_at = ? where id = ? and archived_at is null`
        )
        .run(now, now, id);
    } else {
      this.db
        .prepare(`update workers set pinned_at = NULL, updated_at = ? where id = ?`)
        .run(now, id);
    }
  }

  activeNameExists(projectId: string, name: string, excludeWorkerId?: string): boolean {
    const row = this.db
      .prepare(
        `
      select id from workers
      where project_id = ? and name = ? and archived_at is null
        and (? is null or id != ?)
      limit 1
    `
      )
      .get(projectId, name, excludeWorkerId ?? null, excludeWorkerId ?? null) as { id: string } | undefined;
    return Boolean(row);
  }

  activeWindowNameExists(projectId: string, tmuxWindowName: string, excludeWorkerId?: string): boolean {
    const row = this.db
      .prepare(
        `
      select id from workers
      where project_id = ? and tmux_window_name = ? and archived_at is null
        and (? is null or id != ?)
      limit 1
    `
      )
      .get(projectId, tmuxWindowName, excludeWorkerId ?? null, excludeWorkerId ?? null) as { id: string } | undefined;
    return Boolean(row);
  }

  archive(id: string): void {
    const now = new Date().toISOString();
    const affected = this.workItemsForWorker(id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        update workers set archived_at = ?, updated_at = ?, pinned_at = NULL
          where id = ? and archived_at is null
      `
        )
        .run(now, now, id);
      this.db
        .prepare(
          `
        update work_items
          set updated_at = ?, last_activity_at = ?
        where worker_id = ?
      `
        )
        .run(now, now, id);
    }).immediate();
    for (const item of affected) {
      this.workItemChanges.emit({
        kind: "updated",
        workerId: item.workerId,
        itemId: item.itemId
      });
    }
  }

  /** A restore that failed after it rewrote the row: the row as it was
   *  before (still archived, its old owner, window, branch and worktree). */
  undoRestore(original: WorkerRow): void {
    const now = new Date().toISOString();
    const affected = this.workItemsForWorker(original.id);
    const from = this.ownerOf(original.id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        update workers
           set archived_at = ?, updated_at = ?, pinned_at = NULL, mode = ?, branch = ?, base_ref = ?,
               worktree_path = ?, tmux_window_name = ?, owner_thread_id = ?
         where id = ?
      `
        )
        .run(
          original.archivedAt,
          now,
          original.mode,
          original.branch,
          original.baseRef,
          original.worktreePath,
          original.tmuxWindowName,
          original.ownerThreadId,
          original.id
        );
      this.db
        .prepare(`update work_items set updated_at = ?, last_activity_at = ? where worker_id = ?`)
        .run(now, now, original.id);
    }).immediate();
    for (const item of affected) {
      this.workItemChanges.emit({ kind: "updated", workerId: item.workerId, itemId: item.itemId });
    }
    this.tellMove(original.id, from, this.ownerOf(original.id));
  }

  restore(input: {
    id: string;
    mode: WorkerMode;
    branch: string | null;
    baseRef: string | null;
    worktreePath: string | null;
    tmuxWindowName: string;
    /** Its owner from now on, set in the same write: the change this restore
     *  announces reaches the new owner, not the old one. */
    ownerThreadId?: string | null;
  }): void {
    const now = new Date().toISOString();
    const affected = this.workItemsForWorker(input.id);
    const from = this.ownerOf(input.id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        update workers
           set archived_at = NULL,
               updated_at = ?,
               mode = ?,
               branch = ?,
               base_ref = ?,
               worktree_path = ?,
               tmux_window_name = ?,
               owner_thread_id = coalesce(?, owner_thread_id)
         where id = ? and archived_at is not null
      `
        )
        .run(
          now,
          input.mode,
          input.branch,
          input.baseRef,
          input.worktreePath,
          input.tmuxWindowName,
          input.ownerThreadId ?? null,
          input.id
        );
      this.db
        .prepare(
          `
        update work_items
          set updated_at = ?, last_activity_at = ?
        where worker_id = ?
      `
        )
        .run(now, now, input.id);
    }).immediate();
    for (const item of affected) {
      this.workItemChanges.emit({
        kind: "updated",
        workerId: item.workerId,
        itemId: item.itemId
      });
    }
    this.tellMove(input.id, from, this.ownerOf(input.id));
  }

  // Cascade-archive every active worker of a project. Used when the parent
  // project is archived — without this, archived projects leave their workers
  // stranded as "active" rows pointing at a dead parent.
  archiveByProjectId(projectId: string): void {
    const now = new Date().toISOString();
    const affected = this.workItemsForProject(projectId);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        update workers set archived_at = ?, updated_at = ? where project_id = ? and archived_at is null
      `
        )
        .run(now, now, projectId);
      this.db
        .prepare(
          `
        update work_items
          set updated_at = ?, last_activity_at = ?
        where project_id = ?
      `
        )
        .run(now, now, projectId);
    }).immediate();
    for (const item of affected) {
      this.workItemChanges.emit({
        kind: "updated",
        workerId: item.workerId,
        itemId: item.itemId
      });
    }
  }

  takenWindowNames(projectId: string): Set<string> {
    const rows = this.db
      .prepare(
        `
      select tmux_window_name from workers
      where project_id = ? and archived_at is null
    `
      )
      .all(projectId) as Array<{ tmux_window_name: string }>;
    return new Set(rows.map((r) => r.tmux_window_name));
  }

  private workItemsForWorker(workerId: string): Array<{
    itemId: string;
    workerId: string;
    projectId: string;
  }> {
    const rows = this.db
      .prepare(
        `
      select id, worker_id, project_id from work_items where worker_id = ?
    `
      )
      .all(workerId) as Array<{ id: string; worker_id: string; project_id: string }>;
    return rows.map((row) => ({
      itemId: row.id,
      workerId: row.worker_id,
      projectId: row.project_id
    }));
  }

  private workItemsForProject(projectId: string): Array<{
    itemId: string;
    workerId: string;
    projectId: string;
  }> {
    const rows = this.db
      .prepare(
        `
      select id, worker_id, project_id from work_items where project_id = ?
    `
      )
      .all(projectId) as Array<{ id: string; worker_id: string; project_id: string }>;
    return rows.map((row) => ({
      itemId: row.id,
      workerId: row.worker_id,
      projectId: row.project_id
    }));
  }
}
