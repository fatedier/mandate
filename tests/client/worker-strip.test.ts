import { expect, test } from "bun:test";
import type { AgentPendingMonitorDto } from "@shared/api-contracts";
import type { ThreadWorker } from "@/hooks/useThreadWorkers";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { taskStrip, workerStrip } from "@/routes/window/chat/worker-strip";
import { backgroundTask } from "../helpers/subagent-client.js";
import { threadWorker } from "../helpers/client-builders.js";

// A worker goes on after its first reply, in turns woken by its own watches,
// and none of that reached its manager's thread: the thread looked stuck. The
// strip above the composer lists each worker at work, running a turn or asleep
// on a watch it set, and how long it has been at it.

const at = (minute: number) => `2026-10-14T10:${String(minute).padStart(2, "0")}:00.000Z`;

function worker(featureId: string, over: Partial<ThreadWorker> = {}): ThreadWorker {
  return threadWorker(featureId, { ownerThreadId: "thr-1", ...over });
}
const pane = (id: string, createdAt: string, paneName: string | null = "codex"): AgentPendingMonitorDto => ({
  kind: "pane", id, windowKey: "w", paneId: "%3", paneName, stableMs: 30_000, timeoutAt: at(59), note: "", createdAt
});
const command = (id: string, createdAt: string, description: string | null = "CI on the branch"): AgentPendingMonitorDto => ({
  kind: "command", id, command: "gh run list", description, everyMs: 60_000, wakeWhen: "changed", timeoutAt: at(59), note: "", createdAt,
  runCount: 0, lastRunAt: null, nextRunAt: createdAt, recentRuns: []
});
const subagent = (id: string, createdAt: string): AgentPendingMonitorDto => ({
  kind: "subagent", id, title: "0.72 release notes", status: "running", createdAt
});

function stripOf(workers: ThreadWorker[], facts: { since?: Record<string, string>; steps?: Record<string, string>; waits?: Record<string, AgentPendingMonitorDto[]> } = {}) {
  return workerStrip(workers, {
    runningSince: (id) => facts.since?.[id] ?? null,
    stepOf: (id) => facts.steps?.[id] ?? null,
    waitsOf: (id) => facts.waits?.[id] ?? []
  });
}

test("a running worker is listed with the step it is on and when its turn began", () => {
  const strip = stripOf([worker("legacy-compat", { running: true })], { since: { "legacy-compat": at(1) }, steps: { "legacy-compat": "Run the full validation" } });
  expect(strip).toEqual([{ featureId: "legacy-compat", name: "legacy-compat", kind: "running", step: "Run the full validation", since: at(1) }]);
  // With no step in progress, no step.
  expect(stripOf([worker("legacy-compat", { running: true })])[0]).toMatchObject({ kind: "running", step: null, since: null });
});

test("a worker asleep on its watch is listed as its chat's waiting line names it, from when it began to wait", () => {
  const strip = stripOf([worker("legacy-compat", { watching: "pane" })], { waits: { "legacy-compat": [pane("m1", at(3))] } });
  expect(strip).toEqual([{ featureId: "legacy-compat", name: "legacy-compat", kind: "waiting", wait: { kind: "pane", lead: "Watching", label: "codex", mono: false }, since: at(3) }]);
  // A command it monitors; a pane before a command, as its watching state
  // reads it; of two, the one it set last, as its chat's line leads with it.
  expect(stripOf([worker("a", { watching: "command" })], { waits: { a: [command("m1", at(2))] } })[0])
    .toMatchObject({ wait: { kind: "command", lead: "Monitoring", label: "CI on the branch", mono: false }, since: at(2) });
  expect(stripOf([worker("a", { watching: "pane" })], { waits: { a: [command("m1", at(2)), pane("m2", at(4), null)] } })[0])
    .toMatchObject({ wait: { kind: "pane", lead: "Watching", label: "%3", mono: true }, since: at(4) });
  expect(stripOf([worker("a", { watching: "pane" })], { waits: { a: [pane("m1", at(3), "older"), pane("m2", at(5), "newer")] } })[0])
    .toMatchObject({ wait: { label: "newer" }, since: at(5) });
});

test("a worker at rest, asking, or done is not at work; one that runs is listed as running whatever it also waits on", () => {
  const strip = stripOf([
    worker("idle"),
    worker("asking", { asking: true, state: "asking" }),
    worker("done", { state: "done" }),
    // Watching, by a list that no longer names its wait: nothing to name.
    worker("unknown", { watching: "pane" }),
    worker("both", { running: true, watching: "pane" })
  ], { waits: { both: [pane("m1", at(1))] } });
  expect(strip.map((row) => [row.featureId, row.kind])).toEqual([["both", "running"]]);
});

