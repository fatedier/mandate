import { expect, test } from "bun:test";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

test("remember stores the new fields, a project memory needs its project, and archive keeps the row", async () => {
  const env = freshStoresEnv("md-memory-v2-");
  const provider = new LocalMemoryProvider(env.store.db);
  const entry = await provider.remember({
    scope: "project", projectId: "proj_1", featureId: "feat_1", type: "knowledge", source: "user",
    userQuote: "the API is rows-only", content: "  The export API is rows-only.  ", sourceThreadId: "thr_1"
  });
  expect(entry).toMatchObject({ scope: "project", projectId: "proj_1", featureId: "feat_1", type: "knowledge",
    source: "user", userQuote: "the API is rows-only", content: "The export API is rows-only.", status: "available" });
  expect(await provider.get(entry.id)).toEqual(entry);
  await expect(provider.remember({ scope: "project", type: "knowledge", source: "agent", content: "x" }))
    .rejects.toThrow("a project memory needs a projectId");
  const userEntry = await provider.remember({ scope: "user", projectId: "proj_1", type: "preference", source: "agent", userQuote: "ignored", content: "y" });
  expect(userEntry).toMatchObject({ projectId: null, userQuote: null });

  const archived = await provider.archive(entry.id, { forgottenReason: "wrong" });
  expect(archived).toMatchObject({ status: "archived", content: "The export API is rows-only." });
  // textAsLearned: archived with its text untouched, the store says so.
  expect(archived?.metadata).toEqual({ forgottenReason: "wrong", textAsLearned: true });
});

test("search filters by project, scope, type and status, and never counts anything", async () => {
  const env = freshStoresEnv("md-memory-v2-search-");
  const provider = new LocalMemoryProvider(env.store.db);
  const user = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "deploy notes for the user" });
  const p1 = await provider.remember({ scope: "project", projectId: "proj_1", type: "knowledge", source: "agent", content: "deploy notes for one" });
  const p2 = await provider.remember({ scope: "project", projectId: "proj_2", type: "task", source: "extraction", content: "deploy notes for two" });
  const old = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "deploy notes, old" });
  await provider.archive(old.id);
  const ids = async (input: Parameters<LocalMemoryProvider["search"]>[0]) =>
    (await provider.search(input)).map((r) => r.entry.id).sort();
  const rows = () => env.store.db.prepare("select * from memory_entries order by id").all();
  const before = rows();

  expect(await ids({ query: "deploy" })).toEqual([user.id, p1.id, p2.id].sort());
  expect(await ids({ query: "deploy", projectId: "proj_1" })).toEqual([p1.id]);
  expect(await ids({ query: "deploy", scope: "user" })).toEqual([user.id]);
  expect(await ids({ query: "deploy", type: "task" })).toEqual([p2.id]);
  expect(await ids({ query: "deploy", types: ["preference", "knowledge"] })).toEqual([user.id, p1.id].sort());
  expect(await ids({ query: "deploy", types: [] })).toEqual([user.id, p1.id, p2.id].sort());
  expect(await ids({ query: "deploy", includeArchived: true })).toEqual([user.id, p1.id, p2.id, old.id].sort());
  // A search only reads: no entry it found is counted, touched or moved on.
  expect(before).toHaveLength(4);
  expect(rows()).toEqual(before);
});

test("listAvailable and listArchivedSince read one partition", async () => {
  const env = freshStoresEnv("md-memory-v2-list-");
  const provider = new LocalMemoryProvider(env.store.db);
  const a = await provider.remember({ scope: "project", projectId: "proj_1", type: "knowledge", source: "agent", content: "a" });
  const rule = await provider.remember({ scope: "project", projectId: "proj_1", type: "preference", source: "agent", content: "t" });
  await provider.remember({ scope: "project", projectId: "proj_2", type: "knowledge", source: "agent", content: "b" });
  await provider.remember({ scope: "user", type: "preference", source: "agent", content: "c" });
  const gone = await provider.remember({ scope: "project", projectId: "proj_1", type: "knowledge", source: "agent", content: "gone" });
  const cut = new Date(Date.now() - 1000).toISOString();
  await provider.archive(gone.id);

  expect(provider.listAvailable({ scope: "project", projectId: "proj_1" }).map((e) => e.id).sort()).toEqual([a.id, rule.id].sort());
  expect(provider.listAvailable({ scope: "project", projectId: "proj_1", type: "preference" }).map((e) => e.id)).toEqual([rule.id]);
  expect(provider.listAvailable({ scope: "user", projectId: null })).toHaveLength(1);
  expect(provider.listArchivedSince({ scope: "project", projectId: "proj_1" }, cut).map((e) => e.id)).toEqual([gone.id]);
});

