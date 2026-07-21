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
    scope: "global",
    projectId: null,
    featureId: null,
    kind: "semantic",
    status: "available",
    content: "something",
    strength: 1,
    confidence: 0.9,
    cues: [],
    source: "manual",
    createdAt: "2026-07-28T10:00:00.000Z",
    updatedAt: "2026-07-28T10:00:00.000Z",
    lastRecalledAt: null,
    recallCount: 0,
    lastUsedAt: null,
    useCount: 0,
    feedback: {},
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
    phase: "global",
    projectId: null,
    projectName: null,
    candidateCount: 0,
    appliedCount: 0,
    actionCount: 0,
    actionCounts: { keep: 0, update: 0, merge: 0, archive: 0, rescope: 0 },
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
  test("merges all three sources into one stream, newest first", () => {
    const feed = buildActivityFeed({
      learned: [entry({ createdAt: "2026-07-28T09:00:00.000Z" })],
      archived: [entry({ status: "archived", updatedAt: "2026-07-28T11:00:00.000Z" })],
      dreams: dreams([run("2026-07-28T10:00:00.000Z", "2026-07-28T10:05:00.000Z")])
    });
    expect(feed.map((e) => e.kind)).toEqual(["archived", "dream", "learned"]);
  });

  test("an archived memory is dated by its archive, not its birth", () => {
    // updatedAt stands in for the archive time; createdAt would place the
    // event months before the thing that happened.
    const feed = buildActivityFeed({
      learned: [],
      archived: [
        entry({
          status: "archived",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-07-28T11:00:00.000Z"
        })
      ],
      dreams: []
    });
    expect(feed[0]!.at).toBe("2026-07-28T11:00:00.000Z");
  });

  test("a memory that was learned and later archived produces both events", () => {
    const both = entry({
      id: "mem_both",
      status: "archived",
      createdAt: "2026-07-20T08:00:00.000Z",
      updatedAt: "2026-07-28T08:00:00.000Z"
    });
    const feed = buildActivityFeed({ learned: [both], archived: [both], dreams: [] });
    expect(feed.map((e) => e.kind)).toEqual(["archived", "learned"]);
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
        actionCounts: { keep: 3, update: 2, merge: 0, archive: 0, rescope: 0 }
      }),
      run("2026-07-28T10:00:00.000Z", "2026-07-28T10:05:00.000Z", {
        appliedCount: 4,
        actionCounts: { keep: 1, update: 1, merge: 1, archive: 1, rescope: 0 }
      })
    ])[0]!;
    // keeps are reviewed but not changed — that distinction is the point.
    expect(dreamTotals(batch)).toEqual({ reviewed: 9, changed: 5 });
  });
});

test("older days are dated in English, whatever the browser locale", () => {
  // The product's copy is English-only; the ambient locale rendered "7月26日"
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
    run("2026-07-28T16:34:00.000Z", null as never, { status: "running", ...over });

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
      live({ appliedCount: 0, actionCounts: { keep: 0, update: 14, merge: 1, archive: 8, rescope: 0 } })
    ]);
    const totals = dreamTotals(batch!);
    expect(totals.reviewed).toBeNull();
    expect(totals.changed).toBe(23);
  });

  test("a finished dream still reports both", () => {
    const [batch] = groupRunsIntoDreams([
      run("2026-07-28T10:00:00.000Z", "2026-07-28T10:05:00.000Z", {
        appliedCount: 18,
        actionCounts: { keep: 11, update: 5, merge: 0, archive: 2, rescope: 0 }
      })
    ]);
    expect(dreamTotals(batch!).reviewed).toBe(18);
  });

  test("one running partition makes the whole dream running", () => {
    const [batch] = groupRunsIntoDreams([
      live({ startedAt: "2026-07-28T16:34:00.000Z" }),
      run("2026-07-28T16:30:00.000Z", "2026-07-28T16:34:00.000Z")
    ]);
    expect(batch!.running).toBe(true);
  });
});
