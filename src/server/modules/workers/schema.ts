import type { Database } from "bun:sqlite";

export function initializeWorkersSchema(db: Database): void {
  db.exec(`
    create table if not exists workers (
      id                  text primary key,
      project_id          text not null references projects(id) on delete cascade,
      name                text not null,
      mode                text not null check (mode in (
                            'new-branch-new-worktree',
                            'existing-branch-new-worktree',
                            'shared-cwd',
                            'existing-branch-existing-worktree'
                          )),
      branch              text,
      base_ref            text,
      worktree_path       text,
      tmux_window_name    text not null,
      ownership           text not null check (ownership in ('app','adopted')),
      created_at          text not null,
      updated_at          text not null,
      archived_at         text,
      pinned_at           text,
      -- The manager thread that started this worker. Plain text, not a
      -- foreign key: the workers schema initialises before the agent schema.
      owner_thread_id     text
    )
  `);
  db.exec(`
    create unique index if not exists idx_workers_active_window
      on workers (project_id, tmux_window_name)
      where archived_at is null
  `);
  db.exec(`
    create unique index if not exists idx_workers_active_name
      on workers (project_id, name) where archived_at is null
  `);
  // A thread's workers, active or archived: archived rows are kept, so this
  // must not be a walk of every worker.
  db.exec(`
    create index if not exists idx_workers_owner
      on workers (owner_thread_id, archived_at)
  `);
}