test("LocalMemoryProvider: search returns the best bm25 match first", async () => {
  const env = freshStoresEnv("md-memory-rank-");
  const provider = new LocalMemoryProvider(env.store.db);
  const filler = "unrelated prose about scheduling and disk layout and window titles ";
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "quilloscope quilloscope quilloscope quilloscope",
    source: "agent"
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: `${filler.repeat(6)} quilloscope ${filler.repeat(6)}`,
    source: "agent"
  });

  const results = await provider.search({ query: "quilloscope", maxResults: 10 });

  expect(results.length).toBe(2);
  expect(results[0].entry.content).toBe("quilloscope quilloscope quilloscope quilloscope");
  expect(results[0].score).toBeGreaterThan(results[1].score);
  expect(results[0].reason).toBe("fts");
  // Both entries are substring matches as well, and the lexical lane drops the
  // substring rows FTS already reached, so this one contributes exactly one rank
  // term. Stop dropping them and it is counted twice, at 1/61 + 1/64 = 0.032018,
  // which no other assertion here notices: the ordering survives the double count
  // by 1.6e-5.
  expect(results[0].score).toBeCloseTo(1 / 61, 12);
});

test("LocalMemoryProvider: two paths agreeing outrank a single path's best hit", async () => {
  const env = freshStoresEnv("md-memory-fuse-");
  const provider = new LocalMemoryProvider(env.store.db, {
    embedder: {
      model: "test-embedding",
      // Only the "alpha" note points away from the query; everything else,
      // the query included, shares one direction.
      async embed(text) {
        return text.includes("alpha") ? [0, 1] : [1, 0];
      }
    }
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "zephyrine zephyrine zephyrine alpha",
    source: "agent"
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "a longer note that mentions zephyrine once and is otherwise about beta",
    source: "agent"
  });

  const results = await provider.search({ query: "zephyrine", maxResults: 10 });

  // The "alpha" note is the better bm25 match and so comes first out of FTS, but
  // the other note is the one both paths found -- fusion has to reorder them.
  expect(results.length).toBe(2);
  expect(results[0].entry.content).toContain("beta");
  expect(results[0].reason).toBe("vector");
  expect(results[1].reason).toBe("fts");
  expect(results[0].score).toBeGreaterThan(results[1].score);
});

test("LocalMemoryProvider: a vector-only hit still lands on a page FTS filled", async () => {
  const env = freshStoresEnv("md-memory-vector-depth-");
  const provider = new LocalMemoryProvider(env.store.db, {
    embedder: {
      model: "test-embedding",
      // The query and the "quasar" note point the same way; the two zephyrine
      // notes point off-axis by different amounts, so every entry has a positive
      // cosine and the vector path's own order is fixed.
      async embed(text) {
        if (text.includes("dense")) return [0.8, 0.6];
        if (text.includes("sparse")) return [0.6, 0.8];
        return [1, 0];
      }
    }
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "quasar drift observed from the north ridge",
    source: "agent"
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "zephyrine zephyrine zephyrine dense",
    source: "agent"
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "a sparse note mentioning zephyrine once amid unrelated prose",
    source: "agent"
  });

  // FTS matches both zephyrine notes and so returns a full page of 2. The
  // quasar note is the vector path's rank 1 and is unreachable by FTS or LIKE.
  const results = await provider.search({ query: "zephyrine", maxResults: 2 });

  expect(results.length).toBe(2);
  expect(results.map((r) => r.entry.content)).toContain("quasar drift observed from the north ridge");
  expect(results.find((r) => r.entry.content.startsWith("quasar"))?.reason).toBe("vector");
});

test("LocalMemoryProvider: a substring-only match ranks below the entry fts reached", async () => {
  const env = freshStoresEnv("md-memory-filler-");
  const provider = new LocalMemoryProvider(env.store.db);
  // "gg" is a token of the first note but only an interior substring of "biggie",
  // so the second note is reachable by LIKE and not by a prefix FTS match.
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "gg is how the tournament log opens",
    source: "agent"
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "biggie stores the tournament log elsewhere",
    source: "agent"
  });

  const results = await provider.search({ query: "gg", maxResults: 10 });

  expect(results.length).toBe(2);
  expect(results[0].reason).toBe("fts");
  expect(results[1].reason).toBe("like");
  expect(results[1].score).toBeLessThan(results[0].score);
});

