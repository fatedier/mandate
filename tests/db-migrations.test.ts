import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MIGRATION_SKIP_ENV,
  runPendingMigrations,
  type Migration
} from "../src/server/platform/db/migrations.js";

afterEach(() => {
  delete process.env[MIGRATION_SKIP_ENV];
});

function fresh(): Database {
  return new Database(":memory:");
}

function appliedIds(db: Database): string[] {
  return (db.prepare("select id from schema_migrations order by id").all() as Array<{ id: string }>)
    .map((row) => row.id);
}

test("runPendingMigrations: runs a pending migration and records it", () => {
  const db = fresh();
  runPendingMigrations(db, [
    { id: "a/one", up: (d) => d.exec("create table one (id text)") }
  ]);
  expect(appliedIds(db)).toEqual(["a/one"]);
  expect(db.prepare("select count(*) c from one").get()).toEqual({ c: 0 });
});

test("runPendingMigrations: an already-applied migration does not run again", () => {
  const db = fresh();
  let runs = 0;
  const migration: Migration = { id: "a/counted", up: () => { runs++; } };
  runPendingMigrations(db, [migration]);
  runPendingMigrations(db, [migration]);
  expect(runs).toBe(1);
  expect(appliedIds(db)).toEqual(["a/counted"]);
});

test("runPendingMigrations: a failing migration rolls back, is not recorded, and throws", () => {
  const db = fresh();
  expect(() => runPendingMigrations(db, [
    {
      id: "a/boom",
      up: (d) => {
        d.exec("create table half (id text)");
        throw new Error("upstream exploded");
      }
    }
  ])).toThrow();

  // The table the migration created before throwing must be gone.
  const tables = (db.prepare(
    "select name from sqlite_master where type='table' and name='half'"
  ).all() as unknown[]).length;
  expect(tables).toBe(0);
  expect(appliedIds(db)).toEqual([]);
});

