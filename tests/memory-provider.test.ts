import { expect, test } from "bun:test";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

test("LocalMemoryProvider: searches only visible contextual memories by default", async () => {
  const env = freshStoresEnv("md-memory-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    await provider.remember({
      scope: "global",
      kind: "preference",
      content: "Prefer short Chinese replies for status updates.",
      source: "manual"
    });
    const p1 = "project-1";
    const f1 = "feature-1";
    await provider.remember({
      scope: "feature",
      projectId: p1,
      featureId: f1,
      kind: "semantic",
      content: "Use tabs for the activity filter redesign.",
      source: "manual"
    });
    await provider.remember({
      scope: "feature",
      projectId: "project-2",
      featureId: "feature-2",
      kind: "semantic",
      content: "Use tabs for an unrelated project.",
      source: "manual"
    });

    const results = await provider.search({ query: "tabs", maxResults: 10 }, {
      projectId: p1,
      featureId: f1
    });

    expect(results.map((r) => r.entry.content)).toContain("Use tabs for the activity filter redesign.");
    expect(results.map((r) => r.entry.content)).not.toContain("Use tabs for an unrelated project.");
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: update, archive, and forget preserve audit state", async () => {
  const env = freshStoresEnv("md-memory-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    const entry = await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "Old wording",
      source: "manual"
    });

    const updated = await provider.update({
      id: entry.id,
      content: "New wording",
      kind: "procedural",
      strength: 0.9
    });
    expect(updated?.content).toBe("New wording");
    expect(updated?.kind).toBe("procedural");
    expect(updated?.strength).toBe(0.9);

    const archived = await provider.archive(entry.id, { reason: "superseded" });
    expect(archived?.status).toBe("archived");
    expect(archived?.metadata?.reason).toBe("superseded");

    const forgotten = await provider.forget(entry.id, { reason: "user request" });
    expect(forgotten?.status).toBe("deleted");
    expect(forgotten?.content).toBe("[deleted]");
    expect(forgotten?.metadata?.reason).toBe("user request");
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: feedback separates recall from actual use", async () => {
  const env = freshStoresEnv("md-memory-feedback-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    const entry = await provider.remember({
      scope: "global",
      kind: "procedural",
      content: "Use tmux send-keys for existing panes.",
      source: "manual",
      strength: 0.5,
      confidence: 0.7
    });

    const recalled = await provider.search({ query: "tmux send-keys", maxResults: 1 });
    expect(recalled[0]?.entry.id).toBe(entry.id);
    const afterRecall = await provider.get(entry.id);
    expect(afterRecall?.recallCount).toBe(1);
    expect(afterRecall?.useCount).toBe(0);

    const helpful = await provider.feedback({
      id: entry.id,
      outcome: "helpful",
      threadId: "thread-1",
      wakeId: "wake-1",
      note: "used to choose pane interaction"
    });
    expect(helpful?.useCount).toBe(1);
    expect(helpful?.lastUsedAt).toBeTruthy();
    expect(helpful?.feedback.helpful).toBe(1);
    expect(helpful?.strength).toBeGreaterThan(0.5);
    expect(helpful?.metadata?.lastFeedbackOutcome).toBe("helpful");
    expect(helpful?.metadata?.lastFeedbackSource).toBe("agent_feedback");
    expect(helpful?.metadata?.lastFeedbackThreadId).toBe("thread-1");
    expect(helpful?.metadata?.lastFeedbackWakeId).toBe("wake-1");
    expect(Array.isArray(helpful?.metadata?.feedbackEvents)).toBe(true);

    const wrong = await provider.feedback({
      id: entry.id,
      outcome: "wrong",
      note: "current pane showed the remembered procedure does not apply"
    });
    expect(wrong?.status).toBe("available");
    expect(wrong?.feedback.wrong).toBe(1);
    expect(wrong?.confidence).toBeLessThan(helpful!.confidence);
    expect((wrong?.metadata?.feedbackEvents as unknown[] | undefined)?.length).toBe(2);
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: feedback keeps only the latest 20 events", async () => {
  const env = freshStoresEnv("md-memory-feedback-cap-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    const entry = await provider.remember({
      scope: "global",
      kind: "preference",
      content: "Keep feedback event history bounded.",
      source: "manual"
    });

    for (let i = 0; i < 25; i++) {
      await provider.feedback({
        id: entry.id,
        outcome: "used",
        note: `event ${i}`,
        threadId: `thread-${i}`,
        wakeId: `wake-${i}`
      });
    }

    const updated = await provider.get(entry.id);
    const events = updated?.metadata?.feedbackEvents as Array<Record<string, unknown>> | undefined;
    expect(events?.length).toBe(20);
    expect(events?.[0]?.note).toBe("event 5");
    expect(events?.[19]?.note).toBe("event 24");
    expect(updated?.feedback.used).toBe(25);
  } finally {
    env.cleanup();
  }
});

