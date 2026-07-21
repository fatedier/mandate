import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { projectsMigrations } from "../src/server/modules/projects/migrations.js";
import { runPendingMigrations } from "../src/server/platform/db/migrations.js";
import { initializeProjectsSchema } from "../src/server/modules/projects/schema.js";

const MIGRATION_ID = "projects/2026-08-03-drop-project-host-id";

function legacyProjects(db: Database): void {
  db.exec(`
    create table projects (
      id                 text primary key,
      host_id            text not null default 'local',
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
  db.exec(`
    create table hosts (
      id text primary key, kind text not null, name text not null,
      ssh_host text not null, ssh_port integer not null default 22,
      ssh_user text not null, ssh_key_path text not null default '',
      remote_work_dir text not null default '',
      worker_command text not null default 'mandate',
      created_at text not null, updated_at text not null, archived_at text
    )
  `);
}

function columns(db: Database, table: string): string[] {
  return (db.query(`pragma table_info(${table})`).all() as Array<{ name: string }>)
    .map((c) => c.name);
}

function tableExists(db: Database, name: string): boolean {
  return db.query("select name from sqlite_master where type='table' and name = ?")
    .get(name) !== null;
}

test("projectsMigrations: declares the drop with a module-prefixed id", () => {
  const ids = projectsMigrations.map((m) => m.id);
  expect(ids).toContain(MIGRATION_ID);
  for (const id of ids) expect(id.startsWith("projects/")).toBe(true);
});

test("old database: host_id goes, hosts table goes, rows survive", () => {
  const db = new Database(":memory:");
  db.exec("pragma foreign_keys = on");
  legacyProjects(db);
  db.prepare(
    `insert into projects (id, host_id, name, working_dir, tmux_session_name,
                           ownership, created_at, updated_at)
     values ('proj_1', 'local', 'Alpha', '/alpha', 'alpha', 'app', 'T0', 'T1')`
  ).run();
  expect(tableExists(db, "hosts")).toBe(true);

  runPendingMigrations(db, projectsMigrations);

  expect(columns(db, "projects")).not.toContain("host_id");
  expect(tableExists(db, "hosts")).toBe(false);
  expect(db.query("select id, name from projects").all())
    .toEqual([{ id: "proj_1", name: "Alpha" }]);
});

test("fresh database: the migration is a no-op, not an error", () => {
  const db = new Database(":memory:");
  initializeProjectsSchema(db);
  expect(columns(db, "projects")).not.toContain("host_id");
  expect(() => runPendingMigrations(db, projectsMigrations)).not.toThrow();
  expect(columns(db, "projects")).not.toContain("host_id");
});

test("host_id does not come back when the schema converges again", () => {
  // The regression this pins: initializeDatabaseSchema runs BEFORE the
  // migrations on every start, so a leftover ensureColumn(projects, host_id)
  // would re-add the column on the second start — by which time the migration
  // is recorded as applied and will never drop it again.
  const db = new Database(":memory:");
  legacyProjects(db);
  runPendingMigrations(db, projectsMigrations);
  expect(columns(db, "projects")).not.toContain("host_id");
  initializeProjectsSchema(db);
  expect(columns(db, "projects")).not.toContain("host_id");
});
