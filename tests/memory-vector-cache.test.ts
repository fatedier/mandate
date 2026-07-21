import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { initializeMemorySchema } from "../src/server/modules/memory/schema.js";
import { VectorCache } from "../src/server/modules/memory/vector-cache.js";

// Every row written by `put` carries this same timestamp. That is deliberate: the cache
// must key off `revision` alone, and a fixed clock means any implementation that falls
// back to `updated_at` sees "nothing changed" and fails these tests deterministically.
const FIXED_STAMP = "2026-07-31T00:00:00.000Z";

/**
 * `memory_entries` is here because the cache joins it: the two sides it keeps
 * are decided by the entry's status, not by anything in the embeddings table.
 * Only the two columns that join and filter are declared — the real schema
 * carries an FTS table and a dozen more columns, none of which this reads, and
 * one test below deliberately builds an older `memory_embeddings` shape, which
 * `initializeMemorySchema` would overwrite.
 */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    create table memory_embeddings (
      entry_id    text not null,
      model       text not null,
      dimensions  integer not null,
      vector_json text not null,
      updated_at  text not null,
      revision    integer not null default 0,
      primary key (entry_id, model)
    );
    create table memory_entries (
      id     text primary key,
      status text not null
    );
  `);
  return db;
}

function put(
  db: Database,
  entryId: string,
  model: string,
  vector: number[],
  revision: number,
  status = "available"
) {
  db.prepare(
    "insert into memory_entries (id, status) values (?, ?) on conflict(id) do update set status = excluded.status"
  ).run(entryId, status);
  db.prepare(
    `insert into memory_embeddings (entry_id, model, dimensions, vector_json, updated_at, revision)
     values (?, ?, ?, ?, ?, ?)
     on conflict(entry_id, model) do update set
       vector_json = excluded.vector_json, revision = excluded.revision`
  ).run(entryId, model, vector.length, JSON.stringify(vector), FIXED_STAMP, revision);
}

function setStatus(db: Database, entryId: string, status: string) {
  db.prepare("update memory_entries set status = ? where id = ?").run(status, entryId);
}

function stampOf(db: Database, entryId: string): string {
  return (db.prepare("select updated_at from memory_embeddings where entry_id = ?")
    .get(entryId) as { updated_at: string }).updated_at;
}

const M = "test-model";

test("the first load returns every vector for the model", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  put(db, "b", M, [0, 1], 0);

  const loaded = new VectorCache(db).load(M);

  expect(loaded.size).toBe(2);
  expect(Array.from(loaded.get("a")!)).toEqual([1, 0]);
  expect(loaded.get("a")).toBeInstanceOf(Float64Array);
});

test("a second load does not re-read a row whose revision is unchanged", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  const cache = new VectorCache(db);
  cache.load(M);

  // Rewrite the payload but leave `revision` alone. A cache that re-read the row
  // would pick this up; one that trusts the revision must not. No counting hook needed.
  db.prepare("update memory_embeddings set vector_json = ? where entry_id = 'a'")
    .run(JSON.stringify([9, 9]));

  expect(Array.from(cache.load(M).get("a")!)).toEqual([1, 0]);
});

test("a changed revision re-reads exactly that row", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  put(db, "b", M, [0, 1], 0);
  const cache = new VectorCache(db);
  cache.load(M);

  put(db, "a", M, [2, 2], 1);
  db.prepare("update memory_embeddings set vector_json = ? where entry_id = 'b'")
    .run(JSON.stringify([7, 7]));

  const loaded = cache.load(M);
  expect(Array.from(loaded.get("a")!)).toEqual([2, 2]);
  // b's revision did not move, so its rewritten payload must not be picked up.
  expect(Array.from(loaded.get("b")!)).toEqual([0, 1]);
});

test("a rewrite inside the same millisecond is still observed", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  const cache = new VectorCache(db);
  cache.load(M);
  const before = stampOf(db, "a");

  // The hole this pins: `nowIso()` is millisecond text, and consecutive writes to one row
  // routinely share a value -- with an embedder that resolves immediately, most
  // write/search/write/search trials land inside a single millisecond, and every
  // collision serves the superseded vector. Reproducing that by racing would make this
  // test fail only most of the time, so the timestamp here is identical by construction
  // and only the revision moves: a clock-based cache is then deterministically wrong.
  put(db, "a", M, [3, 4], 1);

  expect(stampOf(db, "a")).toBe(before);
  expect(Array.from(cache.load(M).get("a")!)).toEqual([3, 4]);
});

test("a deleted row disappears from the cache", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  put(db, "b", M, [0, 1], 0);
  const cache = new VectorCache(db);
  cache.load(M);

  db.prepare("delete from memory_embeddings where entry_id = 'a'").run();

  const loaded = cache.load(M);
  expect(loaded.has("a")).toBe(false);
  expect(loaded.size).toBe(1);
});

test("another model's rows never enter this model's cache", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  put(db, "a", "other-model", [5, 5], 0);
  put(db, "c", "other-model", [6, 6], 0);

  const cache = new VectorCache(db);
  expect(Array.from(cache.load(M).get("a")!)).toEqual([1, 0]);
  expect(cache.load(M).has("c")).toBe(false);
  expect(Array.from(cache.load("other-model").get("a")!)).toEqual([5, 5]);
});

test("an unparseable vector is skipped without disturbing the rest", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  db.prepare("insert into memory_entries (id, status) values ('bad', 'available')").run();
  db.prepare(
    `insert into memory_embeddings (entry_id, model, dimensions, vector_json, updated_at, revision)
     values ('bad', ?, 2, 'not json', ?, 0)`
  ).run(M, FIXED_STAMP);

  const loaded = new VectorCache(db).load(M);

  expect(loaded.has("bad")).toBe(false);
  expect(Array.from(loaded.get("a")!)).toEqual([1, 0]);
});

test("a row that becomes unparseable is dropped on the next load", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  const cache = new VectorCache(db);
  cache.load(M);

  db.prepare("update memory_embeddings set vector_json = 'not json', revision = 1 where entry_id = 'a'")
    .run();

  expect(cache.load(M).has("a")).toBe(false);
});

test("a row removed from this model is dropped even if the entry exists under another", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  put(db, "a", "other-model", [5, 5], 0);
  const cache = new VectorCache(db);
  cache.load(M);

  db.prepare("delete from memory_embeddings where entry_id = 'a' and model = ?").run(M);

  // This is what pins the `model` filter on the revision probe. An unfiltered probe still
  // sees the other model's row, so `a` looks present, its revision looks unchanged, and the
  // stale vector survives. The plain two-model test above does not catch that: with the
  // refresh query still filtered, the wrong ids simply never get a vector.
  expect(cache.load(M).has("a")).toBe(false);
});

test("an empty table loads nothing", () => {
  expect(new VectorCache(freshDb()).load(M).size).toBe(0);
});

test("archiving an entry moves its vector out of the default set and into the hidden one", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  put(db, "b", M, [0, 1], 0);
  const cache = new VectorCache(db);
  expect([...cache.load(M).keys()].sort()).toEqual(["a", "b"]);
  expect(cache.loadHidden(M).size).toBe(0);

  setStatus(db, "a", "archived");

  // Not merely absent from the default set: still readable on the other side,
  // at the same value. The pair is what a search asking for archived rows
  // depends on — dropping it from one set without adding it to the other is
  // exactly the silent failure this split exists to avoid.
  expect([...cache.load(M).keys()]).toEqual(["b"]);
  expect(Array.from(cache.loadHidden(M).get("a")!)).toEqual([1, 0]);
});

test("a deleted status is hidden too, not just an archived one", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0, "deleted");
  const cache = new VectorCache(db);
  expect(cache.load(M).size).toBe(0);
  expect(Array.from(cache.loadHidden(M).get("a")!)).toEqual([1, 0]);
});

test("an embedding whose entry is gone is in neither set", () => {
  const db = freshDb();
  put(db, "a", M, [1, 0], 0);
  db.prepare("delete from memory_entries where id = 'a'").run();

  // An orphan cannot be used: the search's own row query joins `memory_entries`
  // as well, so a vector with no entry could never be scored against anything.
  // Nothing in the app hard-deletes an entry today, so this is a statement
  // about what the join guarantees rather than a case that occurs.
  const cache = new VectorCache(db);
  expect(cache.load(M).size).toBe(0);
  expect(cache.loadHidden(M).size).toBe(0);
});

test("storeEmbedding bumps the revision, so a re-embedded entry is re-read", async () => {
  const db = new Database(":memory:");
  initializeMemorySchema(db);
  const model = "vector-cache-fake";
  const provider = new LocalMemoryProvider(db, {
    embedder: {
      model,
      // Resolves without awaiting anything, so both writes race the same millisecond.
      async embed(text: string) {
        return text.startsWith("beta") ? [0, 1] : [1, 0];
      }
    }
  });
  const cache = new VectorCache(db);
  const revisionOf = (id: string) => (db.prepare(
    "select revision from memory_embeddings where entry_id = ?"
  ).get(id) as { revision: number }).revision;

  const entry = await provider.remember({
    scope: "global",
    kind: "semantic",
    content: "alpha wording",
    source: "manual"
  });

  expect(revisionOf(entry.id)).toBe(0);
  expect(Array.from(cache.load(model).get(entry.id)!)).toEqual([1, 0]);

  await provider.update({ id: entry.id, content: "beta wording" });

  expect(revisionOf(entry.id)).toBe(1);
  expect(Array.from(cache.load(model).get(entry.id)!)).toEqual([0, 1]);
});

test("an embeddings table predating the revision column is upgraded in place", () => {
  const db = new Database(":memory:");
  // The shape that shipped before this change, rows and all. There is no memory_entries
  // table, so the legacy reset leaves this alone and initializeMemorySchema has to add
  // the column to the existing table rather than create it.
  db.exec(`
    create table memory_embeddings (
      entry_id    text not null,
      model       text not null,
      dimensions  integer not null,
      vector_json text not null,
      updated_at  text not null,
      primary key (entry_id, model)
    );
    insert into memory_embeddings values ('a', '${M}', 2, '[1,0]', '${FIXED_STAMP}');
  `);

  initializeMemorySchema(db);
  // The entry the embedding belongs to, which only exists once the schema above
  // has created the table. Without it the cache's join drops the row and the
  // last assertion would fail for a reason that has nothing to do with the
  // column this test is about.
  db.prepare(
    "insert into memory_entries (id, scope, kind, content, status, source, created_at, updated_at)"
    + " values ('a', 'global', 'semantic', 'legacy', 'available', 'manual', ?, ?)"
  ).run(FIXED_STAMP, FIXED_STAMP);

  const columns = db.prepare("pragma table_info(memory_embeddings)").all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toContain("revision");
  // Existing rows take the default, the cache starts empty and records 0 on its first
  // load, and the first rewrite moves it to 1 -- so no backfill is needed.
  expect((db.prepare("select revision from memory_embeddings where entry_id = 'a'")
    .get() as { revision: number }).revision).toBe(0);
  expect(Array.from(new VectorCache(db).load(M).get("a")!)).toEqual([1, 0]);
});

test("the superseded stamp index is replaced, not left standing beside the new one", () => {
  const db = new Database(":memory:");
  // A database that already ran the previous commit: the table has `revision`, and the
  // index over (model, entry_id, updated_at) exists. This is the case a rename has to
  // survive -- `create index if not exists` is a silent no-op against an existing name,
  // so reusing it would leave these columns in place and the revision probe uncovered.
  db.exec(`
    create table memory_embeddings (
      entry_id    text not null,
      model       text not null,
      dimensions  integer not null,
      vector_json text not null,
      updated_at  text not null,
      revision    integer not null default 0,
      primary key (entry_id, model)
    );
    create index idx_memory_embeddings_stamp
      on memory_embeddings(model, entry_id, updated_at);
  `);

  initializeMemorySchema(db);

  const indexes = db.prepare(
    "select name from sqlite_master where type = 'index' and tbl_name = 'memory_embeddings'"
  ).all() as Array<{ name: string }>;
  const names = indexes.map((index) => index.name);
  expect(names).not.toContain("idx_memory_embeddings_stamp");
  expect(names).toContain("idx_memory_embeddings_revision");
  // The probe selects (entry_id, revision) filtered by model, so these three columns in
  // this order are what makes it covering; any other set sends it back to the table.
  const columns = db.prepare("pragma index_info(idx_memory_embeddings_revision)")
    .all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toEqual(["model", "entry_id", "revision"]);
});
