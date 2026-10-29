import type { Database } from "bun:sqlite";
import type { FeatureMode, FeatureOwnership } from "../../../shared/api-contracts.js";
import { newId } from "../../platform/ids.js";
import { WorkItemChangeEmitter } from "../agent/work-item-events.js";
import type { WorkItemChangeListener } from "../agent/work-item-events.js";
export type { FeatureMode } from "../../../shared/api-contracts.js";

export interface FeatureRow {
  id: string;
  projectId: string;
  name: string;
  mode: FeatureMode;
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  tmuxWindowName: string;
  ownership: FeatureOwnership;
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** The manager thread that started this worker; null only for workers
   *  archived before threads existed. */
  ownerThreadId: string | null;
}

interface FeatureInsert {
  projectId: string;
  name: string;
  mode: FeatureMode;
  branch: string | null;
  baseRef?: string | null;
  worktreePath: string | null;
  tmuxWindowName: string;
  ownership: FeatureOwnership;
  ownerThreadId?: string | null;
}

interface RawFeatureRow {
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

function toRow(raw: RawFeatureRow): FeatureRow {
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: raw.name,
    mode: raw.mode as FeatureMode,
    branch: raw.branch,
    baseRef: raw.base_ref,
    worktreePath: raw.worktree_path,
    tmuxWindowName: raw.tmux_window_name,
    ownership: raw.ownership as FeatureOwnership,
    pinnedAt: raw.pinned_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    archivedAt: raw.archived_at,
    ownerThreadId: raw.owner_thread_id ?? null
  };
}

export class FeaturesStore {
  constructor(
    private db: Database,
    private readonly workItemChanges = new WorkItemChangeEmitter()
  ) {}

  onWorkItemChange(listener: WorkItemChangeListener): () => void {
    return this.workItemChanges.onChange(listener);
  }

