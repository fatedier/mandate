import type { Database } from "bun:sqlite";

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
      content_revision integer not null default 0,
      kind        text not null default 'report'
    )
  `);
  db.exec(`
    create index if not exists idx_canvas_documents_thread_updated
      on canvas_documents(thread_id, updated_at desc)
  `);
  db.exec(`
    create index if not exists idx_canvas_documents_scope_updated
      on canvas_documents(scope, scope_id, updated_at desc)
  `);
}
