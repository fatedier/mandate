import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { MandateStore } from "../src/server/app/store.js";
import { testStore } from "./helpers/test-store.js";
import { tempDir } from "./helpers/temp.js";

// The tests' store starts from a copy of one this process built, not from an
// empty file: it must be the database a fresh MandateStore makes, every
// table, index, trigger and starting row alike.

/** Schema and every table's rows. A full-text table's own shadow tables are
 *  left out (their structure record counts the writes made to it, and a
 *  store's start-up writes to it on every open); its rows are compared
 *  through the table itself. */
function contents(db: Database) {
  const schema = db.prepare("select type, name, tbl_name, sql from sqlite_master where name not like 'sqlite_%' order by type, name").all() as Array<{ type: string; name: string; sql: string | null }>;
  const virtual = schema.filter((s) => s.type === "table" && /^create virtual table/i.test(s.sql ?? "")).map((s) => s.name);
  const shadow = (name: string) => virtual.some((v) => ["data", "idx", "content", "docsize", "config"].some((part) => name === `${v}_${part}`));
  const rows = Object.fromEntries(schema.filter((s) => s.type === "table" && !shadow(s.name)).map((s) => [s.name, db.prepare(`select * from "${s.name}"`).all()]));
  return { schema, rows, journal: db.prepare("pragma journal_mode").get() };
}

test("a test store is the database a fresh store makes", () => {
  const fresh = new MandateStore(tempDir("md-store-fresh-"));
  const copied = testStore(tempDir("md-store-copied-"));
  const again = testStore(tempDir("md-store-copied-again-"));
  try {
    expect(contents(copied.db)).toStrictEqual(contents(fresh.db));
    expect(contents(again.db)).toStrictEqual(contents(fresh.db));
  } finally {
    for (const store of [fresh, copied, again]) store.db.close();
  }
});

test("a test store is its own: what one writes, another made after it does not hold", () => {
  const first = testStore(tempDir("md-store-own-1-"));
  first.db.exec("insert into llm_calls (id, purpose, provider, model, status, started_at, created_at, updated_at) values ('llm_x', 'p', 'openai', 'm', 'succeeded', '2026-01-01', '2026-01-01', '2026-01-01')");
  const second = testStore(tempDir("md-store-own-2-"));
  try {
    expect(second.db.prepare("select count(*) n from llm_calls").get()).toStrictEqual({ n: 0 });
  } finally {
    first.db.close();
    second.db.close();
  }
});

test("a directory that already holds a database opens it as it is", () => {
  const dir = tempDir("md-store-reopen-");
  const first = testStore(dir);
  first.db.exec("insert into llm_calls (id, purpose, provider, model, status, started_at, created_at, updated_at) values ('llm_kept', 'p', 'openai', 'm', 'succeeded', '2026-01-01', '2026-01-01', '2026-01-01')");
  first.db.close();
  const reopened = testStore(dir);
  try {
    expect(reopened.db.prepare("select id from llm_calls").all()).toStrictEqual([{ id: "llm_kept" }]);
  } finally {
    reopened.db.close();
  }
});