test("the running come first, then the waiting, each the longest at it first", () => {
  const strip = stripOf([
    worker("w-late", { watching: "pane" }),
    worker("r-late", { running: true }),
    worker("w-early", { watching: "pane" }),
    worker("r-unknown", { running: true }),
    worker("r-early", { running: true })
  ], {
    since: { "r-late": at(9), "r-early": at(1) },
    waits: { "w-late": [pane("m1", at(8))], "w-early": [pane("m2", at(0))] }
  });
  expect(strip.map((row) => row.featureId)).toEqual(["r-early", "r-late", "r-unknown", "w-early", "w-late"]);
});

// What a worker's subagent is doing is the strip's own row, not a worker's
// waiting line; a pane or a command beside it still names the wait.
test("a worker whose only wait is a subagent has no waiting row; a pane or a command beside it names the wait", () => {
  expect(stripOf([worker("a", { watching: "subagent" })], { waits: { a: [subagent("t1", at(1))] } })).toEqual([]);
  expect(stripOf([worker("a", { watching: "pane" })], { waits: { a: [subagent("t1", at(1)), command("m1", at(2)), pane("m2", at(3))] } })[0])
    .toMatchObject({ wait: { kind: "pane" }, since: at(3) });
  expect(stripOf([worker("a", { watching: "command" })], { waits: { a: [subagent("t1", at(1)), command("m1", at(2))] } })[0])
    .toMatchObject({ wait: { kind: "command", lead: "Monitoring" }, since: at(2) });
});

// Background tasks are at work for the conversation too: the running, the
// longest at it first, then the queued in the order they wait.
const bg = (id: string, over: Partial<BackgroundTaskDto> = {}) => backgroundTask({ id, title: id, ...over });

test("background tasks on the strip: the running, the longest at it first whatever order they were read in, then the queued in the order they wait; ended ones are not at work", () => {
  // Newest first, as a conversation's tasks are read.
  const tasks = [
    bg("t5", { status: "queued", startedAt: null, createdAt: at(9) }),
    bg("t4", { status: "queued", startedAt: null, createdAt: at(8) }),
    bg("t3", { status: "running", createdAt: at(7), startedAt: at(8) }),
    bg("t2", { status: "finished", startedAt: at(2), finishedAt: at(6) }),
    bg("t1", { status: "running", createdAt: at(1), startedAt: at(3) })
  ];
  // Read newest first, t3 before t1; t1 has been at it longer.
  expect(taskStrip(tasks).map((t) => t.id)).toEqual(["t1", "t3", "t4", "t5"]);
});

test("a task whose steps the reader has open stays on the strip when it ends, first, until they close", () => {
  const tasks = [bg("t2", { status: "running", startedAt: at(3) }), bg("t1", { status: "finished", startedAt: at(1), finishedAt: at(4) })];
  expect(taskStrip(tasks, "t1").map((t) => t.id)).toEqual(["t1", "t2"]);
  expect(taskStrip(tasks, null).map((t) => t.id)).toEqual(["t2"]);
  // Held while it still runs: where it is, once.
  expect(taskStrip(tasks, "t2").map((t) => t.id)).toEqual(["t2"]);
});

test("a worker asleep on its alarm is listed as its chat's line names it; a pane or a command beside it names the wait", () => {
  const alarm: AgentPendingMonitorDto = { kind: "alarm", id: "alm_1", fireAt: new Date(Date.now() + 60 * 60_000).toISOString(), note: "", createdAt: at(1) };
  const row = stripOf([worker("a", { watching: "alarm" })], { waits: { a: [alarm] } })[0]!;
  expect(row).toMatchObject({ kind: "waiting", wait: { kind: "alarm", lead: "Wakes at", mono: false }, since: at(1) });
  expect((row as { wait: { label: string } }).wait.label).toMatch(/\d\d:\d\d$/);
  expect(stripOf([worker("a", { watching: "command" })], { waits: { a: [alarm, command("m1", at(2))] } })[0])
    .toMatchObject({ wait: { kind: "command" } });
  // Of two alarms, the one that wakes it first, whenever it was set.
  const sooner: AgentPendingMonitorDto = { ...alarm, id: "alm_2", fireAt: new Date(Date.now() + 30 * 60_000).toISOString(), createdAt: at(2) };
  expect(stripOf([worker("a", { watching: "alarm" })], { waits: { a: [alarm, sooner] } })[0]).toMatchObject({ since: at(2) });
});
