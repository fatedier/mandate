import type { Database } from "bun:sqlite";
import { ensureColumn } from "../../platform/db/ensure-column.js";

export function initializeCanvasSchema(db: Database): void {
  db.exec(`
    create table if not exists canvas_documents (
      id          text primary key,
      title       text not null,
      html        text not null,
      scope       text not null check (scope in ('manager','worker')),
      scope_id    text,
      project_id  text,
      file_path   text,
      thread_id   text not null,
      created_at  text not null,
      updated_at  text not null,
      content_revision integer not null default 0
    )
  `);
  ensureColumn(db, "canvas_documents", "project_id", "text");
  ensureColumn(db, "canvas_documents", "file_path", "text");
  ensureColumn(db, "canvas_documents", "content_revision", "integer not null default 0");
  db.exec(`
    create index if not exists idx_canvas_documents_thread_updated
      on canvas_documents(thread_id, updated_at desc)
  `);
  db.exec(`
    create index if not exists idx_canvas_documents_scope_updated
      on canvas_documents(scope, scope_id, updated_at desc)
  `);
  db.exec(`
    create table if not exists canvas_events (
      id          text primary key,
      canvas_id   text not null references canvas_documents(id) on delete cascade,
      thread_id   text not null,
      action      text not null,
      data_json   text not null,
      created_at  text not null
    )
  `);
  db.exec(`
    create index if not exists idx_canvas_events_canvas_created
      on canvas_events(canvas_id, created_at desc)
  `);
}
