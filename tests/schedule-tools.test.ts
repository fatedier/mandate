import { expect, test } from "bun:test";
import { freshStoresEnv, withTempDataDir } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { tempDir } from "./helpers/temp.js";
import { toolContext } from "./helpers/typed.js";
import { buildScheduleTools } from "../src/server/modules/schedules/tools/schedule-tools.js";
import type { ScheduleManager } from "../src/server/modules/schedules/schedule-manager.js";
import type { ToolDefinition } from "../src/server/modules/agent/tool-registry.js";

const DTO = { id: "sch_1", threadId: "thr_1", name: "q", cron: "0 9 * * *", cronText: "Daily 09:00", timezone: "UTC", status: "active", pausedReason: null, nextDueAt: null, lastRunAt: null, lastOutcome: null, consecutiveFailures: 0 } as const;

function setup() {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string, result: unknown) => (...args: unknown[]) => { calls.push([name, args]); return result; };
  let listed: unknown[] = [DTO];
  const manager = {
    create: record("create", Promise.resolve({ status: "created", schedule: DTO })),
    update: record("update", Promise.resolve({ status: "updated", schedule: DTO })),
    pause: record("pause", [DTO]),
    resume: record("resume", [DTO]),
    runNow: record("runNow", Promise.resolve({ outcome: "manual_quiet", line: "" })),
    delete: record("delete", true),
    list: (...args: unknown[]) => { calls.push(["list", args]); return listed; }
  } as unknown as ScheduleManager;
  const tools = new Map(buildScheduleTools({ schedules: manager, threadTitle: (id) => (id === "thr_1" ? "greenhouse watch" : null) }).map((t) => [t.name, t as ToolDefinition<Record<string, unknown>, unknown>]));
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!.handler(args, toolContext());
  return { calls, call, tools, list: (rows: unknown[]) => { listed = rows; } };
}

test("The personal agent has two schedule tools: one lists, one does everything else", () => {
  expect([...setup().tools.keys()].sort()).toEqual(["list_schedules", "manage_schedule"]);
});

test("create passes what the model gave, blanks dropped and the timeout in ms", async () => {
  const s = setup();
  expect(await s.call("manage_schedule", { action: "create", name: "q", cron: "0 9 * * *", timezone: "", check: "c", brief: "b", checkTimeout: "5m", thread: { newTitle: "greenhouse watch", threadId: "" } }))
    .toEqual({ status: "created", schedule: DTO });
  expect(s.calls).toEqual([["create", [{ name: "q", cron: "0 9 * * *", check: "c", brief: "b", checkTimeoutMs: 300_000, thread: { newTitle: "greenhouse watch" } }]]]);
});

test("create with paused saves it paused, with the reason given", async () => {
  const s = setup();
  const args = { action: "create", name: "q", cron: "c", check: "c", brief: "b", thread: { newTitle: "t" } };
  await s.call("manage_schedule", { ...args, paused: true, reason: "waiting for the seedlings" });
  expect(await s.call("manage_schedule", { ...args, paused: true, reason: " " })).toEqual({ error: "pause needs a reason" });
  // A reason alone is no pause.
  await s.call("manage_schedule", { ...args, paused: false, reason: "x" });
  expect(s.calls.map(([, [input]]) => (input as { pausedReason?: string }).pausedReason ?? null)).toEqual(["waiting for the seedlings", null]);
});

test("a blank level is no level", async () => {
  const s = setup();
  const parsed = s.tools.get("manage_schedule")!.parameters.safeParse({ action: "create", name: "q", cron: "c", check: "c", brief: "b", level: "", thread: { newTitle: "t" } });
  expect(parsed.success).toBe(true);
  await s.call("manage_schedule", { action: "create", name: "q", cron: "c", check: "c", brief: "b", level: "", thread: { newTitle: "t" } });
  await s.call("manage_schedule", { action: "update", id: "sch_1", level: "" });
  expect(s.calls.map(([, args]) => args)).toEqual([[{ name: "q", cron: "c", check: "c", brief: "b", thread: { newTitle: "t" } }], ["sch_1", {}]]);
});

test("create wants name, cron, check, brief and exactly one thread, and a duration it can read", async () => {
  const s = setup();
  expect(await s.call("manage_schedule", { action: "create", name: "q", cron: "c", check: "c", brief: "b", thread: { newTitle: "a", threadId: "thr_1" } })).toEqual({ error: expect.stringContaining("exactly one") });
  expect(await s.call("manage_schedule", { action: "create", name: "q", cron: "c", check: "c", brief: "b", thread: {} })).toEqual({ error: expect.stringContaining("exactly one") });
  expect(await s.call("manage_schedule", { action: "create", name: "q", cron: "c", check: "c", brief: "b", checkTimeout: "soon", thread: { threadId: "thr_1" } })).toEqual({ error: expect.stringContaining("checkTimeout") });
  for (const missing of ["name", "cron", "check", "brief", "thread"]) {
    const args: Record<string, unknown> = { action: "create", name: "q", cron: "c", check: "c", brief: "b", thread: { newTitle: "t" } };
    args[missing] = missing === "thread" ? undefined : "";
    expect({ missing, outcome: await s.call("manage_schedule", args) }).toEqual({ missing, outcome: { error: "create needs name, cron, check, brief and thread" } });
  }
  expect(s.calls).toStrictEqual([]);
});

