import { expect, test } from "bun:test";
import { workerStatePill } from "@/lib/worker-status";
import { emptyPlan, type WorkerPlanDto, type PlanStepStatus } from "@shared/api/plans";

function plan(...statuses: PlanStepStatus[]): WorkerPlanDto {
  return {
    ...emptyPlan("f"),
    steps: statuses.map((status, i) => ({
      id: i + 1, title: `s${i + 1}`, status, note: "n", createdAt: "2026-09-14T12:00:00.000Z",
      startedAt: null, blockedAt: null, completedAt: null, updatedAt: "2026-09-14T12:00:00.000Z"
    })),
    updatedAt: "2026-09-14T12:00:00.000Z"
  };
}

test("a worker with a question in its plan waits for an answer, in amber, once it rests; in its turn it is still at work", () => {
  const asks = { ...plan("in_progress"), openQuestions: ["Keep the old flag as an alias?"] };
  expect(workerStatePill(asks)).toEqual({ label: "Waiting for an answer", tone: "amber", state: "asking" });
  expect(workerStatePill(asks, null, null, true)).toEqual({ label: "In progress", tone: "blue", state: "in_progress" });
});

test("every plan-derived state has its label and tone", () => {
  expect(workerStatePill(null)).toEqual({ label: "Planning", tone: "neutral", state: "planning" });
  expect(workerStatePill(plan("done", "in_progress"))).toEqual({ label: "In progress", tone: "blue", state: "in_progress" });
  expect(workerStatePill(plan("done", "blocked"))).toEqual({ label: "Blocked", tone: "amber", state: "blocked" });
  expect(workerStatePill(plan("done", "pending"))).toEqual({ label: "Paused", tone: "neutral", state: "paused" });
  expect(workerStatePill(plan("done"))).toEqual({ label: "Done", tone: "green", state: "done" });
});

test("a failed wake shows as Failed, over a question and over a finished plan", () => {
  const failedAt = "2026-09-27T10:00:00.000Z";
  expect(workerStatePill(plan("in_progress"), failedAt).state).toBe("failed");
  expect(workerStatePill(plan("in_progress"), failedAt).tone).toBe("red");
  // A failure is the user's to see; the question waits behind it.
  expect(workerStatePill({ ...plan("in_progress"), openQuestions: ["Keep the flag?"] }, failedAt).state).toBe("failed");
  // A failure after the plan finished is what shows.
  expect(workerStatePill(plan("done"), failedAt).state).toBe("failed");
});
