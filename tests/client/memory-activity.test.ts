import { describe, expect, test } from "bun:test";
import type { MemoryDreamRunDto, MemoryEntryDto } from "../../src/shared/api-contracts.js";
import {
  buildActivityFeed,
  dreamTotals,
  groupByDay
} from "../../src/client/routes/memory/dream/memory-activity.js";
import { groupRunsIntoDreams } from "../../src/client/routes/memory/dream/memory-run-model.js";

const NOW = new Date("2026-07-28T12:00:00.000Z");

let seq = 0;
function entry(over: Partial<MemoryEntryDto> = {}): MemoryEntryDto {
  return {
    id: `mem_${++seq}`,
    scope: "user",
    projectId: null,
    featureId: null,
    type: "knowledge",
    status: "available",
    content: "something",
    source: "agent",
    userQuote: null,
    sourceThreadId: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    metadata: null,
    ...over
  };
}

function run(startedAt: string, finishedAt: string | null, over: Partial<MemoryDreamRunDto> = {}): MemoryDreamRunDto {
  return {
    id: `drm_${++seq}`,
    trigger: "idle",
    status: "succeeded",
    provider: "codex",
    model: "m",
    phase: "user",
    projectId: null,
    projectName: null,
    candidateCount: 0,
    appliedCount: 0,
    actionCount: 0,
    actionCounts: { update: 0, merge: 0, archive: 0, move: 0, split: 0 },
    rejectedCount: 0,
    failedCount: 0,
    finishReason: null,
    error: null,
    metadata: null,
    startedAt,
    finishedAt,
    availableCountBefore: null,
    availableCountAfter: null,
    ...over
  };
}

const dreams = (runs: MemoryDreamRunDto[]) => groupRunsIntoDreams(runs);