test("update sends only what changes, to the schedule named", async () => {
  const s = setup();
  await s.call("manage_schedule", { action: "update", id: "sch_1", name: "", cron: "0 18 * * *", check: "", brief: "", level: "fix_for_review", resetState: false });
  expect(await s.call("manage_schedule", { action: "update", cron: "0 18 * * *" })).toEqual({ error: "give the schedule's id" });
  expect(s.calls).toEqual([["update", ["sch_1", { cron: "0 18 * * *", level: "fix_for_review" }]]]);
});

test("pause, resume, run now and delete reach the manager; list lists", async () => {
  const s = setup();
  expect(await s.call("manage_schedule", { action: "pause", all: true, reason: "repotting" })).toEqual({ schedules: [DTO] });
  expect(await s.call("manage_schedule", { action: "pause", id: "sch_1", reason: "x" })).toEqual({ schedules: [DTO] });
  expect(await s.call("manage_schedule", { action: "pause", reason: "x" })).toEqual({ error: "give the schedule's id, or all: true" });
  expect(await s.call("manage_schedule", { action: "pause", id: "sch_1", reason: "" })).toEqual({ error: "pause needs a reason" });
  expect(await s.call("manage_schedule", { action: "resume", all: true })).toEqual({ schedules: [DTO] });
  expect(await s.call("manage_schedule", { action: "run_now", id: "sch_1" })).toEqual({ outcome: "manual_quiet", line: "" });
  expect(await s.call("manage_schedule", { action: "run_now" })).toEqual({ error: "give the schedule's id" });
  expect(await s.call("manage_schedule", { action: "delete", id: "sch_1" })).toEqual({ deleted: true });
  expect(await s.call("list_schedules", {})).toEqual({ schedules: [{ ...DTO, threadTitle: "greenhouse watch" }] });
  // One whose thread is not open yet (an older version's, at the start): none is named.
  s.list([{ ...DTO, threadId: "" }]);
  expect(await s.call("list_schedules", {})).toEqual({ schedules: [{ ...DTO, threadId: null, threadTitle: null }] });
  expect(s.calls.map(([name, args]) => [name, args])).toEqual([
    ["pause", [{ all: true }, "repotting"]], ["pause", [{ id: "sch_1" }, "x"]], ["resume", [{ all: true }]],
    ["runNow", ["sch_1"]], ["delete", ["sch_1"]], ["list", []], ["list", []]
  ]);
});

test("a field goes only with the actions that take it; a blank one is no field", async () => {
  const s = setup();
  expect(await s.call("manage_schedule", { action: "update", id: "sch_1", all: true, cron: "0 9 * * *" })).toEqual({ error: "all goes only with pause or resume" });
  expect(await s.call("manage_schedule", { action: "update", id: "sch_1", thread: { newTitle: "t" } })).toEqual({ error: "thread goes only with create" });
  expect(await s.call("manage_schedule", { action: "create", name: "q", cron: "c", check: "c", brief: "b", thread: { newTitle: "t" }, resetState: true })).toEqual({ error: "resetState goes only with update" });
  expect(await s.call("manage_schedule", { action: "update", id: "sch_1", paused: true, reason: "x" })).toEqual({ error: "paused goes only with create" });
  expect(await s.call("manage_schedule", { action: "pause", id: "sch_1", reason: "x", cron: "0 9 * * *" })).toEqual({ error: "cron goes only with create or update" });
  expect(await s.call("manage_schedule", { action: "delete", id: "sch_1", check: "c" })).toEqual({ error: "check goes only with create or update" });
  expect(s.calls).toStrictEqual([]);
  // What a model sends for a field it does not mean: "", false, an empty thread.
  expect(await s.call("manage_schedule", { action: "run_now", id: "sch_1", all: false, paused: false, reason: "", name: "", cron: "", timezone: "", check: "", checkTimeout: "", brief: "", level: "", thread: { newTitle: "", threadId: "" }, resetState: false }))
    .toEqual({ outcome: "manual_quiet", line: "" });
});

test("The personal agent is offered the canvas tool a manager has; its subagents are offered none", () => {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-canvas-tools-scope-");
  const runtime = testAgentRuntime(env, { commandRunner: testShellRunner(tempDir("shell-home-")) });
  try {
    const canvasTools = (scope: keyof typeof runtime.scopes) => runtime.scopes[scope].toolDefinitions.map((t) => t.name).filter((n) => n.startsWith("canvas")).sort();
    const all = ["canvas"];
    expect([canvasTools("personal"), canvasTools("manager"), canvasTools("subagent")]).toStrictEqual([all, all, []]);
  } finally { runtime.dispose(); data.restore(); }
});

test("only the personal agent is offered schedule tools", () => {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-sched-tools-scope-");
  const runtime = testAgentRuntime(env, { commandRunner: testShellRunner(tempDir("shell-home-")) });
  try {
    const names = (scope: keyof typeof runtime.scopes) => runtime.scopes[scope].toolDefinitions.map((t) => t.name);
    expect(names("personal").filter((n) => n.includes("schedule") && n !== "schedule_wake").sort()).toStrictEqual(["list_schedules", "manage_schedule"]);
    for (const scope of ["manager", "worker", "subagent"] as const) {
      expect(names(scope).filter((n) => n.includes("schedule") && n !== "schedule_wake")).toStrictEqual([]);
    }
  } finally { runtime.dispose(); data.restore(); }
});
