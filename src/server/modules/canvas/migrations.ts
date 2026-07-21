import type { Migration } from "../../platform/db/migrations.js";

export const canvasMigrations: Migration[] = [
  {
    // SQLite cannot alter a CHECK constraint, so this is a table rebuild.
    // The runner holds a transaction, inside which `pragma foreign_keys=off`
    // is a documented no-op (see Migration.up in platform/db/migrations.ts) —
    // so dropping canvas_documents with canvas_events still attached would
    // cascade-delete every event row. Instead the events go into an FK-free
    // holding table first, the child table is dropped before its parent, and
    // both are recreated around the renamed rebuild. Verified empirically:
    // the naive order loses all canvas_events rows; this order keeps them
    // with both the new CHECK and the FK enforced afterward.
    id: "canvas/2026-08-17-scope-identity-rename",
    up: (db) => {
      const hasOld = db.prepare(
        "select count(*) c from sqlite_master where type='table' and name='canvas_documents' and sql like '%''overview''%'"
      ).get() as { c: number };
      if (!hasOld.c) return; // fresh DB already created with the new CHECK

      db.exec("create table canvas_events_mig as select * from canvas_events");
      db.exec("drop table canvas_events");
      db.exec(`
        create table canvas_documents_new (
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
      db.exec(`
        insert into canvas_documents_new
          (id, title, html, scope, scope_id, project_id, file_path, thread_id, created_at, updated_at)
        select id, title, html,
               case scope when 'overview' then 'manager' when 'feature' then 'worker' else scope end,
               scope_id, project_id, file_path, thread_id, created_at, updated_at
        from canvas_documents
      `);
      db.exec("drop table canvas_documents");
      db.exec("alter table canvas_documents_new rename to canvas_documents");
      db.exec("create index if not exists idx_canvas_documents_thread_updated on canvas_documents(thread_id, updated_at desc)");
      db.exec("create index if not exists idx_canvas_documents_scope_updated on canvas_documents(scope, scope_id, updated_at desc)");
      db.exec(`
        create table canvas_events (
          id          text primary key,
          canvas_id   text not null references canvas_documents(id) on delete cascade,
          thread_id   text not null,
          action      text not null,
          data_json   text not null,
          created_at  text not null
        )
      `);
      // The copy-back re-checks the recreated FK with enforcement on (the
      // runner's transaction makes `pragma foreign_keys=off` a no-op), so
      // orphaned rows written by historical FK-less connections must be
      // filtered out here or one bad row bricks every subsequent boot.
      db.exec(
        "insert into canvas_events " +
        "select id, canvas_id, thread_id, action, data_json, created_at from canvas_events_mig " +
        "where canvas_id in (select id from canvas_documents)"
      );
      db.exec("drop table canvas_events_mig");
      db.exec("create index if not exists idx_canvas_events_canvas_created on canvas_events(canvas_id, created_at desc)");
    }
  }
];
