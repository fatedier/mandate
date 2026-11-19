import { expect, test } from "bun:test";
import { emptyPlan, type WorkerPlanDto, type PlanStepStatus } from "../src/shared/api/plans.js";
import { WORKER_STATE_LABEL, workerStateFor, workerStateLine, firstPaneId, isAsking, planProgress, waitingOnYou } from "../src/shared/worker-state.js";

function planWith(...statuses: PlanStepStatus[]): WorkerPlanDto {
  return {
    ...emptyPlan("wkr_1"),
    conclusion: "Waiting on upstream",
    steps: statuses.map((status, i) => ({
      id: i + 1, title: `step ${i + 1}`, status, note: status === "blocked" ? "waits on project-2#17" : null,
      createdAt: "2026-09-14T10:00:00.000Z", startedAt: null,
      blockedAt: status === "blocked" ? "2026-09-14T18:40:00.000Z" : null,
      completedAt: status === "done" ? "2026-09-14T11:00:00.000Z" : null,
      updatedAt: "2026-09-14T18:40:00.000Z"
    })),
    updatedAt: "2026-09-14T18:40:00.000Z"
  };
}

/** The same plan with a question its worker asked. */
function asking(plan: WorkerPlanDto): WorkerPlanDto {
  return { ...plan, openQuestions: ["Split the cache into its own PR?"] };
}

test("each state follows from the steps; a question at rest and a failure win over them", () => {
  expect(workerStateFor(null)).toBe("planning");
  expect(workerStateFor(planWith())).toBe("planning");
  expect(workerStateFor(planWith("done", "in_progress", "blocked"))).toBe("in_progress");
  expect(workerStateFor(planWith("done", "blocked", "pending"))).toBe("blocked");
  expect(workerStateFor(planWith("done", "pending"))).toBe("paused");
  expect(workerStateFor(planWith("done", "done"))).toBe("done");
  expect(workerStateFor(planWith("in_progress"), "2026-09-27T00:00:00Z")).toBe("failed");
  expect(workerStateFor(planWith("in_progress"), "2026-09-27T00:00:00Z", "stopped")).toBe("stopped");
  expect(WORKER_STATE_LABEL).toEqual({
    failed: "Failed", stopped: "Stopped", asking: "Waiting for an answer",
    planning: "Planning", in_progress: "In progress", blocked: "Blocked", paused: "Paused", done: "Done"
  });
});

// A worker asks by writing a question into its plan: nothing else records
// it. It is waiting for the answer once it rests; while its turn runs it is
// still at work, and its state is what its steps say.
test("a worker with a question in its plan is waiting for an answer once it rests, and at work until then", () => {
  expect(isAsking(asking(planWith("in_progress")))).toBe(true);
  expect(isAsking(planWith("in_progress"))).toBe(false);
  expect(isAsking(null)).toBe(false);
  expect(workerStateFor(asking(planWith("in_progress")))).toBe("asking");
  expect(workerStateFor(asking(planWith()))).toBe("asking");
  expect(workerStateFor(asking(planWith("done", "pending")))).toBe("asking");
  const running = true;
  expect(workerStateFor(asking(planWith("in_progress")), null, null, running)).toBe("in_progress");
  expect(workerStateFor(asking(planWith()), null, null, running)).toBe("planning");
  expect(workerStateFor(asking(planWith("done", "blocked")), null, null, running)).toBe("blocked");
  // Every step done and a question just asked in the turn still running: not Done, it waits on an answer.
  expect(workerStateFor(asking(planWith("done", "done")), null, null, running)).toBe("in_progress");
  expect(workerStateFor(planWith("done", "done"), null, null, running)).toBe("done");
  // A failure is the user's to see, question or not.
  expect(workerStateFor(asking(planWith("in_progress")), "2026-09-27T00:00:00Z")).toBe("failed");
  expect(workerStateFor(asking(planWith("in_progress")), "2026-09-27T00:00:00Z", "stopped")).toBe("stopped");
});

test("what a worker waits on someone for: a failure or a stop, else nothing", () => {
  const failedAt = "2026-09-27T00:00:00Z";
  expect(waitingOnYou(failedAt)).toBe("failed");
  expect(waitingOnYou(failedAt, "stopped")).toBe("stopped");
  expect(waitingOnYou(null)).toBe(null);
  expect(waitingOnYou(undefined)).toBe(null);
});

test("progress counts done steps over all steps", () => {
  expect(planProgress(planWith("done", "blocked", "pending", "done"))).toEqual({ done: 2, total: 4 });
  expect(planProgress(null)).toEqual({ done: 0, total: 0 });
});

test("the one-line reading leads with what matters for the state", () => {
  expect(workerStateLine(planWith("done", "in_progress"))).toEqual({ state: "in_progress", lead: "Now:", text: "step 2", pane: null });
  expect(workerStateLine(planWith("done", "blocked", "pending"))).toEqual({ state: "blocked", lead: "Blocked:", text: "step 2", pane: null });
  expect(workerStateLine(planWith("done", "pending"))).toEqual({ state: "paused", lead: "Next:", text: "step 2", pane: null });
  expect(workerStateLine(planWith("done"))).toEqual({ state: "done", lead: null, text: "Waiting on upstream", pane: null });
  // A migrated worker keeps its old line (seeded as the conclusion) until the worker writes steps.
  expect(workerStateLine(planWith())).toEqual({ state: "planning", lead: null, text: "Waiting on upstream", pane: null });
  expect(workerStateLine({ ...planWith(), conclusion: null })).toEqual({ state: "planning", lead: null, text: "No plan yet", pane: null });
  expect(workerStateLine(asking(planWith("in_progress")))).toEqual({ state: "asking", lead: "Open question:", text: "Split the cache into its own PR?", pane: null });
  // Still in its turn: the step it is on.
  expect(workerStateLine(asking(planWith("in_progress")), null, true)).toEqual({ state: "in_progress", lead: "Now:", text: "step 1", pane: null });
});

test("workerStateLine: a failed worker leads with Failed:, a stopped one with Stopped: and its reason", () => {
  const line = workerStateLine(planWith("in_progress"), { at: "2026-09-27T00:00:00Z", message: "provider returned 500" });
  expect(line).toEqual({ state: "failed", lead: "Failed:", text: "provider returned 500", pane: null });
  const at = "2026-10-01T09:00:00.000Z";
  expect(workerStateLine(null, { at, message: "spawn_pane failed 5 times in a row: x", kind: "stopped" }))
    .toEqual({ state: "stopped", lead: "Stopped:", text: "spawn_pane failed 5 times in a row: x", pane: null });
  expect(workerStateLine(null, { at, message: null, kind: "stopped" }).text).toBe("Stopped.");
});

test("an in-progress step that names a pane carries it", () => {
  const plan = planWith("in_progress");
  plan.steps[0]!.note = "Test suite running in %133 (started by me)";
  expect(workerStateLine(plan).pane).toBe("%133");
  expect(firstPaneId("see %7, then %8")).toBe("%7");
  expect(firstPaneId("100%5 off")).toBe(null);
  expect(firstPaneId("pane=%133")).toBe("%133");
  expect(firstPaneId("[%133]")).toBe("%133");
  // Chinese is written without spaces: a pane id against CJK text is still a pane.
  expect(firstPaneId("在%133里跑")).toBe("%133");
  expect(firstPaneId(null)).toBe(null);
});
