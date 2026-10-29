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
  orderActions
} from "../../src/client/routes/memory/dream/memory-run-model.js";

let seq = 0;
function action(overrides: Partial<MemoryDreamActionDto> = {}): MemoryDreamActionDto {
  return {
    id: `act-${++seq}`,
    runId: "drm-1",
    actionType: "update",
    status: "applied",
    memoryId: "mem_abcdefgh",
    targetMemoryId: null,
    reason: "Still accurate.",
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
    expect(actionEffect(action({ actionType: "move" }))).toBe("move");
    expect(actionEffect(action({ actionType: "split" }))).toBe("split");
  });

  test("an unknown action type is 'other'", () => {
    expect(actionEffect(action({ actionType: "quarantine" }))).toBe("other");
  });

});

describe("orderActions", () => {
  test("changes are ordered update, merge, archive, move, split", () => {
    const actions = [
      action({ actionType: "split" }),
      action({ actionType: "archive" }),
      action({ actionType: "move" }),
      action({ actionType: "update" }),
      action({ actionType: "merge" })
    ];
    expect(orderActions(actions).map((a) => a.actionType)).toEqual(["update", "merge", "archive", "move", "split"]);
  });

  test("unknown effects sort last but are never dropped", () => {
    const actions = [action({ actionType: "quarantine" }), action({ actionType: "update" })];
    expect(orderActions(actions).map((a) => a.actionType)).toEqual(["update", "quarantine"]);
  });
});

describe("actionContent", () => {
  const rows: Array<{ name: string; overrides: Partial<MemoryDreamActionDto>; current: string; previous: string }> = [
    {
      name: "an update shows the new text as current and keeps the old reachable",
      overrides: { actionType: "update", before: { content: "old wording" }, after: { content: "new wording" } },
      current: "new wording",
      previous: "old wording"
    },
    { name: "an action with no new text has no previous version to offer", overrides: {}, current: "original", previous: "" },
    {
      name: "an identical after is not a rewrite",
      overrides: { before: { content: "same" }, after: { content: "same" } },
      current: "same",
      previous: ""
    },
    {
      name: "survives malformed entries rather than throwing in the dialog",
      overrides: { before: "not an object", after: null },
      current: "",
      previous: ""
    }
  ];

  test.each(rows)("$name", ({ overrides, current, previous }) => {
    expect(actionContent(action(overrides))).toEqual({ current, previous });
  });
});

describe("actionFacets", () => {
  test("a memory today reads as its type and where it lives, a move as from where to where", () => {
    const names = (id: string) => (id === "proj_project1" ? "project-1" : undefined);
    expect(actionFacets(action({ before: { content: "x", type: "preference", scope: "user" } }), names)).toBe("preference · yours");
    expect(actionFacets(action({ before: { content: "x", type: "knowledge", scope: "project", projectId: "proj_project1" } }), names)).toBe("knowledge · project-1");
    expect(actionFacets(action({
      actionType: "move",
      before: { content: "x", type: "preference", scope: "user" },
      after: { content: "x", type: "preference", scope: "project", projectId: "proj_project1" }
    }), names)).toBe("preference · yours → project-1");
  });

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
    run("2026-07-27T07:01:47.753Z", "2026-07-27T07:04:24.430Z", { phase: "user" }),
    run("2026-07-27T07:00:52.753Z", "2026-07-27T07:01:47.753Z", {
      phase: "project",
      projectName: "mandate"
    }),
    run("2026-07-27T06:58:36.023Z", "2026-07-27T07:00:52.753Z", {
      phase: "project",
      projectName: "project-1"
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

  test("runs are ordered the way they ran", () => {
    const [dream] = groupRunsIntoDreams(oneDream);
    expect(dream!.runs.map((r) => r.projectName ?? r.phase)).toEqual([
      "project-1",
      "mandate",
      "user"
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

  test("runs far apart are dreams of their own, and none are lost", () => {
    const runs = [
      run("2026-07-23T15:00:00.000Z", "2026-07-23T15:25:00.000Z"),
      run("2026-07-23T01:00:00.000Z", "2026-07-23T01:05:00.000Z")
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
