import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureColumn } from "../src/server/platform/db/ensure-column.js";

function fresh(): Database {
  const db = new Database(":memory:");
  db.exec("create table widgets (id text primary key)");
  return db;
}

function columns(db: Database, table: string): string[] {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

test("ensureColumn: adds a missing column", () => {
  const db = fresh();
  ensureColumn(db, "widgets", "label", "text");
  expect(columns(db, "widgets")).toEqual(["id", "label"]);
});

test("ensureColumn: is a no-op when the column already exists", () => {
  const db = fresh();
  ensureColumn(db, "widgets", "label", "text");
  db.prepare("insert into widgets (id, label) values (?, ?)").run("w1", "kept");
  // A second call must not re-add, and must not disturb the stored value.
  ensureColumn(db, "widgets", "label", "text");
  expect(columns(db, "widgets")).toEqual(["id", "label"]);
  expect((db.prepare("select label from widgets where id = ?").get("w1") as any).label)
    .toBe("kept");
});

test("ensureColumn: applies constraints and defaults from the definition", () => {
  const db = fresh();
  ensureColumn(db, "widgets", "rank", "integer not null default 7");
  db.prepare("insert into widgets (id) values (?)").run("w1");
  expect((db.prepare("select rank from widgets where id = ?").get("w1") as any).rank)
    .toBe(7);
});

test("ensureColumn: definition must not repeat the column name", () => {
  const db = fresh();
  // The old agent/memory/canvas copies took "label text" here. SQLite does NOT
  // reject `add column label label text` — it parses a type name as a run of
  // words and silently declares the column with type "label text". Affinity
  // usually survives by luck, but a column whose own name contains a type
  // keyword (int_flag / "int_flag text" -> INTEGER affinity, TEXT intended)
  // is corrupted with no error. Hence the guard in ensureColumn, and this test.
  expect(() => ensureColumn(db, "widgets", "label", "label text")).toThrow();
});
