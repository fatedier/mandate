import { expect, test } from "bun:test";
import { defaultWorkerTab, groupWorkers, workerGroup } from "../../src/client/lib/worker-groups.js";

test("workerGroup: what went wrong first (failed, stopped each its own), then one that waits for an answer, then the plan state", () => {
  expect(workerGroup({ state: "failed", waiting: "failed" })).toBe("failed");
  expect(workerGroup({ state: "stopped", waiting: "stopped" })).toBe("stopped");
  // A question in its plan, at rest: it waits for an answer, its manager's first.
  expect(workerGroup({ state: "asking", waiting: null })).toBe("asking");
  expect(workerGroup({ state: "planning", waiting: null })).toBe("in_progress");
  expect(workerGroup({ state: "in_progress", waiting: null })).toBe("in_progress");
  expect(workerGroup({ state: "blocked", waiting: null })).toBe("blocked");
  expect(workerGroup({ state: "paused", waiting: null })).toBe("idle");
  // A finished plan is its manager's to hear: no group of its own.
  expect(workerGroup({ state: "done", waiting: null })).toBe("idle");
});

test("groupWorkers: non-empty groups in reading order, none for a finished plan", () => {
  const ws = [
    { id: "a", state: "done" as const, waiting: null },
    { id: "b", state: "stopped" as const, waiting: "stopped" as const },
    { id: "c", state: "failed" as const, waiting: "failed" as const },
    { id: "d", state: "asking" as const, waiting: null },
    { id: "e", state: "in_progress" as const, waiting: null }
  ];
  expect(groupWorkers(ws).map((g) => [g.key, g.workers.map((w) => w.id)])).toEqual([
    ["failed", ["c"]],
    ["stopped", ["b"]],
    ["asking", ["d"]],
    ["in_progress", ["e"]],
    ["idle", ["a"]]
  ]);
});

test("defaultWorkerTab: Chat where an answer is wanted or something went wrong, Plan otherwise", () => {
  expect(defaultWorkerTab({ waiting: null, asking: true })).toBe("chat");
  expect(defaultWorkerTab({ waiting: null, asking: false })).toBe("plan");
  expect(defaultWorkerTab({ waiting: "failed" })).toBe("chat");
  expect(defaultWorkerTab({ waiting: "stopped" })).toBe("chat");
  expect(defaultWorkerTab({ waiting: null })).toBe("plan");
});
