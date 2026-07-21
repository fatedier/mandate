import { expect, test } from "bun:test";
import { canvasMigrations } from "../src/server/modules/canvas/migrations.js";
import { initializeCanvasSchema } from "../src/server/modules/canvas/schema.js";
import { runPendingMigrations } from "../src/server/platform/db/migrations.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

const MIGRATION_ID = "canvas/2026-08-17-scope-identity-rename";

test("canvasMigrations: declares the scope rename with a module-prefixed id", () => {
  const ids = canvasMigrations.map((migration) => migration.id);
  expect(ids).toContain(MIGRATION_ID);
  for (const id of ids) expect(id.startsWith("canvas/")).toBe(true);
});

test("canvas scope rename rebuilds canvas_documents and keeps canvas_events", () => {
  const env = freshStoresEnv("md-canvas-rename-");
  try {
    const db = env.store.db;
    const now = new Date().toISOString();

    // schema.ts already built the NEW-DDL table, so on this database the
    // migration would be a guarded no-op with or without the code under test.
    // Put the table landscape back into its pre-rename shape — the exact old
    // create statements, with the old CHECK — so the asserted end state can
    // only come from the migration's own DDL. Child first: canvas_events
    // references canvas_documents.
    db.exec("drop table canvas_events");
    db.exec("drop table canvas_documents");
    db.exec(`
      create table canvas_documents (
        id          text primary key,
        title       text not null,
        html        text not null,
        scope       text not null check (scope in ('overview','feature')),
        scope_id    text,
        project_id  text,
        file_path   text,
        thread_id   text not null,
        created_at  text not null,
        updated_at  text not null
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
    db.exec(`
      create index if not exists idx_canvas_events_canvas_created
        on canvas_events(canvas_id, created_at desc)
    `);

    const insertDoc = db.prepare(
      "insert into canvas_documents (id, title, html, scope, scope_id, project_id, file_path, thread_id, created_at, updated_at) " +
      "values (?, 'T', '<p>x</p>', ?, ?, null, null, ?, ?, ?)"
    );
    insertDoc.run("doc-ov", "overview", null, "t-ov", now, now);
    insertDoc.run("doc-f1", "feature", "f1", "t-f1", now, now);
    db.prepare(
      "insert into canvas_events (id, canvas_id, thread_id, action, data_json, created_at) values ('ev-1', 'doc-f1', 't-f1', 'create', '{}', ?)"
    ).run(now);
    // An orphaned event (parent row long gone), as written by a historical
    // connection that never ran `pragma foreign_keys=on`. The rebuild's final
    // copy-back re-checks the FK with enforcement on, so an orphan must be
    // filtered out — not abort the migration and brick every boot.
    db.exec("pragma foreign_keys=off");
    db.prepare(
      "insert into canvas_events (id, canvas_id, thread_id, action, data_json, created_at) values ('ev-orphan', 'doc-gone', 't-x', 'create', '{}', ?)"
    ).run(now);
    db.exec("pragma foreign_keys=on");

    // MandateStore's constructor already ran the rename against the then-empty
    // database; forget that so the runner meets the seeded rows the way it
    // meets a real database at upgrade time.
    db.prepare("delete from schema_migrations where id = ?").run(MIGRATION_ID);

    runPendingMigrations(db, canvasMigrations);

    expect(
      (db.prepare("select scope from canvas_documents where id = 'doc-ov'").get() as { scope: string }).scope
    ).toBe("manager");
    expect(
      (db.prepare("select scope from canvas_documents where id = 'doc-f1'").get() as { scope: string }).scope
    ).toBe("worker");
    expect(db.prepare("select content_revision from canvas_documents where id = 'doc-f1'").get())
      .toEqual({ content_revision: 0 });
    expect(
      (db.prepare("select count(*) c from canvas_documents where scope in ('overview','feature')").get() as { c: number }).c
    ).toBe(0);

    // The rebuild replaced the table, so its indexes must have been recreated.
    const indexes = (db
      .prepare("select name from sqlite_master where type='index' and tbl_name='canvas_documents'")
      .all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toContain("idx_canvas_documents_thread_updated");
    expect(indexes).toContain("idx_canvas_documents_scope_updated");

    // The migration runner holds a transaction, inside which `pragma
    // foreign_keys=off` is a documented no-op — a naive drop of the parent
    // table would cascade-delete every canvas_events row. The event must
    // survive the rebuild, still pointing at its document.
    expect(
      (db.prepare("select canvas_id from canvas_events where id = 'ev-1'").get() as { canvas_id: string }).canvas_id
    ).toBe("doc-f1");
    // The orphan was dropped rather than aborting the whole migration.
    expect(db.prepare("select id from canvas_events where id = 'ev-orphan'").get()).toBe(null);
    const eventIndexes = (db
      .prepare("select name from sqlite_master where type='index' and tbl_name='canvas_events'")
      .all() as { name: string }[]).map((r) => r.name);
    expect(eventIndexes).toContain("idx_canvas_events_canvas_created");

    // New CHECK is active: the old scope vocabulary is rejected...
    expect(() =>
      insertDoc.run("doc-ov-2", "overview", null, "t-x", now, now)
    ).toThrow();
    // ...and the events FK still enforces.
    expect(() =>
      db.prepare(
        "insert into canvas_events (id, canvas_id, thread_id, action, data_json, created_at) values ('ev-bad', 'no-such-doc', 't-x', 'create', '{}', ?)"
      ).run(now)
    ).toThrow();

    // Recorded, so a restart does not repeat the rebuild.
    expect(
      db.prepare("select id from schema_migrations where id = ?").get(MIGRATION_ID)
    ).not.toBeNull();
  } finally {
    env.cleanup();
  }
});

test("Canvas schema adds publication revisions to existing documents without resetting them", () => {
  const env = freshStoresEnv("md-canvas-revision-upgrade-");
  try {
    const db = env.store.db;
    db.exec("alter table canvas_documents drop column content_revision");
    db.exec(`insert into canvas_documents
      (id, title, html, scope, thread_id, created_at, updated_at)
      values ('existing', 'Existing canvas', '<p>Existing content</p>', 'manager', 'thread', 'before', 'before')`);
    initializeCanvasSchema(db);
    expect(db.prepare("select title, html, content_revision from canvas_documents where id = 'existing'").get())
      .toEqual({ title: "Existing canvas", html: "<p>Existing content</p>", content_revision: 0 });
    db.exec("update canvas_documents set content_revision = 7 where id = 'existing'");
    initializeCanvasSchema(db);
    expect(db.prepare("select content_revision from canvas_documents where id = 'existing'").get())
      .toEqual({ content_revision: 7 });
  } finally { env.cleanup(); }
});

test("canvas scope rename is a no-op on a database already using the new CHECK", () => {
  const env = freshStoresEnv("md-canvas-fresh-");
  try {
    const db = env.store.db;
    const now = new Date().toISOString();
    // Fresh schema already carries the new CHECK; the guard must not rebuild.
    db.prepare(
      "insert into canvas_documents (id, title, html, scope, scope_id, thread_id, created_at, updated_at) " +
      "values ('doc-m', 'T', '<p>x</p>', 'manager', null, 't-1', ?, ?)"
    ).run(now, now);
    db.prepare("delete from schema_migrations where id = ?").run(MIGRATION_ID);

    runPendingMigrations(db, canvasMigrations);

    expect(
      (db.prepare("select scope from canvas_documents where id = 'doc-m'").get() as { scope: string }).scope
    ).toBe("manager");
  } finally {
    env.cleanup();
  }
});
