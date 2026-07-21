import type { Database } from "bun:sqlite";
import type { ProjectOwnership } from "../../../shared/api-contracts.js";
import { newId } from "../../platform/ids.js";

export interface ProjectRow {
  id: string;
  name: string;
  workingDir: string;
  isGit: boolean;
  gitRemote: string | null;
  tmuxSessionName: string;
  ownership: ProjectOwnership;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectInsert {
  name: string;
  workingDir: string;
  isGit: boolean;
  gitRemote: string | null;
  tmuxSessionName: string;
  ownership: ProjectOwnership;
}

interface RawProjectRow {
  id: string;
  name: string;
  working_dir: string;
  is_git: number;
  git_remote: string | null;
  tmux_session_name: string;
  ownership: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toRow(raw: RawProjectRow): ProjectRow {
  return {
    id: raw.id,
    name: raw.name,
    workingDir: raw.working_dir,
    isGit: raw.is_git === 1,
    gitRemote: raw.git_remote,
    tmuxSessionName: raw.tmux_session_name,
    ownership: raw.ownership as ProjectOwnership,
    sortOrder: raw.sort_order,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    archivedAt: raw.archived_at
  };
}

export class ProjectsStore {
  constructor(private db: Database) {}

  insert(input: ProjectInsert): string {
    const id = newId("proj");
    const now = new Date().toISOString();
    const sortOrder = this.nextSortOrderForNewProject();
    this.db.prepare(`
      insert into projects
        (id, name, working_dir, is_git, git_remote, tmux_session_name, ownership, sort_order, created_at, updated_at)
      values
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.workingDir,
      input.isGit ? 1 : 0, input.gitRemote, input.tmuxSessionName,
      input.ownership, sortOrder, now, now
    );
    return id;
  }

  getById(id: string): ProjectRow | null {
    const raw = this.db.prepare(`
      select id, name, working_dir, is_git, git_remote, tmux_session_name,
             ownership, sort_order, created_at, updated_at, archived_at
      from projects
      where id = ?
    `).get(id) as RawProjectRow | undefined;
    return raw ? toRow(raw) : null;
  }

  listActive(): ProjectRow[] {
    const rows = this.db.prepare(`
      select id, name, working_dir, is_git, git_remote, tmux_session_name,
             ownership, sort_order, created_at, updated_at, archived_at
      from projects
      where archived_at is null
      order by sort_order asc, created_at asc
    `).all() as RawProjectRow[];
    return rows.map(toRow);
  }

  getActiveByTmuxSessionName(sessionName: string): ProjectRow | null {
    const raw = this.db.prepare(`
      select id, name, working_dir, is_git, git_remote, tmux_session_name,
             ownership, sort_order, created_at, updated_at, archived_at
      from projects
      where tmux_session_name = ? and archived_at is null
      limit 1
    `).get(sessionName) as RawProjectRow | undefined;
    return raw ? toRow(raw) : null;
  }

  reorderActive(projectIds: string[]): ProjectRow[] | { error: string } {
    const current = this.listActive();
    const currentIds = current.map((project) => project.id);
    const uniqueIds = new Set(projectIds);
    if (projectIds.length !== uniqueIds.size) return { error: "projectIds must be unique" };
    if (projectIds.length !== currentIds.length) return { error: "projectIds must include every active project" };
    for (const id of currentIds) {
      if (!uniqueIds.has(id)) return { error: "projectIds must include every active project" };
    }

    const now = new Date().toISOString();
    const update = this.db.prepare(`
      update projects set sort_order = ?, updated_at = ? where id = ? and archived_at is null
    `);
    const tx = this.db.transaction((ids: string[]) => {
      ids.forEach((id, index) => update.run(index * 1000, now, id));
    });
    tx(projectIds);
    return this.listActive();
  }

  /**
   * Archiving a project takes its memories with it.
   *
   * There is no restore for a project, and recall is scoped by `project_id`
   * (`memory/local-provider-helpers.ts`), so once the project is gone its
   * project- and feature-scoped memories can never surface again — re-adding
   * the same directory mints a new id, so they do not come back that way
   * either. Left available they still cost: they count in every figure the
   * Memory page reports, and `listDreamProjectIds` groups by `project_id`
   * without joining `projects`, so maintenance keeps opening a dream partition
   * for a project that no longer exists.
   *
   * Archived rather than deleted, because `memory_entries.status` already has
   * the state and Browse can still read it. Nothing reaps these rows — see the
   * retention note in `platform/db/retention.ts`, which prunes only
   * `agent_messages`.
   *
   * Writing another module's table from here follows what
   * `FeaturesStore.archiveByProjectId` already does with `work_items`: the
   * cascade belongs on the one statement both the route and the tool go
   * through, and this is it.
   */
  archive(id: string): void {
    const now = new Date().toISOString();
    this.db.exec("begin immediate");
    try {
      this.db.prepare(`
        update projects set archived_at = ?, updated_at = ? where id = ? and archived_at is null
      `).run(now, now, id);
      this.db.prepare(`
        update memory_entries
           set status = 'archived',
               updated_at = ?,
               -- json_extract raises on malformed JSON rather than returning
               -- null, so the reason is only written where there is valid JSON
               -- to write it into.
               metadata_json = case
                 when json_valid(metadata_json)
                   then json_set(metadata_json, '$.archivedReason', 'project_archived')
                 else json_object('archivedReason', 'project_archived')
               end
         where project_id = ?
           and scope in ('project','feature')
           and status = 'available'
      `).run(now, id);
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
  }

  takenTmuxSessionNames(): Set<string> {
    const rows = this.db.prepare(`
      select tmux_session_name from projects where archived_at is null
    `).all() as Array<{ tmux_session_name: string }>;
    return new Set(rows.map((r) => r.tmux_session_name));
  }

  private nextSortOrderForNewProject(): number {
    const row = this.db.prepare(`
      select min(sort_order) as min_order from projects where archived_at is null
    `).get() as { min_order: number | null } | undefined;
    return row?.min_order === null || row?.min_order === undefined ? 0 : row.min_order - 1000;
  }
}