test("MemoryManager: prompt section includes memory ids for feedback", async () => {
  const env = freshStoresEnv("md-memory-prompt-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    const manager = new MemoryManager(provider);
    const entry = await provider.remember({
      scope: "global",
      kind: "preference",
      content: "Prefer end-to-end tests for integration behavior.",
      source: "manual"
    });

    const prompt = await manager.buildPromptSection({});
    expect(prompt).toContain(`[id: ${entry.id}]`);
    expect(prompt).toContain("memory_feedback with the exact id");
  } finally {
    env.cleanup();
  }
});

test("MemoryManager: prompt section truncates oversized memory entries", async () => {
  const env = freshStoresEnv("md-memory-prompt-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    const manager = new MemoryManager(provider);
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "x".repeat(1200),
      source: "manual"
    });

    const prompt = await manager.buildPromptSection({}, { maxEntryChars: 80 });
    expect(prompt).toContain("...");
    expect(prompt.length).toBeLessThan(1000);
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: optional embedder adds vector search results", async () => {
  const env = freshStoresEnv("md-memory-");
  try {
    const provider = new LocalMemoryProvider(env.store.db, {
      embedder: {
        model: "test-embedding",
        async embed(text) {
          if (text.includes("voice") || text.includes("audio")) return [1, 0];
          return [0, 1];
        }
      }
    });
    await provider.remember({
      scope: "global",
      kind: "procedural",
      content: "Realtime audio should avoid reading long machine identifiers.",
      source: "manual",
      strength: 0.8
    });
    await provider.remember({
      scope: "global",
      kind: "procedural",
      content: "Terminal panes should prefer visible tmux interactions.",
      source: "manual",
      strength: 0.8
    });

    const results = await provider.search({ query: "voice conversation", maxResults: 2 });
    expect(results[0]?.entry.content).toContain("Realtime audio");
    expect(results[0]?.reason).toBe("vector");
  } finally {
    env.cleanup();
  }
});