describe("buildActivityFeed", () => {
  const forgotten = (over: Parameters<typeof entry>[0] = {}) =>
    entry({ status: "archived", metadata: { forgottenReason: "proved wrong" }, ...over });

  test("merges all three sources into one stream, newest first", () => {
    const feed = buildActivityFeed({
      learned: [entry({ createdAt: "2026-07-28T09:00:00.000Z" })],
      archived: [forgotten({ updatedAt: "2026-07-28T11:00:00.000Z" })],
      dreams: dreams([run("2026-07-28T10:00:00.000Z", "2026-07-28T10:05:00.000Z")])
    });
    expect(feed.map((e) => e.kind)).toEqual(["forgotten", "dream", "learned"]);
  });

  // A dream's merges and archives are in its own detail; the feed lists only
  // what an agent forgot, with the reason it gave.
  test("only a forgotten memory is an event of its own, and it carries the reason", () => {
    const feed = buildActivityFeed({
      learned: [],
      archived: [forgotten(), entry({ status: "archived", metadata: { mergedInto: "mem_x", dreamRunId: "drm_1" } })],
      dreams: []
    });
    expect(feed).toEqual([expect.objectContaining({ kind: "forgotten", reason: "proved wrong" })]);
  });

  test("a forgotten memory is dated by when it was forgotten, not its birth", () => {
    // updatedAt stands in for the archive time; createdAt would place the
    // event months before the thing that happened.
    const feed = buildActivityFeed({
      learned: [],
      archived: [forgotten({ createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-07-28T11:00:00.000Z" })],
      dreams: []
    });
    expect(feed[0]!.at).toBe("2026-07-28T11:00:00.000Z");
  });

  test("a memory that was learned and later forgotten produces both events", () => {
    const both = forgotten({
      id: "mem_both",
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-28T08:00:00.000Z"
    });
    const feed = buildActivityFeed({ learned: [both], archived: [both], dreams: [] });
    expect(feed.map((e) => e.kind)).toEqual(["forgotten", "learned"]);
    // Distinct ids, or React would collapse them onto one key.
    expect(new Set(feed.map((e) => e.id)).size).toBe(2);
  });

  test("events with an unparseable timestamp are dropped rather than sorted arbitrarily", () => {
    const feed = buildActivityFeed({
      learned: [entry({ createdAt: "not-a-date" }), entry({ createdAt: "2026-07-28T09:00:00.000Z" })],
      archived: [],
      dreams: []
    });
    expect(feed).toHaveLength(1);
  });

  test("ties break deterministically so the order does not shuffle between renders", () => {
    const at = "2026-07-28T09:00:00.000Z";
    const a = buildActivityFeed({
      learned: [entry({ id: "mem_b", createdAt: at }), entry({ id: "mem_a", createdAt: at })],
      archived: [],
      dreams: []
    });
    const b = buildActivityFeed({
      learned: [entry({ id: "mem_a", createdAt: at }), entry({ id: "mem_b", createdAt: at })],
      archived: [],
      dreams: []
    });
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });

  test("no sources, no events", () => {
    expect(buildActivityFeed({ learned: [], archived: [], dreams: [] })).toEqual([]);
  });
});

// An extraction that rewrote a memory in place is an event of its own, at
// the rewrite, showing what it added; only the last change of the text is
// kept, so only one whose time was kept, and that was an extraction's, counts.
describe("an extraction's rewrite", () => {
  const LEARNED_AT = "2026-07-20T08:00:00.000Z";
  const REWRITTEN_AT = "2026-07-28T11:00:00.000Z";
  const rewritten = (over: Parameters<typeof entry>[0] = {}) => entry({
    content: "A. B.", createdAt: LEARNED_AT, updatedAt: "2026-07-28T11:30:00.000Z",
    metadata: { updatedByExtraction: "extract_1", previous: { content: "A.", updatedAt: "2026-07-21T08:00:00.000Z", replacedAt: REWRITTEN_AT, asLearned: true } },
    ...over
  });

  test("is an Updated event at the rewrite, with what it added", () => {
    const feed = buildActivityFeed({ learned: [], updated: [rewritten()], archived: [], dreams: [] });
    expect(feed).toEqual([expect.objectContaining({ kind: "updated", at: REWRITTEN_AT, text: "B.", added: true })]);
  });

  test("one that said the memory anew shows it whole", () => {
    const feed = buildActivityFeed({ learned: [], updated: [rewritten({ content: "B, then A." })], archived: [], dreams: [] });
    expect(feed).toEqual([expect.objectContaining({ kind: "updated", text: "B, then A.", added: false })]);
  });

  test("a last change that was not an extraction's, or was kept before its time was, is no event", () => {
    const dreamed = rewritten({ metadata: { previous: { content: "A.", updatedAt: LEARNED_AT, replacedAt: REWRITTEN_AT } } });
    const legacy = rewritten({ metadata: { updatedByExtraction: "extract_0", previous: { content: "A.", updatedAt: LEARNED_AT } } });
    expect(buildActivityFeed({ learned: [], updated: [dreamed, legacy], archived: [], dreams: [] })).toEqual([]);
  });

  test("a memory learned and rewritten since gives both events, the Learned one as it was learned", () => {
    const both = rewritten();
    const feed = buildActivityFeed({ learned: [both], updated: [both], archived: [], dreams: [] });
    expect(feed.map((event) => [event.kind, "text" in event ? event.text : null])).toEqual([["updated", "B."], ["learned", "A."]]);
    expect(new Set(feed.map((event) => event.id)).size).toBe(2);
  });

  test("the Learned event shows the memory now when the version kept is not the one it was learned as", () => {
    const twice = rewritten({ metadata: { updatedByExtraction: "extract_2", previous: { content: "A. Z.", updatedAt: LEARNED_AT, replacedAt: REWRITTEN_AT } } });
    expect(buildActivityFeed({ learned: [twice], archived: [], dreams: [] })).toEqual([expect.objectContaining({ kind: "learned", text: "A. B." })]);
  });
});

describe("groupByDay", () => {
  test("labels today and yesterday, and dates anything older", () => {
    const feed = buildActivityFeed({
      learned: [
        entry({ createdAt: "2026-07-28T09:00:00.000Z" }),
        entry({ createdAt: "2026-07-27T09:00:00.000Z" }),
        entry({ createdAt: "2026-07-20T09:00:00.000Z" })
      ],
      archived: [],
      dreams: []
    });
    const labels = groupByDay(feed, NOW).map((d) => d.label);
    expect(labels[0]).toBe("Today");
    expect(labels[1]).toBe("Yesterday");
    expect(labels[2]).not.toBe("Yesterday");
  });

  test("consecutive events on one day share a single section", () => {
    const feed = buildActivityFeed({
      learned: [
        entry({ createdAt: "2026-07-28T09:00:00.000Z" }),
        entry({ createdAt: "2026-07-28T08:00:00.000Z" })
      ],
      archived: [],
      dreams: []
    });
    const days = groupByDay(feed, NOW);
    expect(days).toHaveLength(1);
    expect(days[0]!.events).toHaveLength(2);
  });

  test("every event survives the grouping", () => {
    const feed = buildActivityFeed({
      learned: [
        entry({ createdAt: "2026-07-28T09:00:00.000Z" }),
        entry({ createdAt: "2026-07-26T09:00:00.000Z" })
      ],
      archived: [entry({ status: "archived", updatedAt: "2026-07-27T09:00:00.000Z" })],
      dreams: []
    });
    const total = groupByDay(feed, NOW).reduce((n, d) => n + d.events.length, 0);
    expect(total).toBe(feed.length);
  });
});

describe("dreamTotals", () => {
  test("sums reviewed and changed across a dream's partitions", () => {
    const batch = dreams([
      run("2026-07-28T10:05:00.000Z", "2026-07-28T10:10:00.000Z", {
        appliedCount: 5,
        actionCounts: { update: 2, merge: 0, archive: 0, move: 0, split: 0 }
      }),
      run("2026-07-28T10:00:00.000Z", "2026-07-28T10:05:00.000Z", {
        appliedCount: 4,
        actionCounts: { update: 1, merge: 1, archive: 1, move: 0, split: 0 }
      })
    ])[0]!;
    // keeps are reviewed but not changed — that distinction is the point.
    expect(dreamTotals(batch)).toEqual({ reviewed: 9, changed: 5 });
  });

  test("moves and splits are changes", () => {
    const batch = dreams([
      run("2026-07-28T10:00:00.000Z", "2026-07-28T10:05:00.000Z", {
        appliedCount: 2,
        actionCounts: { update: 0, merge: 0, archive: 0, move: 1, split: 1 }
      })
    ])[0]!;
    expect(dreamTotals(batch)).toEqual({ reviewed: 2, changed: 2 });
  });
});

test("older days are dated in English, whatever the browser locale", () => {
  // The product's copy is English-only; the ambient locale rendered its own date format
  // between an English "Today" and "Yesterday".
  const feed = buildActivityFeed({
    learned: [entry({ createdAt: "2026-07-20T09:00:00.000Z" })],
    archived: [],
    dreams: []
  });
  const label = groupByDay(feed, NOW)[0]!.label;
  expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
});

describe("a dream still in flight", () => {
  const live = (over: Partial<MemoryDreamRunDto> = {}) =>
    run("2026-07-28T16:34:00.000Z", null, { status: "running", ...over });

  test("is marked running, and reports no end time it does not have", () => {
    // It used to fall back to startedAt, rendering a live dream as one that
    // had finished in zero seconds.
    const [batch] = groupRunsIntoDreams([live()]);
    expect(batch!.running).toBe(true);
    expect(batch!.finishedAt).toBeNull();
  });

  test("reports no reviewed count until there is one", () => {
    // appliedCount is written at finish while the action counts update live,
    // so reporting both gave "0 reviewed, 23 changed".
    const [batch] = groupRunsIntoDreams([
      live({ appliedCount: 0, actionCounts: { update: 14, merge: 1, archive: 8, move: 0, split: 0 } })
    ]);
    const totals = dreamTotals(batch!);
    expect(totals.reviewed).toBeNull();
    expect(totals.changed).toBe(23);
  });

  test("one running partition makes the whole dream running", () => {
    const [batch] = groupRunsIntoDreams([
      live({ startedAt: "2026-07-28T16:34:00.000Z" }),
      run("2026-07-28T16:30:00.000Z", "2026-07-28T16:34:00.000Z")
    ]);
    expect(batch!.running).toBe(true);
  });
});