test("LocalMemoryProvider: a substring-only hit survives a page the vector lane filled", async () => {
  const env = freshStoresEnv("md-memory-substr-");
  const provider = new LocalMemoryProvider(env.store.db, {
    embedder: {
      model: "test-embedding",
      // The Chinese note points away from everything else, so the vector lane
      // drops it (cosine 0) and the two filler notes fill the page on their own.
      async embed(text) {
        return text.includes("抽象") ? [0, 1] : [1, 0];
      }
    }
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "统一升级到新版本的运行时抽象",
    source: "agent"
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "first filler note about unrelated scheduling",
    source: "agent"
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "second filler note about unrelated disk layout",
    source: "agent"
  });

  // maxResults 2 is what makes this discriminating: the vector lane alone
  // already fills the page, which is exactly when the old tail filler stopped
  // running.
  const results = await provider.search({ query: "升级", maxResults: 2 });

  expect(results.length).toBe(2);
  expect(results.map((r) => r.entry.content)).toContain("统一升级到新版本的运行时抽象");
  const literal = results.find((r) => r.entry.content.includes("升级"))!;
  expect(literal.reason).toBe("like");
  // The literal match ties the vector lane's top hit at 1/(k+1) and the tie
  // breaks on the order the lists were fused, so it lands right behind it
  // rather than displacing it. This is what pins that order -- push the lexical
  // list ahead of the vector list and this assertion inverts.
  // Asserting on `reason` rather than on which filler won keeps it robust:
  // the two fillers tie each other and their order depends on timestamps.
  expect(results[0].reason).toBe("vector");
});

test("LocalMemoryProvider: an empty query returns what it always did", async () => {
  const env = freshStoresEnv("md-memory-empty-");
  const provider = new LocalMemoryProvider(env.store.db);
  await provider.remember({ scope: "user", type: "knowledge", content: "note one", source: "agent" });
  await provider.remember({ scope: "user", type: "knowledge", content: "note two", source: "agent" });

  const results = await provider.search({ query: "", maxResults: 5 });

  // `escapeLike("")` is `%%`, which matches every row, so the LIKE lane returns
  // the strongest entries. The old tail filler scored them 1/(60 + position)
  // and single-list fusion scores them 1/(60 + rank) -- the same numbers, so
  // this is unchanged behaviour, pinned so a future reader does not read it as
  // a regression.
  expect(results.length).toBe(2);
  expect(results.every((r) => r.reason === "like")).toBe(true);
  expect(results[0].score).toBeCloseTo(1 / 61, 12);
  expect(results[1].score).toBeCloseTo(1 / 62, 12);
});

test("LocalMemoryProvider: a multi-word query leaves the page untouched", async () => {
  const env = freshStoresEnv("md-memory-multiword-");
  const provider = new LocalMemoryProvider(env.store.db);
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "runtime abstraction notes for the pty switch",
    source: "agent"
  });
  await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "abstraction alone in another runtime note",
    source: "agent"
  });

  // Neither entry contains "runtime switch" as a contiguous substring -- the
  // words are far apart in the first and absent together from the second -- so
  // the LIKE lane is empty and contributes nothing, while FTS matches both on
  // `runtime* OR switch*`. This is the guard that the new lane does not disturb
  // queries it has no business in.
  const results = await provider.search({ query: "runtime switch", maxResults: 5 });

  expect(results.length).toBeGreaterThan(0);
  expect(results.every((r) => r.reason === "fts")).toBe(true);
});

