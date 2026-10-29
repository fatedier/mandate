import { expect, test } from "bun:test";
import { emptyPlan, type FeaturePlanDto } from "../src/shared/api/plans.js";
import { clearWorkerQuestions } from "../src/server/modules/agent/clear-worker-questions.js";

test("clearing a worker's questions pushes the page's plan: the current work, earlier work counted", () => {
  const step = (id: number, createdAt: string) => ({ id, title: `step ${id}`, status: "done" as const, note: null, createdAt, startedAt: null, blockedAt: null, completedAt: createdAt, updatedAt: createdAt });
  const asking: FeaturePlanDto = {
    ...emptyPlan("feat_1"), goal: "Open the PR", openQuestions: ["Push now?"], updatedAt: "2026-10-12T12:00:00.000Z",
    goalHistory: [{ goal: "Draft the notes", changedAt: "2026-10-12T10:00:00.000Z" }],
    steps: [step(1, "2026-10-12T09:00:00.000Z"), step(2, "2026-10-12T10:00:00.000Z")]
  };
  const pushed: Array<{ plan: FeaturePlanDto }> = [];
  clearWorkerQuestions({
    planStore: { get: () => asking, update: () => ({ ok: true, plan: { ...asking, openQuestions: [] } }) as never },
    sse: { emit: (_name: string, data: { plan: FeaturePlanDto }) => { pushed.push(data); } } as never
  }, "feat_1");
  expect(pushed).toHaveLength(1);
  expect(pushed[0]!.plan.steps.map((s) => s.id)).toEqual([2]);
  expect(pushed[0]!.plan.earlierWork).toEqual({ goals: 1, steps: 1, lastStepId: 1 });
});