test("MandateStore initializes memory tables", () => {
  const env = freshStoresEnv("md-memory-");
  try {
    const row = env.store.db
      .prepare("select name from sqlite_master where type = 'table' and name = 'memory_entries'")
      .get() as { name: string } | null;
    expect(row?.name).toBe("memory_entries");
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: search returns the best bm25 match first", async () => {
  const env = freshStoresEnv("md-memory-rank-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    const filler = "unrelated prose about scheduling and disk layout and window titles ";
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "quilloscope quilloscope quilloscope quilloscope",
      source: "manual"
    });
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: `${filler.repeat(6)} quilloscope ${filler.repeat(6)}`,
      source: "manual"
    });

    const results = await provider.search({ query: "quilloscope", maxResults: 10 }, {});

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
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: two paths agreeing outrank a single path's best hit", async () => {
  const env = freshStoresEnv("md-memory-fuse-");
  try {
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
      scope: "global",
      kind: "semantic",
      content: "zephyrine zephyrine zephyrine alpha",
      source: "manual"
    });
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "a longer note that mentions zephyrine once and is otherwise about beta",
      source: "manual"
    });

    const results = await provider.search({ query: "zephyrine", maxResults: 10 }, {});

    // The "alpha" note is the better bm25 match and so comes first out of FTS, but
    // the other note is the one both paths found -- fusion has to reorder them.
    expect(results.length).toBe(2);
    expect(results[0].entry.content).toContain("beta");
    expect(results[0].reason).toBe("vector");
    expect(results[1].reason).toBe("fts");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: a vector-only hit still lands on a page FTS filled", async () => {
  const env = freshStoresEnv("md-memory-vector-depth-");
  try {
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
      scope: "global",
      kind: "semantic",
      content: "quasar drift observed from the north ridge",
      source: "manual",
      strength: 0.9
    });
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "zephyrine zephyrine zephyrine dense",
      source: "manual",
      strength: 0.5
    });
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "a sparse note mentioning zephyrine once amid unrelated prose",
      source: "manual",
      strength: 0.5
    });

    // FTS matches both zephyrine notes and so returns a full page of 2. The
    // quasar note is the vector path's rank 1 and is unreachable by FTS or LIKE.
    const results = await provider.search({ query: "zephyrine", maxResults: 2 }, {});

    expect(results.length).toBe(2);
    expect(results.map((r) => r.entry.content)).toContain("quasar drift observed from the north ridge");
    expect(results.find((r) => r.entry.content.startsWith("quasar"))?.reason).toBe("vector");
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: a substring-only match ranks below the entry fts reached", async () => {
  const env = freshStoresEnv("md-memory-filler-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    // "gg" is a token of the first note but only an interior substring of "biggie",
    // so the second note is reachable by LIKE and not by a prefix FTS match.
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "gg is how the tournament log opens",
      source: "manual",
      strength: 0.1
    });
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "biggie stores the tournament log elsewhere",
      source: "manual",
      strength: 0.9
    });

    const results = await provider.search({ query: "gg", maxResults: 10 }, {});

    expect(results.length).toBe(2);
    expect(results[0].reason).toBe("fts");
    expect(results[1].reason).toBe("like");
    expect(results[1].score).toBeLessThan(results[0].score);
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: a substring-only hit survives a page the vector lane filled", async () => {
  const env = freshStoresEnv("md-memory-substr-");
  try {
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
      scope: "global",
      kind: "semantic",
      content: "统一升级到新版本的运行时抽象",
      source: "manual"
    });
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "first filler note about unrelated scheduling",
      source: "manual"
    });
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "second filler note about unrelated disk layout",
      source: "manual"
    });

    // maxResults 2 is what makes this discriminating: the vector lane alone
    // already fills the page, which is exactly when the old tail filler stopped
    // running.
    const results = await provider.search({ query: "升级", maxResults: 2 }, {});

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
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: an empty query returns what it always did", async () => {
  const env = freshStoresEnv("md-memory-empty-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    await provider.remember({ scope: "global", kind: "semantic", content: "note one", source: "manual" });
    await provider.remember({ scope: "global", kind: "semantic", content: "note two", source: "manual" });

    const results = await provider.search({ query: "", maxResults: 5 }, {});

    // `escapeLike("")` is `%%`, which matches every row, so the LIKE lane returns
    // the strongest entries. The old tail filler scored them 1/(60 + position)
    // and single-list fusion scores them 1/(60 + rank) -- the same numbers, so
    // this is unchanged behaviour, pinned so a future reader does not read it as
    // a regression.
    expect(results.length).toBe(2);
    expect(results.every((r) => r.reason === "like")).toBe(true);
    expect(results[0].score).toBeCloseTo(1 / 61, 12);
    expect(results[1].score).toBeCloseTo(1 / 62, 12);
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: a multi-word query leaves the page untouched", async () => {
  const env = freshStoresEnv("md-memory-multiword-");
  try {
    const provider = new LocalMemoryProvider(env.store.db);
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "runtime abstraction notes for the pty switch",
      source: "manual"
    });
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "abstraction alone in another runtime note",
      source: "manual"
    });

    // Neither entry contains "runtime switch" as a contiguous substring -- the
    // words are far apart in the first and absent together from the second -- so
    // the LIKE lane is empty and contributes nothing, while FTS matches both on
    // `runtime* OR switch*`. This is the guard that the new lane does not disturb
    // queries it has no business in.
    const results = await provider.search({ query: "runtime switch", maxResults: 5 }, {});

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.reason === "fts")).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: the vector lane can reach past the old 200-row candidate cap", async () => {
  const env = freshStoresEnv("md-memory-veccap-");
  try {
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
    // 205 filler memories with a high strength, so the old `order by strength desc
    // limit 200` would have kept them and dropped the needle.
    for (let i = 0; i < 205; i += 1) {
      await provider.remember({
        scope: "global",
        kind: "semantic",
        content: `filler entry number ${i}`,
        source: "manual",
        strength: 0.9
      });
    }
    // The wording avoids the query term on purpose. `search()` fuses three lanes,
    // and a needle whose content contains "needle" is reached by FTS (`needle*`)
    // and by LIKE (`%needle%`) without the vector lane doing anything -- the
    // assertion then passes no matter what the cap does, and no filler count can
    // make it fail. "solitary" matches neither lexical lane, so the embedder above
    // is the only thing connecting this entry to the query, and the vector lane is
    // the only path onto the page. Do not tidy this back to "needle entry ...".
    await provider.remember({
      scope: "global",
      kind: "semantic",
      content: "solitary entry nobody else mentions",
      source: "manual",
      strength: 0.1
    });

    const results = await provider.search({ query: "needle", maxResults: 3 }, {});

    expect(results.map((r) => r.entry.content)).toContain("solitary entry nobody else mentions");
  } finally {
    env.cleanup();
  }
});