test("LocalMemoryProvider: the vector lane can reach past the old 200-row candidate cap", async () => {
  const env = freshStoresEnv("md-memory-veccap-");
  const provider = new LocalMemoryProvider(env.store.db, {
    embedder: {
      model: "test-embedding",
      // Only the needle points along [0,1]; everything else is orthogonal to it.
      // Keyed on either spelling because this embeds both the stored content and
      // the query, and the two deliberately share no word -- see below.
      async embed(text) {
        return /needle|solitary/.test(text) ? [0, 1] : [1, 0];
      }
    }
  });
  // The wording avoids the query term on purpose. `search()` fuses three lanes,
  // and a needle whose content contains "needle" is reached by FTS (`needle*`)
  // and by LIKE (`%needle%`) without the vector lane doing anything -- the
  // assertion then passes no matter what the cap does, and no filler count can
  // make it fail. "solitary" matches neither lexical lane, so the embedder above
  // is the only thing connecting this entry to the query, and the vector lane is
  // the only path onto the page. Do not tidy this back to "needle entry ...".
  const needle = await provider.remember({
    scope: "user",
    type: "knowledge",
    content: "solitary entry nobody else mentions",
    source: "agent"
  });
  // The needle is the oldest row and 205 fillers are newer, so a `limit 200` on
  // the candidate query (ordered by updated_at desc) would keep the fillers and
  // drop the needle before its cosine was ever computed.
  env.store.db.prepare("update memory_entries set updated_at = '2020-01-01T00:00:00.000Z' where id = ?").run(needle.id);
  for (let i = 0; i < 205; i += 1) {
    await provider.remember({
      scope: "user",
      type: "knowledge",
      content: `filler entry number ${i}`,
      source: "agent"
    });
  }

  const results = await provider.search({ query: "needle", maxResults: 3 });

  expect(results.map((r) => r.entry.content)).toContain("solitary entry nobody else mentions");
});

test("LocalMemoryProvider: an archived entry is still reachable by the vector lane", async () => {
  // The regression this exists for: `VectorCache` keeps only visible vectors
  // resident, so a search reaching past them has to load the other side. Miss
  // that and this entry still comes back from SQL, finds no vector, scores
  // nothing, and drops out of the semantic lane — while the lexical lanes go on
  // answering, so the search still returns *something* and the hole is silent.
  const env = freshStoresEnv("md-memory-archived-vector-");
  const provider = new LocalMemoryProvider(env.store.db, {
    embedder: {
      model: "test-embedding",
      async embed(text) {
        return text.includes("solitary") || text === "needle" ? [1, 0] : [0, 1];
      }
    }
  });
  const entry = await provider.remember({
    scope: "user",
    type: "knowledge",
    // Matches neither lexical lane against the query below, so the vector
    // lane is the only path onto the page — the same reasoning as the test
    // above, and what makes the assertion able to fail.
    content: "solitary entry nobody else mentions",
    source: "agent"
  });
  await provider.archive(entry.id);

  const hidden = await provider.search(
    { query: "needle", includeArchived: true, maxResults: 5 }
  );
  expect(hidden.map((r) => r.entry.id)).toContain(entry.id);
  expect(hidden.find((r) => r.entry.id === entry.id)?.reason).toBe("vector");

  // And the default search still does not see it, which is what the split was
  // for. Asserted here rather than trusted: if archiving stopped hiding the
  // entry, the assertion above would pass for the wrong reason.
  const visible = await provider.search({ query: "needle", maxResults: 5 });
  expect(visible.map((r) => r.entry.id)).not.toContain(entry.id);
});

// The dream compares stored embeddings to find possible duplicates; it reads
// them here rather than embedding anything itself.
test("LocalMemoryProvider: hands over the stored embedding of each available memory, or null with no embedder", async () => {
  const env = freshStoresEnv("md-memory-available-vectors-");
  expect(new LocalMemoryProvider(env.store.db).availableVectors()).toBeNull();

  const provider = new LocalMemoryProvider(env.store.db, {
    embedder: {
      model: "test-embedding",
      async embed(text) {
        return text.includes("archived") ? [0, 1] : [1, 0];
      }
    }
  });
  const kept = await provider.remember({ scope: "user", type: "knowledge", content: "kept note", source: "agent" });
  const archived = await provider.remember({ scope: "user", type: "knowledge", content: "archived note", source: "agent" });
  await provider.archive(archived.id);

  const vectors = provider.availableVectors();
  expect([...(vectors?.keys() ?? [])]).toEqual([kept.id]);
  expect(Array.from(vectors?.get(kept.id) ?? [])).toEqual([1, 0]);
  expect([...(new MemoryManager(provider).availableVectors()?.keys() ?? [])]).toEqual([kept.id]);
});

// The dream writes a memory only while it is still the version the run
// started from; that holds only if every write moves the version on.
test("every write moves a memory's version forward, even when the clock has not", async () => {
  const env = freshStoresEnv("md-memory-version-");
  const provider = new LocalMemoryProvider(env.store.db);
  const entry = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "a" });
  const ahead = new Date(Date.now() + 60_000).toISOString();
  env.store.db.prepare("update memory_entries set updated_at = ? where id = ?").run(ahead, entry.id);
  const updated = await provider.update({ id: entry.id, content: "b" });
  expect(updated!.updatedAt > ahead).toBe(true);
  const archived = await provider.archive(entry.id);
  expect(archived!.updatedAt > updated!.updatedAt).toBe(true);
});

