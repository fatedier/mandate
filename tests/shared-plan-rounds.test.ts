import { expect, test } from "bun:test";
import { emptyPlan, type FeaturePlanDto, type PlanStepDto } from "../src/shared/api/plans.js";
import { planForPage, planRounds } from "../src/shared/plan-rounds.js";
import { featureStateFor, featureStateLine, planProgress } from "../src/shared/feature-state.js";
import { renderPlanText } from "../src/shared/plan-text.js";

function step(id: number, status: PlanStepDto["status"], createdAt: string): PlanStepDto {
  return {
    id, title: `step ${id}`, status, note: null, createdAt,
    startedAt: status === "pending" ? null : createdAt,
    blockedAt: null, completedAt: status === "done" ? createdAt : null, updatedAt: createdAt
  };
}

// Three goals: the first replaced at 10:00, the second at 12:00. A goal
// change and the steps written in the same call share their timestamp.
const PLAN: FeaturePlanDto = {
  ...emptyPlan("feat_1"),
  goal: "Find why the image build fails",
  goalHistory: [
    { goal: "Draft the release notes", changedAt: "2026-10-12T10:00:00.000Z" },
    { goal: "Open the release PR", changedAt: "2026-10-12T12:00:00.000Z" }
  ],
  steps: [
    step(1, "done", "2026-10-12T08:00:00.000Z"),
    step(2, "done", "2026-10-12T09:00:00.000Z"),
    step(3, "pending", "2026-10-12T09:30:00.000Z"),
    step(4, "done", "2026-10-12T10:00:00.000Z"),
    step(5, "done", "2026-10-12T12:00:00.000Z"),
    step(6, "in_progress", "2026-10-12T12:00:00.000Z")
  ],
  updatedAt: "2026-10-12T12:00:00.000Z"
};

test("a goal change starts new work: the steps written from then on, and any still open, are the current work", () => {
  expect(planRounds(PLAN).current.map((s) => s.id)).toEqual([3, 5, 6]);
});

test("earlier goals' done steps are earlier work, a round per goal, oldest first", () => {
  expect(planRounds(PLAN).earlier.map((r) => [r.goal, r.changedAt, r.steps.map((s) => s.id)])).toEqual([
    ["Draft the release notes", "2026-10-12T10:00:00.000Z", [1, 2]],
    // Written in the call that set the second goal: it served that goal.
    ["Open the release PR", "2026-10-12T12:00:00.000Z", [4]]
  ]);
});

test("a goal that got no steps has no round, and a plan never re-aimed is all current work", () => {
  const skipped = { ...PLAN, goalHistory: [{ goal: "Look around", changedAt: "2026-10-12T07:00:00.000Z" }, ...PLAN.goalHistory] };
  expect(planRounds(skipped).earlier.map((r) => r.goal)).toEqual(["Draft the release notes", "Open the release PR"]);
  const once = { ...PLAN, goalHistory: [] };
  expect(planRounds(once)).toEqual({ current: PLAN.steps, earlier: [] });
});

test("progress counts the current work", () => {
  expect(planProgress(PLAN)).toEqual({ done: 1, total: 3 });
  expect(planProgress({ ...PLAN, goalHistory: [] })).toEqual({ done: 4, total: 6 });
});

test("the model reads the current work, and earlier work as one line", () => {
  expect(renderPlanText(PLAN)).toBe([
    "Plan: 1 of 3 done",
    "Goal: Find why the image build fails",
    "Steps:",
    "  (earlier work: 2 goals, 3 steps done; read_plan with includeHistory lists them)",
    "  #3 [pending, added 2026-10-12] step 3",
    "  #5 [done 2026-10-12] step 5",
    "  #6 [in_progress since 2026-10-12] step 6"
  ].join("\n"));
  const one = { ...PLAN, goalHistory: PLAN.goalHistory.slice(1), steps: PLAN.steps.filter((s) => s.id !== 1 && s.id !== 2) };
  expect(renderPlanText(one).split("\n")[3]).toBe("  (earlier work: 1 goal, 1 step done; read_plan with includeHistory lists it)");
  // The whole history is one call away, as before.
  expect(renderPlanText(PLAN, { includeHistory: true })).toContain("  #1 [done 2026-10-12] step 1");
  expect(renderPlanText(PLAN, { includeHistory: true })).toContain("- 2026-10-12: Draft the release notes");
});

test("just after a goal change with no step of its own yet, the plan still says what came before", () => {
  const fresh = { ...PLAN, goalHistory: [...PLAN.goalHistory, { goal: "Find why the image build fails", changedAt: "2026-10-12T15:00:00.000Z" }], goal: "Write it up", steps: PLAN.steps.map((s) => s.status === "done" ? s : { ...s, status: "done" as const, completedAt: s.createdAt }) };
  expect(renderPlanText(fresh).split("\n").slice(0, 4)).toEqual([
    "Plan: no steps yet",
    "Goal: Write it up",
    "Steps:",
    "  (earlier work: 3 goals, 6 steps done; read_plan with includeHistory lists them)"
  ]);
});

test("a plan read without its goal history is one never re-aimed", () => {
  const { goalHistory: _, ...bare } = PLAN;
  expect(planRounds(bare)).toEqual({ current: PLAN.steps, earlier: [] });
});

test("the page receives the current work and earlier work as counts, so a plan sent to it does not grow with every step", () => {
  const sent = planForPage(PLAN);
  expect(sent.steps.map((s) => s.id)).toEqual([3, 5, 6]);
  expect(sent.goalHistory).toEqual([]);
  expect(sent.earlierWork).toEqual({ goals: 2, steps: 3, lastStepId: 4 });
  // Read on the page, it means what the whole plan means.
  expect(planProgress(sent)).toEqual(planProgress(PLAN));
  expect(planRounds(sent).current).toEqual(planRounds(PLAN).current);
  expect(planForPage({ ...PLAN, goalHistory: [] })).toEqual({ ...PLAN, goalHistory: [], earlierWork: null });
});

test("a plan with only earlier work is done, not a plan not yet written", () => {
  const allDone = { ...PLAN, steps: PLAN.steps.map((s) => ({ ...s, status: "done" as const, completedAt: s.createdAt })) };
  const fresh = { ...allDone, goalHistory: [...PLAN.goalHistory, { goal: "Find why the image build fails", changedAt: "2026-10-12T15:00:00.000Z" }], goal: "Write it up" };
  const sent = planForPage(fresh);
  expect(sent.steps).toEqual([]);
  expect(featureStateFor(sent, null)).toBe("done");
  expect(featureStateFor(fresh, null)).toBe("done");
  expect(featureStateLine(sent, undefined).state).toBe("done");
  expect(featureStateFor({ ...emptyPlan("feat_1"), earlierWork: null }, null)).toBe("planning");
});
