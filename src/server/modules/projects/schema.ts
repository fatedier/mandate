import type { Database } from "bun:sqlite";
import { ensureColumn } from "../../platform/db/ensure-column.js";

export function initializeProjectsSchema(db: Database): void {
  db.exec(`
    create table if not exists projects (
      id                 text primary key,
      name               text not null,
      working_dir        text not null,
      is_git             integer not null default 0,
      git_remote         text,
      tmux_session_name  text not null,
      ownership          text not null check (ownership in ('app','adopted')),
      sort_order         integer not null default 0,
      created_at         text not null,
      updated_at         text not null,
      archived_at        text
    )
  `);
  ensureColumn(db, "projects", "sort_order", "integer not null default 0");
  db.exec(`
    create index if not exists idx_projects_active
      on projects (archived_at)
      where archived_at is null
  `);
  db.exec(`
    create unique index if not exists idx_projects_active_name
      on projects (name) where archived_at is null
  `);
  db.exec(`
    create unique index if not exists idx_projects_active_session_name
      on projects (tmux_session_name) where archived_at is null
  `);
}
