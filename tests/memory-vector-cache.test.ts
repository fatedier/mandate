import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { initializeMemorySchema } from "../src/server/modules/memory/schema.js";
import { VectorCache } from "../src/server/modules/memory/vector-cache.js";
import { updateMemory } from "./helpers/memory-writes.js";

/**
 * `memory_entries` is here because the cache joins it: the two sides it keeps
 * are decided by the entry's status, not by anything in the embeddings table.
 * Only the two columns that join and filter are declared — the real schema
 * carries an FTS table and a dozen more columns, none of which this reads, and
 * one test below deliberately builds an older `memory_embeddings` shape, which
 * `initializeMemorySchema` would overwrite. The revision index is the real
 * one: the cache reads its stamps through it by name.
 */
function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    create table memory_embeddings (
      entry_id    text not null,
      model       text not null,
      vector_json text not null,
      revision    integer not null default 0,
      primary key (entry_id, model)
    );
    create index idx_memory_embeddings_revision on memory_embeddings(model, entry_id, revision);
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
    `insert into memory_embeddings (entry_id, model, vector_json, revision)
     values (?, ?, ?, ?)
     on conflict(entry_id, model) do update set
       vector_json = excluded.vector_json, revision = excluded.revision`
  ).run(entryId, model, JSON.stringify(vector), revision);
}

function setStatus(db: Database, entryId: string, status: string) {
  db.prepare("update memory_entries set status = ? where id = ?").run(status, entryId);
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
    `insert into memory_embeddings (entry_id, model, vector_json, revision)
     values ('bad', ?, 'not json', 0)`
  ).run(M);

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
    scope: "user",
    type: "knowledge",
    content: "alpha wording",
    source: "agent"
  });

  expect(revisionOf(entry.id)).toBe(0);
  expect(Array.from(cache.load(model).get(entry.id)!)).toEqual([1, 0]);

  await updateMemory(provider, { id: entry.id, content: "beta wording" });

  expect(revisionOf(entry.id)).toBe(1);
  expect(Array.from(cache.load(model).get(entry.id)!)).toEqual([0, 1]);
});

/** The ids each read of vector data asked for, in order; [] for a whole-model read. */
function vectorReads(db: Database): number[][] {
  const reads: number[][] = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const statement = original(sql) as unknown as { all: (...params: unknown[]) => unknown };
    if (!/vector_json/.test(sql)) return statement;
    const all = statement.all.bind(statement);
    statement.all = (...params: unknown[]) => { reads.push(params.slice(1).map((id) => Number(String(id).slice(1)))); return all(...params); };
    return statement;
  };
  return reads;
}

test("warming fills the default set a batch at a time, letting other work in between; a load after it reads no vector", async () => {
  const db = freshDb();
  for (let i = 0; i < 7; i++) put(db, `e${i}`, M, [i, 1], 0);
  put(db, "e9", M, [9, 1], 0, "archived");
  const cache = new VectorCache(db);
  const reads = vectorReads(db);
  let pauses = 0;
  await cache.warm(M, { batch: 3, pause: async () => { pauses++; } });
  expect(reads.map((ids) => ids.length)).toEqual([3, 3, 1]);
  expect(pauses).toBe(2);
  const loaded = cache.load(M);
  expect(reads.length).toBe(3);
  expect([...loaded.keys()].sort()).toEqual(["e0", "e1", "e2", "e3", "e4", "e5", "e6"]);
  expect(Array.from(loaded.get("e4")!)).toEqual([4, 1]);
});

test("a load while the set is warming gets every vector, and warming then stops", async () => {
  const db = freshDb();
  for (let i = 0; i < 7; i++) put(db, `e${i}`, M, [i, 1], 0);
  const cache = new VectorCache(db);
  const sizes: number[] = [];
  let pauses = 0;
  await cache.warm(M, { batch: 2, pause: async () => { pauses++; sizes.push(cache.load(M).size); } });
  expect(sizes).toEqual([7]);
  expect(pauses).toBe(1);
});

test("warming a model with nothing stored reads nothing and does not pause", async () => {
  const db = freshDb();
  const reads = vectorReads(db);
  let pauses = 0;
  await new VectorCache(db).warm(M, { pause: async () => { pauses++; } });
  expect([reads.length, pauses]).toEqual([0, 0]);
});

test("rows that will not parse do not keep warming going", async () => {
  const db = freshDb();
  put(db, "e0", M, [1, 0], 0);
  for (const id of ["e1", "e2", "e3"]) {
    db.prepare("insert into memory_entries (id, status) values (?, 'available')").run(id);
    db.prepare("insert into memory_embeddings (entry_id, model, vector_json, revision) values (?, ?, 'not json', 0)").run(id, M);
  }
  const cache = new VectorCache(db);
  let pauses = 0;
  await cache.warm(M, { batch: 1, pause: async () => { pauses++; } });
  expect(pauses).toBeLessThanOrEqual(4);
  expect([...cache.load(M).keys()]).toEqual(["e0"]);
});

test("every provider on a database shares its vectors: one built again, or another reader, reads none of them again", () => {
  const db = freshDb();
  for (let i = 0; i < 3; i++) put(db, `e${i}`, M, [i, 1], 0);
  const embedder = { model: M, embed: async () => [1, 1] };
  const reads = vectorReads(db);
  expect(new LocalMemoryProvider(db, { embedder }).availableVectors()?.size).toBe(3);
  expect(reads.length).toBe(1);
  expect(new LocalMemoryProvider(db, { embedder }).availableVectors()?.size).toBe(3);
  expect(reads.length).toBe(1);
});
