import { expect, test } from "bun:test";
import { categorizeFeatures } from "../src/client/routes/projects/feature-card-data";
import type { Feature } from "../src/client/store/projects";
import type { WorkItemDto } from "../src/shared/api/work-items";

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "f-1", projectId: "p", name: "n", mode: "shared-cwd",
    branch: null, baseRef: null, worktreePath: null,
    tmuxWindowName: "w", ownership: "app",
    pinnedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    tmuxAlive: true, tmuxStatus: "alive",
    ...overrides
  };
}

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1", featureId: "f-1", projectId: "p",
    title: "t", summary: null, canvasId: null, needsUser: null,
    phase: "design", phaseDetail: null,
    summaryUpdatedAt: null, summaryUpdatedBy: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

test("categorizeFeatures: pinned features go to pinned bucket regardless of state", () => {
  const f = makeFeature({ id: "f-1", pinnedAt: "2026-05-01T00:00:00Z" });
  const item = makeItem({ id: "wi-1", featureId: "f-1", needsUser: "input" });
  const map = new Map([[f.id, item]]);
  const out = categorizeFeatures([f], map);
  expect(out.pinned).toHaveLength(1);
  expect(out.attention).toHaveLength(0);
});

test("categorizeFeatures: not pinned, needsUser=input -> attention bucket", () => {
  const f = makeFeature({ id: "f-1" });
  const item = makeItem({ needsUser: "input" });
  const map = new Map([[f.id, item]]);
  expect(categorizeFeatures([f], map).attention).toHaveLength(1);
});

test("categorizeFeatures: not pinned, needsUser=null → working bucket", () => {
  const f = makeFeature({ id: "f-1" });
  const item = makeItem({ needsUser: null });
  const map = new Map([[f.id, item]]);
  expect(categorizeFeatures([f], map).working).toHaveLength(1);
});

test("categorizeFeatures: no work_item → untracked bucket", () => {
  const f = makeFeature({ id: "f-1" });
  expect(categorizeFeatures([f], new Map()).untracked).toHaveLength(1);
});

test("categorizeFeatures: attention sort puts input before review", () => {
  const a = makeFeature({ id: "a" });
  const b = makeFeature({ id: "b" });
  const map = new Map([
    ["a", makeItem({ featureId: "a", needsUser: "review" })],
    ["b", makeItem({ featureId: "b", needsUser: "input" })]
  ]);
  const out = categorizeFeatures([a, b], map);
  expect(out.attention.map((x) => x.feature.id)).toEqual(["b", "a"]);
});

test("categorizeFeatures: same-needsUser attention items sorted by lastActivityAt desc", () => {
  const a = makeFeature({ id: "a" });
  const b = makeFeature({ id: "b" });
  const map = new Map([
    ["a", makeItem({ featureId: "a", needsUser: "input", lastActivityAt: "2026-01-01T00:00:00Z" })],
    ["b", makeItem({ featureId: "b", needsUser: "input", lastActivityAt: "2026-05-01T00:00:00Z" })]
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
    ["a", makeItem({ featureId: "a", needsUser: null })],
    ["b", makeItem({ featureId: "b", needsUser: null })]
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
