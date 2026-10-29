import { expect, test } from "bun:test";
import { ASKING_LABEL, WAITING_LABEL } from "@shared/feature-state";
import { emptyPlan } from "@shared/api/plans";
import { WORKER_REPORT_LABEL } from "@shared/worker-report";
import { WORKER_GROUP_LABEL } from "../../src/client/lib/worker-groups.js";
import { featureStatePill, waitingStateLabel } from "../../src/client/lib/feature-status.js";

test("each way a worker waits on you has one name, wherever it is shown", () => {
  expect(WAITING_LABEL).toEqual({ input: "Needs you", failed: "Failed", stopped: "Stopped" });
  // The panel's groups, the report cards, the state pills and rows.
  expect([WORKER_GROUP_LABEL.failed, WORKER_GROUP_LABEL.stopped])
    .toEqual([WAITING_LABEL.failed, WAITING_LABEL.stopped]);
  expect([WORKER_REPORT_LABEL.failed, WORKER_REPORT_LABEL.stopped])
    .toEqual([WAITING_LABEL.failed, WAITING_LABEL.stopped]);
  const at = "2026-09-29T10:00:00.000Z";
  expect([
    featureStatePill(null, at).label,
    featureStatePill(null, at, "stopped").label
  ]).toEqual([WAITING_LABEL.failed, WAITING_LABEL.stopped]);
  expect(featureStatePill(null, at, "stopped").tone).toBe("red");
  expect([
    waitingStateLabel({ state: "failed", waiting: "failed" }),
    waitingStateLabel({ state: "stopped", waiting: "stopped" }),
    waitingStateLabel({ state: "in_progress", waiting: null })
  ]).toEqual([WAITING_LABEL.failed, WAITING_LABEL.stopped, "In progress"]);
});

// A worker's question is its manager's first, so a worker that asked does not
// "need you": it waits for an answer, under one name and in amber.
test("a worker that waits for an answer has one name wherever it is shown, and it is not Needs you", () => {
  expect(ASKING_LABEL).toBe("Waiting for an answer");
  const asks = { ...emptyPlan("f"), openQuestions: ["Keep the old flag as an alias?"] };
  expect([
    WORKER_GROUP_LABEL.asking,
    WORKER_REPORT_LABEL.input,
    featureStatePill(asks).label,
    waitingStateLabel({ state: "asking", waiting: null })
  ]).toEqual([ASKING_LABEL, ASKING_LABEL, ASKING_LABEL, ASKING_LABEL]);
  expect(featureStatePill(asks).tone).toBe("amber");
});