  insert(input: FeatureInsert): string {
    const id = newId("feat");
    const wiId = newId("wi");
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        insert into features
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
          (id, feature_id, project_id, title,
           last_activity_at, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(wiId, id, input.projectId, input.name, now, now, now);
    }).immediate();
    this.workItemChanges.emit({
      kind: "created",
      featureId: id,
      projectId: input.projectId,
      itemId: wiId,
      at: now
    });
    return id;
  }

  getById(id: string): FeatureRow | null {
    const raw = this.db
      .prepare(
        `
      select id, project_id, name, mode, branch, base_ref, worktree_path,
             tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
      from features where id = ?
    `
      )
      .get(id) as RawFeatureRow | undefined;
    return raw ? toRow(raw) : null;
  }

  listActiveByProject(projectId: string): FeatureRow[] {
    const rows = this.db
      .prepare(
        `
      select id, project_id, name, mode, branch, base_ref, worktree_path,
             tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
      from features
      where project_id = ? and archived_at is null
      order by created_at asc
    `
      )
      .all(projectId) as RawFeatureRow[];
    return rows.map(toRow);
  }

  /** A project's workers, archived ones too, the most recently changed first. */
  listByProject(projectId: string): FeatureRow[] {
    const rows = this.db
      .prepare(
        `
      select id, project_id, name, mode, branch, base_ref, worktree_path,
             tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
      from features
      where project_id = ?
      order by updated_at desc
    `
      )
      .all(projectId) as RawFeatureRow[];
    return rows.map(toRow);
  }

  listAllActive(): FeatureRow[] {
    const rows = this.db
      .prepare(
        `
      select id, project_id, name, mode, branch, base_ref, worktree_path,
             tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
      from features
      where archived_at is null
      order by created_at asc
    `
      )
      .all() as RawFeatureRow[];
    return rows.map(toRow);
  }

  /** Moves a worker to a thread, and announces it as a work-item change so
   *  the new owner's sweep arms (the sweep keys on the worker's owner). */
  setOwner(featureId: string, threadId: string): void {
    this.db.prepare(`update features set owner_thread_id = ? where id = ?`).run(threadId, featureId);
    const item = this.db.prepare(`select id, project_id from work_items where feature_id = ?`)
      .get(featureId) as { id: string; project_id: string } | undefined;
    if (item) {
      this.workItemChanges.emit({
        kind: "updated", featureId, projectId: item.project_id, itemId: item.id, at: new Date().toISOString()
      });
    }
  }

  listActiveOwnedBy(threadId: string): FeatureRow[] {
    const rows = this.db.prepare(
      `select id, project_id, name, mode, branch, base_ref, worktree_path,
              tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
         from features where owner_thread_id = ? and archived_at is null
        order by created_at asc`
    ).all(threadId) as RawFeatureRow[];
    return rows.map(toRow);
  }

  /** A thread's archived workers, most recently archived first. */
  listArchivedOwnedBy(threadId: string): FeatureRow[] {
    const rows = this.db.prepare(
      `select id, project_id, name, mode, branch, base_ref, worktree_path,
              tmux_window_name, ownership, pinned_at, created_at, updated_at, archived_at, owner_thread_id
         from features where owner_thread_id = ? and archived_at is not null
        order by archived_at desc`
    ).all(threadId) as RawFeatureRow[];
    return rows.map(toRow);
  }

  setPinned(id: string, pinned: boolean): void {
    const now = new Date().toISOString();
    if (pinned) {
      this.db
        .prepare(
          `update features set pinned_at = ?, updated_at = ? where id = ? and archived_at is null`
        )
        .run(now, now, id);
    } else {
      this.db
        .prepare(`update features set pinned_at = NULL, updated_at = ? where id = ?`)
        .run(now, id);
    }
  }

  activeNameExists(projectId: string, name: string, excludeFeatureId?: string): boolean {
    const row = this.db
      .prepare(
        `
      select id from features
      where project_id = ? and name = ? and archived_at is null
        and (? is null or id != ?)
      limit 1
    `
      )
      .get(projectId, name, excludeFeatureId ?? null, excludeFeatureId ?? null) as { id: string } | undefined;
    return Boolean(row);
  }

  activeWindowNameExists(projectId: string, tmuxWindowName: string, excludeFeatureId?: string): boolean {
    const row = this.db
      .prepare(
        `
      select id from features
      where project_id = ? and tmux_window_name = ? and archived_at is null
        and (? is null or id != ?)
      limit 1
    `
      )
      .get(projectId, tmuxWindowName, excludeFeatureId ?? null, excludeFeatureId ?? null) as { id: string } | undefined;
    return Boolean(row);
  }

  archive(id: string): void {
    const now = new Date().toISOString();
    const affected = this.workItemsForFeature(id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        update features set archived_at = ?, updated_at = ?, pinned_at = NULL
          where id = ? and archived_at is null
      `
        )
        .run(now, now, id);
      this.db
        .prepare(
          `
        update work_items
          set updated_at = ?, last_activity_at = ?
        where feature_id = ?
      `
        )
        .run(now, now, id);
    }).immediate();
    for (const item of affected) {
      this.workItemChanges.emit({
        kind: "updated",
        featureId: item.featureId,
        projectId: item.projectId,
        itemId: item.itemId,
        at: now
      });
    }
  }

  /** A restore that failed after it rewrote the row: the row as it was
   *  before (still archived, its old owner, window, branch and worktree). */
  undoRestore(original: FeatureRow): void {
    const now = new Date().toISOString();
    const affected = this.workItemsForFeature(original.id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        update features
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
        .prepare(`update work_items set updated_at = ?, last_activity_at = ? where feature_id = ?`)
        .run(now, now, original.id);
    }).immediate();
    for (const item of affected) {
      this.workItemChanges.emit({ kind: "updated", featureId: item.featureId, projectId: item.projectId, itemId: item.itemId, at: now });
    }
  }

  restore(input: {
    id: string;
    mode: FeatureMode;
    branch: string | null;
    baseRef: string | null;
    worktreePath: string | null;
    tmuxWindowName: string;
    /** Its owner from now on, set in the same write: the change this restore
     *  announces reaches the new owner, not the old one. */
    ownerThreadId?: string | null;
  }): void {
    const now = new Date().toISOString();
    const affected = this.workItemsForFeature(input.id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        update features
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
        where feature_id = ?
      `
        )
        .run(now, now, input.id);
    }).immediate();
    for (const item of affected) {
      this.workItemChanges.emit({
        kind: "updated",
        featureId: item.featureId,
        projectId: item.projectId,
        itemId: item.itemId,
        at: now
      });
    }
  }

  // Cascade-archive every active feature of a project. Used when the parent
  // project is archived — without this, archived projects leave their features
  // stranded as "active" rows pointing at a dead parent.
  archiveByProjectId(projectId: string): void {
    const now = new Date().toISOString();
    const affected = this.workItemsForProject(projectId);
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        update features set archived_at = ?, updated_at = ? where project_id = ? and archived_at is null
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
        featureId: item.featureId,
        projectId: item.projectId,
        itemId: item.itemId,
        at: now
      });
    }
  }

  takenWindowNames(projectId: string): Set<string> {
    const rows = this.db
      .prepare(
        `
      select tmux_window_name from features
      where project_id = ? and archived_at is null
    `
      )
      .all(projectId) as Array<{ tmux_window_name: string }>;
    return new Set(rows.map((r) => r.tmux_window_name));
  }

  private workItemsForFeature(featureId: string): Array<{
    itemId: string;
    featureId: string;
    projectId: string;
  }> {
    const rows = this.db
      .prepare(
        `
      select id, feature_id, project_id from work_items where feature_id = ?
    `
      )
      .all(featureId) as Array<{ id: string; feature_id: string; project_id: string }>;
    return rows.map((row) => ({
      itemId: row.id,
      featureId: row.feature_id,
      projectId: row.project_id
    }));
  }

  private workItemsForProject(projectId: string): Array<{
    itemId: string;
    featureId: string;
    projectId: string;
  }> {
    const rows = this.db
      .prepare(
        `
      select id, feature_id, project_id from work_items where project_id = ?
    `
      )
      .all(projectId) as Array<{ id: string; feature_id: string; project_id: string }>;
    return rows.map((row) => ({
      itemId: row.id,
      featureId: row.feature_id,
      projectId: row.project_id
    }));
  }
}