test("runPendingMigrations: the failure message carries the recovery path", () => {
  const db = fresh();
  let message = "";
  try {
    runPendingMigrations(db, [
      { id: "a/boom", up: () => { throw new Error("upstream exploded"); } }
    ]);
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toContain("a/boom");
  expect(message).toContain("upstream exploded");
  expect(message).toContain(":memory:");            // db.filename
  expect(message).toContain(MIGRATION_SKIP_ENV);
  expect(message).toContain("insert into schema_migrations");
  expect(message).toContain('sqlite3 ":memory:"');  // quoted, see below
});

test("runPendingMigrations: the sqlite3 advice quotes a path containing a space", () => {
  // The path is MANDATE_DATA_DIR verbatim, and the line's only value is being
  // pasteable as-is — unquoted, a space makes the shell misparse it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md migrations "));
  try {
    const file = path.join(dir, "mandate.db");
    const db = new Database(file);
    let message = "";
    try {
      runPendingMigrations(db, [
        { id: "a/boom", up: () => { throw new Error("upstream exploded"); } }
      ]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(file).toContain(" ");
    expect(message).toContain(`sqlite3 "${file}"`);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runPendingMigrations: a later migration still runs after an earlier one is applied", () => {
  const db = fresh();
  runPendingMigrations(db, [{ id: "a/one", up: (d) => d.exec("create table one (id text)") }]);
  runPendingMigrations(db, [
    { id: "a/one", up: (d) => d.exec("create table one (id text)") },
    { id: "a/two", up: (d) => d.exec("create table two (id text)") }
  ]);
  expect(appliedIds(db)).toEqual(["a/one", "a/two"]);
});

test("runPendingMigrations: a skipped migration neither runs nor is recorded", () => {
  const db = fresh();
  process.env[MIGRATION_SKIP_ENV] = "a/skipped";
  let runs = 0;
  runPendingMigrations(db, [{ id: "a/skipped", up: () => { runs++; } }]);
  expect(runs).toBe(0);
  // Not recorded: dropping the env var must let it run on the next start.
  expect(appliedIds(db)).toEqual([]);

  delete process.env[MIGRATION_SKIP_ENV];
  runPendingMigrations(db, [{ id: "a/skipped", up: () => { runs++; } }]);
  expect(runs).toBe(1);
  expect(appliedIds(db)).toEqual(["a/skipped"]);
});

test("runPendingMigrations: the skip list accepts several comma-separated ids", () => {
  const db = fresh();
  process.env[MIGRATION_SKIP_ENV] = "a/one, a/three";
  const ran: string[] = [];
  runPendingMigrations(db, [
    { id: "a/one", up: () => { ran.push("one"); } },
    { id: "a/two", up: () => { ran.push("two"); } },
    { id: "a/three", up: () => { ran.push("three"); } }
  ]);
  expect(ran).toEqual(["two"]);
  expect(appliedIds(db)).toEqual(["a/two"]);
});

test("runPendingMigrations: duplicate ids are rejected before anything runs", () => {
  const db = fresh();
  let runs = 0;
  expect(() => runPendingMigrations(db, [
    { id: "a/dup", up: () => { runs++; } },
    { id: "a/dup", up: () => { runs++; } }
  ])).toThrow(/duplicate migration id: a\/dup/);
  expect(runs).toBe(0);
});

test("runPendingMigrations: migrations run in the order given", () => {
  const db = fresh();
  const ran: string[] = [];
  runPendingMigrations(db, [
    { id: "a/first", up: () => { ran.push("first"); } },
    { id: "a/second", up: () => { ran.push("second"); } },
    { id: "a/third", up: () => { ran.push("third"); } }
  ]);
  expect(ran).toEqual(["first", "second", "third"]);
});

test("runPendingMigrations: a migration that opens its own transaction fails loudly", () => {
  const db = fresh();
  expect(() => runPendingMigrations(db, [
    { id: "a/nested", up: (d) => { d.exec("begin"); } }
  ])).toThrow();
  expect(appliedIds(db)).toEqual([]);
});

test("runPendingMigrations: runs inside a transaction the caller already holds", () => {
  const db = fresh();
  db.exec("create table t (id text)");
  // bun nests this as a savepoint, so the caller's transaction is still open
  // when runPendingMigrations returns. That is the caller's to close, not a
  // migration leaking one — the runner must not mistake it for a violation.
  db.transaction(() => {
    runPendingMigrations(db, [
      { id: "a/inside", up: (d) => d.exec("insert into t values ('x')") }
    ]);
  })();
  expect(appliedIds(db)).toEqual(["a/inside"]);
  expect(db.prepare("select id from t").all()).toEqual([{ id: "x" }]);
});

test("runPendingMigrations: an async migration is refused, not recorded as done", () => {
  const db = fresh();
  db.exec("create table late (id text)");
  // `up` is declared `=> void`, and TypeScript's void-return rule accepts an
  // `async` body for it — this compiles clean under the repo's own gate, which
  // is why the runner has to catch it. The cast only stands in for that: it is
  // what an author writes without one.
  const asyncUp = async (d: Database) => {
    await Promise.resolve();
    d.exec("insert into late values ('x')");
  };
  expect(() => runPendingMigrations(db, [
    { id: "a/async", up: asyncUp as unknown as Migration["up"] }
  ])).toThrow(/must be synchronous/);
  // The runner cannot await, so without the guard the transaction commits and
  // the id is recorded while the body has not run yet — the exact
  // "applied without its effects" state the design forbids.
  expect(appliedIds(db)).toEqual([]);
  expect(db.prepare("select count(*) c from late").get()).toEqual({ c: 0 });
});

test("runPendingMigrations: a migration that commits for itself is not recorded", () => {
  const db = fresh();
  expect(() => runPendingMigrations(db, [
    {
      id: "a/self-commit",
      up: (d) => {
        d.exec("create table escaped (id text)");
        // Ends the runner's transaction, so everything above is already durable
        // and no longer rollback-able. Nothing can undo that from here.
        d.exec("commit");
      }
    }
  ])).toThrow();
  // But the id must still not be recorded. Recording it would mark a
  // half-applied migration as done, and it would never be retried.
  expect(appliedIds(db)).toEqual([]);
});
