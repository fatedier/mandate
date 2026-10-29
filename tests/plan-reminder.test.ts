import { expect, test } from "bun:test";
import { PLAN_REMINDER_MS, PLAN_REMINDER_STEPS, planReminderDue, renderPlanReminder } from "../src/server/modules/plans/plan-reminder.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import { emptyPlan, type FeaturePlanDto, type PlanStepDto } from "../src/shared/api/plans.js";

// A worker that has gone ten steps and ten minutes without touching its plan,
// and as long since the last reminder, is reminded of it: the steps not done,
// the done ones only counted.

const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const min = (n: number) => new Date(T0 + n * 60_000).toISOString();
let seq = 0;
const assistant = (at: number, tool = "bash") => ({ id: `m${++seq}`, threadId: "t", seq, role: "assistant", source: "self", createdAt: min(at),
  content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `c${seq}`, toolName: tool, args: {} }] } }) as unknown as AgentMessage;
const reminder = (at: number) => ({ id: `m${++seq}`, threadId: "t", seq, role: "user", source: "plan-reminder", createdAt: min(at), content: { type: "text", text: "…" } }) as unknown as AgentMessage;
const user = (at: number) => ({ id: `m${++seq}`, threadId: "t", seq, role: "user", source: "user", createdAt: min(at), content: { type: "text", text: "Go on" } }) as unknown as AgentMessage;
/** `n` steps, the first at minute `from`, one a minute. */
const steps = (n: number, from = 0) => Array.from({ length: n }, (_, i) => assistant(from + i));
const due = (messages: AgentMessage[], atMinute: number) => planReminderDue(messages, T0 + atMinute * 60_000);

test("due after 10 steps and 10 minutes since the plan was touched, and as long since the last reminder", () => {
  expect([PLAN_REMINDER_STEPS, PLAN_REMINDER_MS]).toEqual([10, 10 * 60_000]);
  expect(due(steps(9), 30)).toBe(false);
  expect(due(steps(10), 30)).toBe(true);
  // Ten quick steps are not ten minutes of work.
  const touched = [assistant(0, "update_plan"), ...steps(10, 1)];
  expect(due(touched, 9.99)).toBe(false);
  expect(due(touched, 10)).toBe(true);
  expect(due([...steps(20), assistant(20, "read_plan")], 60)).toBe(false);
  // The plan call itself is not one of the ten.
  expect(due([...steps(9), assistant(9, "update_plan"), ...steps(9, 10)], 60)).toBe(false);
  expect(due([...steps(9), assistant(9, "update_plan"), ...steps(10, 10)], 60)).toBe(true);
  // Timed from the plan call, not from the window's start.
  const lateTouch = [...steps(30), assistant(40, "update_plan"), ...steps(10, 41)];
  expect(due(lateTouch, 49.9)).toBe(false);
  expect(due(lateTouch, 50)).toBe(true);
  // From the latest plan call, not an earlier one.
  const twoCalls = [assistant(0, "update_plan"), assistant(40, "read_plan"), ...steps(10, 40)];
  expect(due(twoCalls, 49.9)).toBe(false);
  expect(due(twoCalls, 50)).toBe(true);
  // From the latest reminder, not an earlier one.
  const twice = [...steps(12), reminder(12), ...steps(10, 13), reminder(30), ...steps(10, 31)];
  expect(due(twice, 39.9)).toBe(false);
  expect(due(twice, 40)).toBe(true);
  // Steps and time since the last reminder, both.
  const afterReminder = [...steps(12), reminder(12), ...steps(9, 13)];
  expect(due(afterReminder, 60)).toBe(false);
  const tenMore = [...afterReminder, assistant(21.5)];
  expect(due(tenMore, 21.9)).toBe(false);
  expect(due(tenMore, 22)).toBe(true);
});

test("a window with no plan call is timed from its start, whatever message opens it", () => {
  const window = steps(10, 5);
  expect(due(window, 14.9)).toBe(false);
  expect(due(window, 15)).toBe(true);
  const opened = [user(0), ...steps(10, 1)];
  expect(due(opened, 9.9)).toBe(false);
  expect(due(opened, 10)).toBe(true);
});

const step = (id: number, title: string, status: PlanStepDto["status"], note: string | null = null): PlanStepDto => ({
  id, title, status, note,
  createdAt: "2026-10-22T09:00:00.000Z",
  startedAt: status === "pending" ? null : "2026-10-22T10:00:00.000Z",
  blockedAt: status === "blocked" ? "2026-10-23T08:00:00.000Z" : null,
  completedAt: status === "done" ? "2026-10-23T09:00:00.000Z" : null,
  updatedAt: "2026-10-23T09:00:00.000Z"
});
const plan = (steps: PlanStepDto[]): FeaturePlanDto => ({ ...emptyPlan("feat_1"), goal: "Ship the export", conclusion: "Two of four done", steps, updatedAt: "2026-10-23T09:00:00.000Z" });
const HEAD = [
  "<plan-reminder>",
  "The plan has not been updated for a while. If the work moved on (a step started, finished or got blocked, the picture changed), update it with update_plan. This is only a reminder; ignore it if nothing changed.",
  ""
];

test("the reminder lists the steps not done and counts the done ones", () => {
  const text = renderPlanReminder(plan([
    step(1, "Read the exporter", "done", "Long notes on what was found in the exporter"),
    step(2, "Add the CSV writer", "done", "Written and tested"),
    step(3, "Wire the button", "in_progress", "Half done"),
    step(4, "Release", "pending")
  ]));
  expect(text).toBe([
    ...HEAD,
    "Plan: 2 of 4 done",
    "Goal: Ship the export",
    "Conclusion: Two of four done",
    "Steps not done:",
    "  #3 [in_progress since 2026-10-22] Wire the button — Half done",
    "  #4 [pending, added 2026-10-22] Release",
    "(Done steps are not shown; read_plan lists them.)",
    "</plan-reminder>"
  ].join("\n"));
  expect(text).not.toContain("Long notes");
});

test("a plan with every step done says so; one with none done lists them all, with nothing about done steps", () => {
  expect(renderPlanReminder(plan([step(1, "Read", "done"), step(2, "Write", "done")]))).toBe([
    ...HEAD, "Plan: 2 of 2 done", "Goal: Ship the export", "Conclusion: Two of four done", "(All 2 steps done.)", "</plan-reminder>"
  ].join("\n"));
  expect(renderPlanReminder(plan([step(1, "Read", "done")]))).toContain("\n(All 1 step done.)\n");
  const none = renderPlanReminder(plan([step(1, "Read", "blocked", "Waiting on access"), step(2, "Write", "pending")]));
  expect(none).toContain("Steps not done:\n  #1 [blocked since 2026-10-23] Read — Waiting on access\n  #2 [pending, added 2026-10-22] Write\n</plan-reminder>");
});

test("a plan with no steps, and no plan at all, read as before", () => {
  expect(renderPlanReminder({ ...emptyPlan("feat_1"), conclusion: "Waiting", updatedAt: "2026-09-14T10:00:00.000Z" })).toBe([
    ...HEAD, "Plan: no steps yet", "Conclusion: Waiting", "</plan-reminder>"
  ].join("\n"));
  expect(renderPlanReminder(emptyPlan("feat_1"))).toContain("\nNo plan yet.\n");
});
