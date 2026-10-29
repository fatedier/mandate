import type { Database } from "bun:sqlite";

export function initializeFeaturesSchema(db: Database): void {
  db.exec(`
    create table if not exists features (
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
      -- foreign key: threads are archived, never deleted, and the features
      -- schema initialises before the agent schema.
      owner_thread_id     text
    )
  `);
  db.exec(`
    create unique index if not exists idx_features_active_window
      on features (project_id, tmux_window_name)
      where archived_at is null
  `);
  db.exec(`
    create unique index if not exists idx_features_active_name
      on features (project_id, name) where archived_at is null
  `);
}
