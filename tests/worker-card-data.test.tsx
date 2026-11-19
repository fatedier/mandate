import { describe, expect, test } from "bun:test";
import { categorizeWorkers, paneStatusForWorker } from "../src/client/routes/projects/worker-card-data";
import type { ProjectWorker } from "../src/client/store/projects";
import type { WorkItemDto } from "../src/shared/api/work-items";
import { clientWorker } from "./helpers/client-builders.js";

function makeWorker(overrides: Partial<ProjectWorker> = {}): ProjectWorker {
  return clientWorker("f-1", {
    projectId: "p", name: "n", tmuxWindowName: "w",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ownerThreadId: null,
    ...overrides
  });
}

function makeItem(overrides: Partial<WorkItemDto> = {}): WorkItemDto {
  return {
    id: "wi-1", workerId: "f-1", projectId: "p",
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
test("categorizeWorkers: a failed or stopped worker is in attention, before one that waits for an answer", () => {
  const a = makeWorker({ id: "a" });
  const b = makeWorker({ id: "b" });
  const c = makeWorker({ id: "c" });
  const d = makeWorker({ id: "d" });
  const map = new Map([
    ["a", makeItem({ workerId: "a" })],
    ["b", makeItem({ workerId: "b", failedAt: "2026-01-02T00:00:00Z", failedKind: "error" })],
    ["c", makeItem({ workerId: "c" })],
    ["d", makeItem({ workerId: "d", failedAt: "2026-01-02T00:00:00Z", failedKind: "stopped" })]
  ]);
  const out = categorizeWorkers([a, b, c, d], map, new Set(["a"]));
  expect(out.attention.map((x) => x.worker.id).slice(0, 2).sort()).toEqual(["b", "d"]);
  expect(out.attention.map((x) => x.worker.id)[2]).toBe("a");
  expect(out.working.map((x) => x.worker.id)).toEqual(["c"]);
});

test("categorizeWorkers: attention items of one kind sorted by lastActivityAt desc", () => {
  const a = makeWorker({ id: "a" });
  const b = makeWorker({ id: "b" });
  const failed = { failedAt: "2026-01-02T00:00:00Z", failedKind: "error" as const };
  const map = new Map([
    ["a", makeItem({ workerId: "a", ...failed, lastActivityAt: "2026-01-01T00:00:00Z" })],
    ["b", makeItem({ workerId: "b", ...failed, lastActivityAt: "2026-05-01T00:00:00Z" })]
  ]);
  const out = categorizeWorkers([a, b], map);
  expect(out.attention.map((x) => x.worker.id)).toEqual(["b", "a"]);
});

test("categorizeWorkers: pinned sort by pinned_at desc (newest first)", () => {
  const a = makeWorker({ id: "a", pinnedAt: "2026-05-01T00:00:00Z" });
  const b = makeWorker({ id: "b", pinnedAt: "2026-05-10T00:00:00Z" });
  const out = categorizeWorkers([a, b], new Map());
  expect(out.pinned.map((x) => x.worker.id)).toEqual(["b", "a"]);
});

test("categorizeWorkers: working sorted by createdAt asc (oldest first, stable)", () => {
  const a = makeWorker({ id: "a", createdAt: "2026-01-10T00:00:00Z" });
  const b = makeWorker({ id: "b", createdAt: "2026-01-01T00:00:00Z" });
  const map = new Map([
    ["a", makeItem({ workerId: "a" })],
    ["b", makeItem({ workerId: "b" })]
  ]);
  const out = categorizeWorkers([a, b], map);
  expect(out.working.map((x) => x.worker.id)).toEqual(["b", "a"]);
});

test("categorizeWorkers: untracked sorted by createdAt asc", () => {
  const a = makeWorker({ id: "a", createdAt: "2026-01-10T00:00:00Z" });
  const b = makeWorker({ id: "b", createdAt: "2026-01-01T00:00:00Z" });
  const out = categorizeWorkers([a, b], new Map());
  expect(out.untracked.map((x) => x.worker.id)).toEqual(["b", "a"]);
});

test("categorizeWorkers: a pinned worker that waits for an answer or failed stays pinned, not in attention", () => {
  const a = makeWorker({ id: "a", pinnedAt: "2026-05-01T00:00:00Z" });
  const out = categorizeWorkers([a], new Map([["a", makeItem({ workerId: "a", failedAt: "2026-01-02T00:00:00Z", failedKind: "error" })]]), new Set(["a"]));
  expect(out.pinned.map((x) => x.worker.id)).toEqual(["a"]);
  expect(out.attention).toEqual([]);
});

function snap(status: string) {
  return {
    sessions: [
      {
        sessionName: "proj",
        windows: [{ windowName: "wkr", aggregate: { status } }]
      }
    ]
  };
}

describe("paneStatusForWorker", () => {
  test.each([
    ["working", "running"],
    ["running_service", "running"],
    ["idle_shell", "idle"],
    ["done", "idle"],
    ["waiting_user", null],
    ["unknown", null]
  ] as const)("maps analyzer status %s to %s", (agg, expected) => {
    expect(paneStatusForWorker("proj", "wkr", snap(agg))).toBe(expected);
  });

  test("null snapshot and missing window return null", () => {
    expect(paneStatusForWorker("proj", "wkr", null)).toBeNull();
    expect(paneStatusForWorker("other", "wkr", snap("working"))).toBeNull();
  });

});