test("LocalMemoryProvider: an archived entry is still reachable by the vector lane", async () => {
  // The regression this exists for: `VectorCache` keeps only visible vectors
  // resident, so a search reaching past them has to load the other side. Miss
  // that and this entry still comes back from SQL, finds no vector, scores
  // nothing, and drops out of the semantic lane — while the lexical lanes go on
  // answering, so the search still returns *something* and the hole is silent.
  const env = freshStoresEnv("md-memory-archived-vector-");
  try {
    const provider = new LocalMemoryProvider(env.store.db, {
      embedder: {
        model: "test-embedding",
        async embed(text) {
          return text.includes("solitary") || text === "needle" ? [1, 0] : [0, 1];
        }
      }
    });
    const entry = await provider.remember({
      scope: "global",
      kind: "semantic",
      // Matches neither lexical lane against the query below, so the vector
      // lane is the only path onto the page — the same reasoning as the test
      // above, and what makes the assertion able to fail.
      content: "solitary entry nobody else mentions",
      source: "manual"
    });
    await provider.archive(entry.id);

    const hidden = await provider.search(
      { query: "needle", includeArchived: true, maxResults: 5 },
      {}
    );
    expect(hidden.map((r) => r.entry.id)).toContain(entry.id);
    expect(hidden.find((r) => r.entry.id === entry.id)?.reason).toBe("vector");

    // And the default search still does not see it, which is what the split was
    // for. Asserted here rather than trusted: if archiving stopped hiding the
    // entry, the assertion above would pass for the wrong reason.
    const visible = await provider.search({ query: "needle", maxResults: 5 }, {});
    expect(visible.map((r) => r.entry.id)).not.toContain(entry.id);
  } finally {
    env.cleanup();
  }
});
