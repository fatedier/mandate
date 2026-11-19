import { expect, test } from "bun:test";
import {
  REPORTABLE_KEYS,
  WORKER_REPORT_LABEL,
  formatWorkerReportText,
  workerReportLine,
  workerReportMetadata,
  workerReportOf,
  workerStateKey,
  type WorkerReport
} from "../src/shared/worker-report.js";
import type { WorkerPlanDto, PlanStepDto } from "../src/shared/api/plans.js";

function step(id: number, status: PlanStepDto["status"], note: string | null = null): PlanStepDto {
  return { id, title: `Step ${id}`, status, note, createdAt: "t", startedAt: null, blockedAt: null, completedAt: null, updatedAt: "t" };
}
function plan(steps: PlanStepDto[], extra: Partial<WorkerPlanDto> = {}): WorkerPlanDto {
  return { workerId: "wkr_1", goal: "g", conclusion: "Upstream landed; tests pass.", openQuestions: [], steps, goalHistory: [], updatedAt: "t", ...extra };
}

test("workerStateKey: the wake's outcome first, then what is asked, then the plan", () => {
  const working = plan([step(1, "in_progress")]);
  const asking = plan([step(1, "in_progress")], { openQuestions: ["Accept the write-behind risk?"] });
  expect(workerStateKey("error", working)).toBe("failed");
  expect(workerStateKey("error", asking)).toBe("failed");
  expect(workerStateKey("cut_off", asking)).toBe("stopped");
  // A question in the plan is what the worker asks: no flag says so.
  expect(workerStateKey("finished", asking)).toBe("input");
  expect(workerStateKey("finished", plan([step(1, "done")], { openQuestions: ["Ship it?"] }))).toBe("input");
  expect(workerStateKey("finished", plan([step(1, "blocked"), step(2, "pending")]))).toBe("blocked");
  expect(workerStateKey("finished", working)).toBe("in_progress");
  expect(workerStateKey("finished", plan([step(1, "pending")]))).toBe("paused");
  expect(workerStateKey("finished", plan([step(1, "done")]))).toBe("done");
  expect(workerStateKey("finished", null)).toBe("planning");
});

test("workerReportLine: each key says the one thing the reader needs", () => {
  expect(workerReportLine("input", plan([], { openQuestions: ["Accept the write-behind risk?", "b"] }), null)).toBe("Accept the write-behind risk?");
  expect(workerReportLine("done", plan([step(1, "done")]), null)).toBe("Upstream landed; tests pass.");
  expect(workerReportLine("done", plan([step(1, "done")], { conclusion: null }), null)).toBe("Finished its plan.");
  expect(workerReportLine("blocked", plan([step(3, "blocked", "waits on upstream/project-2#17")]), null)).toBe("#3 Step 3 — waits on upstream/project-2#17");
  expect(workerReportLine("blocked", plan([step(3, "blocked")]), null)).toBe("#3 Step 3");
  expect(workerReportLine("failed", null, "provider returned 500")).toBe("provider returned 500");
  expect(workerReportLine("failed", null, null)).toBe("The wake ended in an error.");
  expect(workerReportLine("stopped", plan([step(1, "done"), step(2, "in_progress")]), null)).toBe("Stopped on #2 Step 2.");
  expect(workerReportLine("stopped", null, null)).toBe("Stopped.");
  expect(workerReportLine("input", plan([]), null)).toBe("Waiting for your input.");
});

test("report metadata round-trips; text is what the model reads", () => {
  const report: WorkerReport = { workerId: "wkr_1", workerName: "project-2 cache expiry", projectId: "proj_1", projectName: "project-1", key: "done", line: "Tests pass." };
  const content = { type: "text" as const, text: formatWorkerReportText(report), metadata: workerReportMetadata(report) };
  expect(workerReportOf(content)).toEqual(report);
  expect(content.text).toBe("[Worker report] project-2 cache expiry (wkr_1, project project-1): done — Tests pass.");
  expect(workerReportOf({ type: "text", text: "hi" })).toBe(null);
  expect(workerReportOf({ type: "text", text: "x", metadata: { workerReport: { workerId: "f", key: "nonsense" } } })).toBe(null);
});

// A worker that stops with steps open and nothing to wake it.
const IDLE = "It stopped with steps still open and nothing set to wake it, so it stays idle until you message it.";

test("a silent stop is a report of its own: labelled Went quiet, read back like any other, never a state a turn ends in", () => {
  expect(WORKER_REPORT_LABEL.silent).toBe("Went quiet");
  const report: WorkerReport = { workerId: "wkr_1", workerName: "evicthook", projectId: "p1", projectName: "project-1", key: "silent", line: IDLE };
  expect(workerReportOf({ type: "text", text: formatWorkerReportText(report), metadata: workerReportMetadata(report) })).toEqual(report);
  expect(REPORTABLE_KEYS).not.toContain("silent");
});

// The model reads "idle", not "silent": the stored key stays, so reports
// already written read back the same.
test("a silent stop reads to the manager as idle, waiting for its message", () => {
  const report: WorkerReport = { workerId: "wkr_1", workerName: "evicthook", projectId: "p1", projectName: "project-1", key: "silent", line: IDLE };
  expect(formatWorkerReportText(report)).toBe(`[Worker report] evicthook (wkr_1, project project-1): idle — ${IDLE}`);
});

test("a silent stop's line names the next open step: the one in progress, else the first pending", () => {
  expect(workerReportLine("silent", plan([step(1, "done"), step(2, "pending"), step(3, "pending")]), null)).toBe(`${IDLE} Next open step: #2 Step 2`);
  expect(workerReportLine("silent", plan([step(1, "pending"), step(2, "in_progress")]), null)).toBe(`${IDLE} Next open step: #2 Step 2`);
  // A title is one line to the model, whatever was written.
  expect(workerReportLine("silent", plan([{ ...step(4, "pending"), title: "Deploy\nthen check" }]), null)).toBe(`${IDLE} Next open step: #4 Deploy then check`);
  expect(workerReportLine("silent", plan([step(1, "done")]), null)).toBe(IDLE);
  expect(workerReportLine("silent", null, null)).toBe(IDLE);
});
