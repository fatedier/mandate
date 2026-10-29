import { describe, expect, test } from "bun:test";
import { categorizeFeatures, paneStatusForFeature } from "../src/client/routes/projects/feature-card-data";
import type { Feature } from "../src/client/store/projects";
import type { WorkItemDto } from "../src/shared/api/work-items";
import { clientFeature } from "./helpers/client-builders.js";

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return clientFeature("f-1", {
    projectId: "p", name: "n", tmuxWindowName: "w",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ownerThreadId: null, tmuxStatus: "alive",
    ...overrides
  });
}

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1", featureId: "f-1", projectId: "p",
    title: "t",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    failedAt: null,
    failedMessage: null, failedKind: null,
    ...overrides
  };
}

// A worker that waits for an answer has no flag: what it asks is in its
// plan. The caller says which workers those are. A worker whose last wake
// failed or stopped is the other thing worth a look; a finished one is not.
test("categorizeFeatures: a failed or stopped worker is in attention, before one that waits for an answer", () => {
  const a = makeFeature({ id: "a" });
  const b = makeFeature({ id: "b" });
  const c = makeFeature({ id: "c" });
  const d = makeFeature({ id: "d" });
  const map = new Map([
    ["a", makeItem({ featureId: "a" })],
    ["b", makeItem({ featureId: "b", failedAt: "2026-01-02T00:00:00Z", failedKind: "error" })],
    ["c", makeItem({ featureId: "c" })],
    ["d", makeItem({ featureId: "d", failedAt: "2026-01-02T00:00:00Z", failedKind: "stopped" })]
  ]);
  const out = categorizeFeatures([a, b, c, d], map, new Set(["a"]));
  expect(out.attention.map((x) => x.feature.id).slice(0, 2).sort()).toEqual(["b", "d"]);
  expect(out.attention.map((x) => x.feature.id)[2]).toBe("a");
  expect(out.working.map((x) => x.feature.id)).toEqual(["c"]);
});

test("categorizeFeatures: attention items of one kind sorted by lastActivityAt desc", () => {
  const a = makeFeature({ id: "a" });
  const b = makeFeature({ id: "b" });
  const failed = { failedAt: "2026-01-02T00:00:00Z", failedKind: "error" as const };
  const map = new Map([
    ["a", makeItem({ featureId: "a", ...failed, lastActivityAt: "2026-01-01T00:00:00Z" })],
    ["b", makeItem({ featureId: "b", ...failed, lastActivityAt: "2026-05-01T00:00:00Z" })]
  ]);
  const out = categorizeFeatures([a, b], map);
  expect(out.attention.map((x) => x.feature.id)).toEqual(["b", "a"]);
});

test("categorizeFeatures: pinned sort by pinned_at desc (newest first)", () => {
  const a = makeFeature({ id: "a", pinnedAt: "2026-05-01T00:00:00Z" });
  const b = makeFeature({ id: "b", pinnedAt: "2026-05-10T00:00:00Z" });
  const out = categorizeFeatures([a, b], new Map());
  expect(out.pinned.map((x) => x.feature.id)).toEqual(["b", "a"]);
});

test("categorizeFeatures: working sorted by createdAt asc (oldest first, stable)", () => {
  const a = makeFeature({ id: "a", createdAt: "2026-01-10T00:00:00Z" });
  const b = makeFeature({ id: "b", createdAt: "2026-01-01T00:00:00Z" });
  const map = new Map([
    ["a", makeItem({ featureId: "a" })],
    ["b", makeItem({ featureId: "b" })]
  ]);
  const out = categorizeFeatures([a, b], map);
  expect(out.working.map((x) => x.feature.id)).toEqual(["b", "a"]);
});

test("categorizeFeatures: untracked sorted by createdAt asc", () => {
  const a = makeFeature({ id: "a", createdAt: "2026-01-10T00:00:00Z" });
  const b = makeFeature({ id: "b", createdAt: "2026-01-01T00:00:00Z" });
  const out = categorizeFeatures([a, b], new Map());
  expect(out.untracked.map((x) => x.feature.id)).toEqual(["b", "a"]);
});

test("categorizeFeatures: a pinned feature that waits for an answer or failed stays pinned, not in attention", () => {
  const a = makeFeature({ id: "a", pinnedAt: "2026-05-01T00:00:00Z" });
  const out = categorizeFeatures([a], new Map([["a", makeItem({ featureId: "a", failedAt: "2026-01-02T00:00:00Z", failedKind: "error" })]]), new Set(["a"]));
  expect(out.pinned.map((x) => x.feature.id)).toEqual(["a"]);
  expect(out.attention).toEqual([]);
});

function snap(status: string) {
  return {
    sessions: [
      {
        sessionName: "proj",
        windows: [{ windowName: "feat", aggregate: { status } }]
      }
    ]
  };
}

describe("paneStatusForFeature", () => {
  test.each([
    ["working", "running"],
    ["running_service", "running"],
    ["idle_shell", "idle"],
    ["done", "idle"],
    ["waiting_user", null],
    ["unknown", null]
  ] as const)("maps analyzer status %s to %s", (agg, expected) => {
    expect(paneStatusForFeature("proj", "feat", snap(agg))).toBe(expected);
  });

  test("null snapshot and missing window return null", () => {
    expect(paneStatusForFeature("proj", "feat", null)).toBeNull();
    expect(paneStatusForFeature("other", "feat", snap("working"))).toBeNull();
  });

});
