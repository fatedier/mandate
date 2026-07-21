import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { panesMigrations } from "../src/server/modules/panes/migrations.js";
import { runPendingMigrations } from "../src/server/platform/db/migrations.js";
import { initializePanesSchema } from "../src/server/modules/panes/schema.js";

const MIGRATION_ID = "panes/2026-08-03-drop-pane-host-id";

/** The table exactly as it shipped before this change: composite primary key. */
function legacyPaneMetadata(db: Database): void {
  db.exec(`
    create table pane_metadata (
      host_id              text not null,
      pane_id              text not null,
      feature_id           text,
      session_name         text,
      window_name          text,
      name                 text not null default '',
      description          text not null default '',
      created_by_thread_id text,
      created_at           text not null,
      updated_at           text not null,
      primary key (host_id, pane_id)
    )
  `);
  db.exec(`
    create index if not exists idx_pane_metadata_feature
      on pane_metadata(feature_id, updated_at desc)
  `);
}

function columns(db: Database, table: string): string[] {
  return (db.query(`pragma table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name);
}

test("panesMigrations: declares the drop with a module-prefixed id", () => {
  const ids = panesMigrations.map((m) => m.id);
  expect(ids).toContain(MIGRATION_ID);
  for (const id of ids) expect(id.startsWith("panes/")).toBe(true);
});

test("old database: rows survive, host_id goes, pane_id becomes the key", () => {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  legacyPaneMetadata(db);
  db.prepare(
    `insert into pane_metadata
       (host_id, pane_id, feature_id, session_name, window_name, name,
        description, created_by_thread_id, created_at, updated_at)
     values ('local', ?, 'feat_1', 'alpha', 'login', ?, 'desc', 'thr_1', 'T0', 'T1')`
  ).run("%70", "build");
  db.prepare(
    `insert into pane_metadata
       (host_id, pane_id, feature_id, session_name, window_name, name,
        description, created_by_thread_id, created_at, updated_at)
     values ('local', ?, null, 'alpha', 'login', ?, '', null, 'T0', 'T1')`
  ).run("%71", "test");

  runPendingMigrations(db, panesMigrations);

  expect(columns(db, "pane_metadata")).not.toContain("host_id");
  const rows = db.query("select pane_id, name from pane_metadata order by pane_id").all();
  expect(rows).toEqual([
    { pane_id: "%70", name: "build" },
    { pane_id: "%71", name: "test" }
  ]);
  // The primary key really moved — a second row with the same pane_id must fail.
  expect(() => db.prepare(
    `insert into pane_metadata (pane_id, name, description, created_at, updated_at)
     values ('%70', 'dup', '', 'T0', 'T1')`
  ).run()).toThrow();
  // The index the old table carried is back, with its original two columns.
  const idx = db.query(
    "select sql from sqlite_master where type='index' and name='idx_pane_metadata_feature'"
  ).get() as { sql: string } | null;
  expect(idx?.sql).toContain("updated_at desc");
  expect(db.query("pragma foreign_key_check").all()).toEqual([]);
});

test("fresh database: the migration does not rebuild the table", () => {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  initializePanesSchema(db);
  expect(columns(db, "pane_metadata")).not.toContain("host_id");

  // A rebuild drops the table, and a dropped table takes its indexes with it.
  // This marker is therefore destroyed by exactly the work the guard exists to
  // skip — which is what makes the assertion below fail when the guard is gone.
  db.exec("create index idx_pane_rebuild_marker on pane_metadata(name)");

  expect(() => runPendingMigrations(db, panesMigrations)).not.toThrow();

  const marker = db.prepare(
    "select name from sqlite_master where type='index' and name='idx_pane_rebuild_marker'"
  ).get();
  expect(marker).not.toBeNull();
  expect(columns(db, "pane_metadata")).toEqual([
    "pane_id", "feature_id", "session_name", "window_name",
    "name", "description", "created_by_thread_id", "created_at", "updated_at"
  ]);
});
