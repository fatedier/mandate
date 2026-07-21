import { describe, expect, test } from "bun:test";
import { recalledWithoutUseScore } from "../src/server/modules/memory/dream.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

/** What the other signals in scoreDreamCandidate are worth, for comparison. */
const NEGATIVE_FEEDBACK = 20;
const POSSIBLE_DUPLICATES = 18;

/**
 * A memory recalled again and again and never once used is the strongest
 * evidence a store produces on its own, and it used to be the weakest signal
 * in the scorer: `min(25, recallCount * 3)` saturated at nine recalls, so one
 * wasted 234 times ranked identically to one wasted nine times and lost to two
 * pieces of negative feedback. A real store accumulated 102 of these and
 * maintenance kept every one.
 */
describe("recalledWithoutUseScore", () => {
  test("stays silent below the evidence threshold", () => {
    expect(recalledWithoutUseScore(0)).toBe(0);
    expect(recalledWithoutUseScore(2)).toBe(0);
  });

  test("leaves the weak end roughly where the old curve had it", () => {
    // Old: min(25, n*3) — 9 at three recalls, 25 at nine. Barely-seen memories
    // must not become archive candidates just because the cap was lifted.
    expect(recalledWithoutUseScore(3)).toBeLessThanOrEqual(12);
    expect(recalledWithoutUseScore(9)).toBeLessThanOrEqual(28);
  });

  test("keeps growing past the point the old curve went flat", () => {
    const at9 = recalledWithoutUseScore(9);
    const at50 = recalledWithoutUseScore(50);
    const at234 = recalledWithoutUseScore(234);
    expect(at50).toBeGreaterThan(at9);
    expect(at234).toBeGreaterThan(at50);
  });

  test("strong evidence outranks two negative feedbacks", () => {
    // 50 wasted recalls is measured, repeated waste; two feedback events are
    // two opinions.
    expect(recalledWithoutUseScore(50)).toBeGreaterThanOrEqual(2 * NEGATIVE_FEEDBACK);
  });

  test("but never outranks four, since explicit rejection is stronger evidence", () => {
    expect(recalledWithoutUseScore(100_000)).toBeLessThan(4 * NEGATIVE_FEEDBACK);
  });

  test("a moderately wasted memory outranks a mere duplicate suspicion", () => {
    expect(recalledWithoutUseScore(20)).toBeGreaterThan(POSSIBLE_DUPLICATES);
  });

  test("is monotonic — more waste is never a weaker argument", () => {
    let previous = -1;
    for (const n of [3, 4, 5, 8, 13, 21, 34, 55, 89, 144, 233]) {
      const score = recalledWithoutUseScore(n);
      expect(score).toBeGreaterThanOrEqual(previous);
      previous = score;
    }
  });

  test("is bounded, so a runaway recall count cannot swamp every other signal", () => {
    expect(recalledWithoutUseScore(Number.MAX_SAFE_INTEGER)).toBe(75);
  });
});

/**
 * The dream's review cooldown holds for seven days unless the memory was
 * recalled, used, or given feedback since it was reviewed. The dream's own
 * `memory_search` was setting lastRecalledAt, so maintenance kept thawing
 * memories it had just decided to leave alone — on a real store, 38 of the 96
 * memories inside their cooldown window had been reopened this way.
 */
describe("the dream's own reads do not disturb the store", () => {
  test("a maintenance search records neither a recall nor a recall timestamp", async () => {
    const env = freshStoresEnv("md-dream-read-");
    try {
      const provider = new LocalMemoryProvider(env.store.db);
      const entry = await provider.remember({
        scope: "global",
        kind: "semantic",
        content: "frp Issue #5417 was an image packaging problem, not an upstream regression.",
        source: "manual"
      });
      // Exactly the call shape searchMemoryPartition makes.
      await provider.search(
        { query: "5417", scope: "global", status: "available", maxResults: 10, recordRecall: false },
        {}
      );
      const after = await provider.get(entry.id);
      expect(after?.recallCount).toBe(0);
      // lastRecalledAt is what the cooldown reads; leaving it null is the point.
      expect(after?.lastRecalledAt).toBeNull();
    } finally {
      env.cleanup();
    }
  });
});
