import { expect, test } from "bun:test";
import { emptyPlan, type FeaturePlanDto, type PlanStepDto } from "../src/shared/api/plans.js";
import { charLength, foldSteps, oneLine, planBriefLine, renderPlanText } from "../src/shared/plan-text.js";

function step(id: number, status: PlanStepDto["status"], completedAt: string | null = null, note: string | null = null): PlanStepDto {
  return {
    id, title: `step ${id}`, status, note, createdAt: "2026-09-10T08:00:00.000Z",
    startedAt: status === "pending" ? null : "2026-09-10T09:00:00.000Z",
    blockedAt: status === "blocked" ? "2026-09-14T18:40:00.000Z" : null,
    completedAt, updatedAt: "2026-09-14T18:40:00.000Z"
  };
}

const PLAN: FeaturePlanDto = {
  ...emptyPlan("feat_1"),
  goal: "Release entries on a short TTL",
  conclusion: "Waiting on upstream",
  openQuestions: ["Split the cache into its own PR?"],
  steps: [
    step(1, "done", "2026-09-10T10:00:00.000Z"),
    step(2, "done", "2026-09-11T10:00:00.000Z"),
    step(3, "done", "2026-09-12T10:00:00.000Z"),
    step(4, "done", "2026-09-13T10:00:00.000Z"),
    step(5, "done", "2026-09-13T11:00:00.000Z"),
    step(6, "done", "2026-09-14T10:00:00.000Z", "two call sites changed; tests pass"),
    step(7, "blocked", null, "waits on project-2#17"),
    step(8, "pending")
  ],
  updatedAt: "2026-09-14T18:40:00.000Z"
};

test("folding keeps every open step and the five latest done, in plan order", () => {
  const folded = foldSteps(PLAN.steps);
  expect(folded.shown.map((s) => s.id)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  expect(folded.earlierDone).toBe(1);
});

test("the recent done steps are chosen by completion time, not position", () => {
  const steps = [step(1, "done", "2026-09-20T00:00:00.000Z"), ...PLAN.steps.slice(1)];
  expect(foldSteps(steps).shown.map((s) => s.id)).toEqual([1, 3, 4, 5, 6, 7, 8]);
});

test("the plan as the model reads it", () => {
  expect(renderPlanText(PLAN)).toBe([
    "Plan: 6 of 8 done",
    "Goal: Release entries on a short TTL",
    "Conclusion: Waiting on upstream",
    "Open questions:",
    "- Split the cache into its own PR?",
    "Steps:",
    "  (1 step done earlier; read_plan with includeHistory lists it)",
    "  #2 [done 2026-09-11] step 2",
    "  #3 [done 2026-09-12] step 3",
    "  #4 [done 2026-09-13] step 4",
    "  #5 [done 2026-09-13] step 5",
    "  #6 [done 2026-09-14] step 6 — two call sites changed; tests pass",
    "  #7 [blocked since 2026-09-14] step 7 — waits on project-2#17",
    "  #8 [pending, added 2026-09-10] step 8"
  ].join("\n"));
  expect(renderPlanText(emptyPlan("feat_1"))).toBe("No plan yet.");
  const full = renderPlanText({ ...PLAN, goalHistory: [{ goal: "Old goal", changedAt: "2026-09-12T00:00:00.000Z" }] }, { includeHistory: true }).split("\n");
  expect(full).toContain("  #1 [done 2026-09-10] step 1");
  expect(full.slice(-2)).toEqual(["Earlier goals:", "- 2026-09-12: Old goal"]);
  // A goal cleared with nothing else left still has its history to show.
  const cleared = { ...emptyPlan("feat_1"), goal: "", goalHistory: [{ goal: "Old goal", changedAt: "2026-09-12T00:00:00.000Z" }], updatedAt: "2026-09-12T00:00:00.000Z" };
  expect(renderPlanText(cleared)).toBe("No plan yet.");
  expect(renderPlanText(cleared, { includeHistory: true }).split("\n").slice(-2)).toEqual(["Earlier goals:", "- 2026-09-12: Old goal"]);
});

test("an in-progress step says since when, and no field can break the one-line-per-step shape", () => {
  const plan: FeaturePlanDto = {
    ...emptyPlan("feat_1"),
    goal: "Ship A\nand B",
    openQuestions: ["Split?\n- fake question"],
    steps: [{ ...step(1, "in_progress"), startedAt: "2026-09-12T09:00:00.000Z", title: "real\n  #99 [done 2026-09-12] phantom" }],
    updatedAt: "2026-09-14T18:40:00.000Z"
  };
  expect(renderPlanText(plan)).toBe([
    "Plan: 0 of 1 done",
    "Goal: Ship A and B",
    "Open questions:",
    "- Split? - fake question",
    "Steps:",
    "  #1 [in_progress since 2026-09-12] real #99 [done 2026-09-12] phantom"
  ].join("\n"));
});

test("the manager's one line", () => {
  const SETTLED = { ...PLAN, openQuestions: [] };
  expect(planBriefLine("project-2 evict", SETTLED, null, false)).toBe("[project-2 evict · Blocked · 6/8] Waiting on upstream — #7 blocked since 2026-09-14: step 7");
  // A question in the plan is what the line leads with: the worker waits for its answer.
  expect(planBriefLine("project-2 evict", PLAN, null, false)).toBe("[project-2 evict · Waiting for an answer · 6/8] Waiting on upstream — open question: Split the cache into its own PR?");
  // A wake that failed or stopped is what happened, whatever the plan says.
  expect(planBriefLine("project-2 evict", SETTLED, { at: "2026-09-27T12:00:00.000Z", kind: "error" }, false)).toBe("[project-2 evict · Failed · 6/8] Waiting on upstream");
  expect(planBriefLine("project-2 evict", PLAN, { at: "2026-09-27T12:00:00.000Z", kind: "stopped" }, false)).toBe("[project-2 evict · Stopped · 6/8] Waiting on upstream");
  // At work on its question's answer, it is in progress, not waiting.
  expect(planBriefLine("project-2 evict", { ...PLAN, steps: PLAN.steps.map((s) => ({ ...s, status: "done" as const })) }, null, true)).toContain("· In progress ·");
  expect(planBriefLine("fresh", emptyPlan("feat_2"), null, false)).toBe("[fresh · Planning] No plan yet");
  expect(planBriefLine("seeded", { ...emptyPlan("feat_3"), conclusion: "Old summary line", updatedAt: "2026-09-26T00:00:00.000Z" }, null, false)).toBe("[seeded · Planning] Old summary line");
  const multi = { ...PLAN, conclusion: "Waiting\non upstream", steps: PLAN.steps.map((s) => s.id === 7 ? { ...s, title: "step\n7" } : s) };
  expect(planBriefLine("project-2 evict", { ...multi, openQuestions: [] }, null, false)).toBe("[project-2 evict · Blocked · 6/8] Waiting on upstream — #7 blocked since 2026-09-14: step 7");
  expect(planBriefLine("project-2\nevict", PLAN, null, false).split("\n")).toHaveLength(1);
});

test("every kind of line break reads as one space", () => {
  expect(oneLine(" a\rb\u2028c\u2029d\u0085e\r\n  f\tg ")).toBe("a b c d e f g");
});

test("limits count characters, so CJK text is measured as written", () => {
  expect(charLength("等待上游")).toBe(4);
  expect(charLength("a😀b")).toBe(3);
});