test("two writes at once keep each other's changes", async () => {
  const env = freshStoresEnv("md-memory-concurrent-");
  const provider = new LocalMemoryProvider(env.store.db);
  const entry = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "a" });
  await Promise.all([
    provider.update({ id: entry.id, content: "b" }),
    provider.update({ id: entry.id, metadata: { note: "m" } })
  ]);
  expect(await provider.get(entry.id)).toMatchObject({ content: "b", metadata: { note: "m" } });
});

test("writeIfUnchanged writes everything together, or nothing once a memory it expects has moved on", async () => {
  const env = freshStoresEnv("md-memory-write-if-");
  const embedded: string[] = [];
  const provider = new LocalMemoryProvider(env.store.db, { embedder: { model: "test", async embed(text) { embedded.push(text); return [1, 0]; } } });
  const a = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "a" });
  const b = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "b" });
  embedded.length = 0;
  const written = await provider.writeIfUnchanged([a, b], (tx) => [
    tx.archive(a.id, { mergedInto: b.id }),
    tx.update({ id: b.id, content: "a and b" }),
    tx.remember({ scope: "user", type: "preference", source: "agent", content: "c" })
  ]);
  expect(written!.map((e) => [e.status, e.content])).toEqual([["archived", "a"], ["available", "a and b"], ["available", "c"]]);
  expect((await provider.get(a.id))?.metadata).toEqual({ mergedInto: b.id, textAsLearned: true });
  // Only new text is embedded, after the rows are written.
  expect(embedded).toStrictEqual(["a and b", "c"]);

  // b moved on since: nothing is written.
  const seen = written![1]!;
  await provider.update({ id: b.id, content: "corrected" });
  expect(await provider.writeIfUnchanged([seen], (tx) => tx.update({ id: b.id, content: "overwrite" }))).toBeNull();
  expect((await provider.get(b.id))?.content).toBe("corrected");
  // Nor over a memory no longer available, at whatever version.
  expect(await provider.writeIfUnchanged([written![0]!], (tx) => tx.update({ id: a.id, content: "x" }))).toBeNull();
  // A write that throws leaves nothing written.
  const current = (await provider.get(b.id))!;
  await expect(provider.writeIfUnchanged([current], (tx) => {
    tx.update({ id: b.id, content: "half" });
    throw new Error("boom");
  })).rejects.toThrow("boom");
  expect((await provider.get(b.id))?.content).toBe("corrected");
});

test("an embedding that finishes after its memory's text changed again is not stored", async () => {
  const env = freshStoresEnv("md-memory-embed-race-");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = new LocalMemoryProvider(env.store.db, { embedder: { model: "test", async embed(text) {
    if (text === "slow") await gate;
    return text === "slow" ? [0, 1] : [1, 0];
  } } });
  const entry = await provider.remember({ scope: "user", type: "preference", source: "agent", content: "first" });
  const slow = provider.update({ id: entry.id, content: "slow" });
  await provider.update({ id: entry.id, content: "fast" });
  release();
  await slow;
  expect(Array.from(provider.availableVectors()!.get(entry.id)!)).toEqual([1, 0]);
});

// A worker belongs to one project: a memory moved to another place is no
// longer that worker's.
test("a memory moved to another project or to the user leaves its worker; one that stays keeps it", async () => {
  const env = freshStoresEnv("md-memory-move-feature-");
  const provider = new LocalMemoryProvider(env.store.db);
  const entry = await provider.remember({ scope: "project", projectId: "proj_1", featureId: "feat_1", type: "knowledge", source: "extraction", content: "a" });
  expect((await provider.update({ id: entry.id, content: "b" }))?.featureId).toBe("feat_1");
  expect((await provider.update({ id: entry.id, scope: "project", projectId: "proj_2" }))?.featureId).toBeNull();
  const other = await provider.remember({ scope: "project", projectId: "proj_1", featureId: "feat_1", type: "knowledge", source: "extraction", content: "c" });
  expect((await provider.update({ id: other.id, scope: "user", projectId: null }))?.featureId).toBeNull();
});
