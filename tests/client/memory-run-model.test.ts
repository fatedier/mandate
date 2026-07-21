import { describe, expect, test } from "bun:test";
import type {
  MemoryDreamActionDto,
  MemoryDreamRunDto
} from "../../src/shared/api-contracts.js";
import {
  actionContent,
  actionEffect,
  actionFacets,
  formatDreamDuration,
  groupRunsIntoDreams,
  isChange,
  partitionActions
} from "../../src/client/routes/memory/dream/memory-run-model.js";

let seq = 0;
function action(overrides: Partial<MemoryDreamActionDto> = {}): MemoryDreamActionDto {
  return {
    id: `act-${++seq}`,
    runId: "drm-1",
    actionType: "keep",
    status: "applied",
    memoryId: "mem_abcdefgh",
    targetMemoryId: null,
    reason: "Still accurate.",
    confidence: 0.9,
    source: null,
    error: null,
    before: { content: "original", kind: "semantic", scope: "project" },
    after: null,
    createdAt: new Date().toISOString(),
    appliedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("actionEffect", () => {
  test("recognises the known effects regardless of case", () => {
    expect(actionEffect(action({ actionType: "update" }))).toBe("update");
    expect(actionEffect(action({ actionType: "ARCHIVE" }))).toBe("archive");
    expect(actionEffect(action({ actionType: "rescope" }))).toBe("rescope");
  });

  test("an unknown action type is 'other' and still counts as a change", () => {
    const unknown = action({ actionType: "quarantine" });
    expect(actionEffect(unknown)).toBe("other");
    // Filing an unrecognised action under "nothing happened" would hide it.
    expect(isChange(unknown)).toBe(true);
  });

  test("only keep is not a change", () => {
    expect(isChange(action({ actionType: "keep" }))).toBe(false);
    expect(isChange(action({ actionType: "merge" }))).toBe(true);
  });
});

describe("partitionActions", () => {
  test("separates changes from keeps — the reason the detail view exists", () => {
    // The shape of a real run: ten keeps around a single archive.
    const actions = [
      ...Array.from({ length: 10 }, () => action({ actionType: "keep" })),
      action({ actionType: "archive" })
    ];
    const { changed, unchanged } = partitionActions(actions);
    expect(changed).toHaveLength(1);
    expect(unchanged).toHaveLength(10);
  });

  test("changes are ordered update, merge, archive, rescope", () => {
    const actions = [
      action({ actionType: "rescope" }),
      action({ actionType: "archive" }),
      action({ actionType: "keep" }),
      action({ actionType: "update" }),
      action({ actionType: "merge" })
    ];
    expect(partitionActions(actions).changed.map((a) => a.actionType)).toEqual([
      "update",
      "merge",
      "archive",
      "rescope"
    ]);
  });

  test("unknown effects sort last but are never dropped", () => {
    const actions = [action({ actionType: "quarantine" }), action({ actionType: "update" })];
    expect(partitionActions(actions).changed.map((a) => a.actionType)).toEqual([
      "update",
      "quarantine"
    ]);
  });

  test("keeps their original order and loses nothing", () => {
    const actions = [
      action({ actionType: "keep", id: "k1" }),
      action({ actionType: "update", id: "u1" }),
      action({ actionType: "keep", id: "k2" })
    ];
    const { changed, unchanged } = partitionActions(actions);
    expect(unchanged.map((a) => a.id)).toEqual(["k1", "k2"]);
    expect(changed.length + unchanged.length).toBe(actions.length);
  });
});

describe("actionContent", () => {
  test("an update shows the new text as current and keeps the old reachable", () => {
    const updated = action({
      actionType: "update",
      before: { content: "old wording" },
      after: { content: "new wording" }
    });
    expect(actionContent(updated)).toEqual({ current: "new wording", previous: "old wording" });
  });

  test("a keep has no previous version to offer", () => {
    expect(actionContent(action())).toEqual({ current: "original", previous: "" });
  });

  test("an identical after is not a rewrite", () => {
    const same = action({ before: { content: "same" }, after: { content: "same" } });
    expect(actionContent(same)).toEqual({ current: "same", previous: "" });
  });

  test("falls back to before when the action recorded no after", () => {
    const archived = action({ actionType: "archive", after: null });
    expect(actionContent(archived).current).toBe("original");
  });

  test("survives malformed entries rather than throwing in the dialog", () => {
    expect(actionContent(action({ before: "not an object", after: null }))).toEqual({
      current: "",
      previous: ""
    });
  });
});

describe("actionFacets", () => {
  test("reads kind and scope as one phrase", () => {
    expect(actionFacets(action())).toBe("semantic · project");
  });

  test("prefers the after entry, which is what the memory is now", () => {
    const updated = action({
      before: { content: "x", kind: "semantic", scope: "feature" },
      after: { content: "y", kind: "semantic", scope: "project" }
    });
    expect(actionFacets(updated)).toBe("semantic · project");
  });

  test("omits missing halves instead of rendering a stray separator", () => {
    expect(actionFacets(action({ before: { content: "x", kind: "procedural" } }))).toBe(
      "procedural"
    );
    expect(actionFacets(action({ before: { content: "x" } }))).toBe("");
  });
});

let runSeq = 0;
function run(
  startedAt: string,
  finishedAt: string,
  overrides: Partial<MemoryDreamRunDto> = {}
): MemoryDreamRunDto {
  return {
    id: `drm-${++runSeq}`,
    trigger: "idle",
    status: "succeeded",
    provider: "codex",
    model: "codex/gpt-5.6-sol",
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
    availableCountBefore: 0,
    availableCountAfter: 0,
    ...overrides
  };
}

/**
 * A dream sweeps every project in turn and then global, recorded as one run
 * per partition whose timestamps abut exactly. Flat, that showed as three rows
 * all reading "9h ago" with nothing saying they were one scheduled event.
 */
describe("groupRunsIntoDreams", () => {
  // Newest-first, as the API returns them.
  const oneDream = [
    run("2026-07-27T07:01:47.753Z", "2026-07-27T07:04:24.430Z", { phase: "global" }),
    run("2026-07-27T07:00:52.753Z", "2026-07-27T07:01:47.753Z", {
      phase: "project",
      projectName: "mandate"
    }),
    run("2026-07-27T06:58:36.023Z", "2026-07-27T07:00:52.753Z", {
      phase: "project",
      projectName: "frp"
    })
  ];

  test("chains abutting runs into a single dream", () => {
    const dreams = groupRunsIntoDreams(oneDream);
    expect(dreams).toHaveLength(1);
    expect(dreams[0]!.runs).toHaveLength(3);
  });

  test("the dream spans from its first run's start to its last run's finish", () => {
    const [dream] = groupRunsIntoDreams(oneDream);
    expect(dream!.startedAt).toBe("2026-07-27T06:58:36.023Z");
    expect(dream!.finishedAt).toBe("2026-07-27T07:04:24.430Z");
    expect(formatDreamDuration(dream!.startedAt, dream!.finishedAt)).toBe("5m 48s");
  });

  test("runs are ordered the way they ran — projects, then global", () => {
    const [dream] = groupRunsIntoDreams(oneDream);
    expect(dream!.runs.map((r) => r.projectName ?? r.phase)).toEqual([
      "frp",
      "mandate",
      "global"
    ]);
  });

  test("a twelve-hour gap starts a new dream", () => {
    const dreams = groupRunsIntoDreams([
      ...oneDream,
      run("2026-07-26T17:48:13.658Z", "2026-07-26T17:49:14.217Z"),
      run("2026-07-26T17:47:11.610Z", "2026-07-26T17:48:13.658Z")
    ]);
    expect(dreams.map((d) => d.runs.length)).toEqual([3, 2]);
  });

  test("slack under a minute still chains; more than a minute does not", () => {
    const near = groupRunsIntoDreams([
      run("2026-07-27T07:00:30.000Z", "2026-07-27T07:01:00.000Z"),
      run("2026-07-27T06:59:00.000Z", "2026-07-27T07:00:00.000Z") // 30s gap
    ]);
    expect(near).toHaveLength(1);
    const far = groupRunsIntoDreams([
      run("2026-07-27T07:02:00.000Z", "2026-07-27T07:03:00.000Z"),
      run("2026-07-27T06:59:00.000Z", "2026-07-27T07:00:00.000Z") // 2m gap
    ]);
    expect(far).toHaveLength(2);
  });

  test("overlapping runs are not chained — a negative gap is not a sequence", () => {
    const dreams = groupRunsIntoDreams([
      run("2026-07-27T06:59:30.000Z", "2026-07-27T07:01:00.000Z"),
      run("2026-07-27T06:59:00.000Z", "2026-07-27T07:00:00.000Z")
    ]);
    expect(dreams).toHaveLength(2);
  });

  test("a lone legacy run is its own dream, and none are lost", () => {
    const runs = [
      run("2026-07-23T15:09:10.664Z", "2026-07-23T15:33:47.965Z", { phase: "legacy" }),
      run("2026-07-23T01:14:06.150Z", "2026-07-23T01:18:25.560Z", { phase: "legacy" })
    ];
    const dreams = groupRunsIntoDreams(runs);
    expect(dreams).toHaveLength(2);
    expect(dreams.flatMap((d) => d.runs)).toHaveLength(runs.length);
  });

  test("no runs, no dreams", () => {
    expect(groupRunsIntoDreams([])).toEqual([]);
  });

  test("an unparseable timestamp breaks the chain instead of throwing", () => {
    const dreams = groupRunsIntoDreams([
      run("2026-07-27T07:01:00.000Z", "2026-07-27T07:02:00.000Z"),
      run("not-a-date", "also-not-a-date")
    ]);
    expect(dreams).toHaveLength(2);
  });

  test("dream ids are stable across refreshes so React keys do not churn", () => {
    expect(groupRunsIntoDreams(oneDream)[0]!.id).toBe(groupRunsIntoDreams(oneDream)[0]!.id);
  });
});

describe("formatDreamDuration", () => {
  test("renders seconds, whole minutes, and minutes with seconds", () => {
    expect(formatDreamDuration("2026-07-27T07:00:00Z", "2026-07-27T07:00:12Z")).toBe("12s");
    expect(formatDreamDuration("2026-07-27T07:00:00Z", "2026-07-27T07:02:00Z")).toBe("2m");
    expect(formatDreamDuration("2026-07-27T07:00:00Z", "2026-07-27T07:05:48Z")).toBe("5m 48s");
  });

  test("returns nothing rather than a negative or NaN duration", () => {
    expect(formatDreamDuration("2026-07-27T07:05:00Z", "2026-07-27T07:00:00Z")).toBe("");
    expect(formatDreamDuration("nope", "2026-07-27T07:00:00Z")).toBe("");
  });
});
