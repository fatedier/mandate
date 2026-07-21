import { expect, test } from "bun:test";
import type { MemoryDreamRunDto } from "../../src/shared/api-contracts.js";
import {
  runDetailText,
  summarizeRunResult
} from "../../src/client/routes/memory/dream/helpers.js";

function dreamRun(overrides: Partial<MemoryDreamRunDto> = {}): MemoryDreamRunDto {
  return {
    id: "drm-test",
    trigger: "idle",
    status: "succeeded",
    provider: "codex",
    model: "codex/gpt-5.6-sol",
    phase: "global",
    projectId: null,
    projectName: null,
    candidateCount: 10,
    appliedCount: 8,
    actionCount: 10,
    actionCounts: { keep: 3, update: 2, merge: 2, archive: 1, rescope: 0 },
    rejectedCount: 2,
    failedCount: 0,
    finishReason: "finished",
    error: null,
    metadata: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    availableCountBefore: 20,
    availableCountAfter: 17,
    ...overrides
  };
}

test("summarizeRunResult reports applied action types separately", () => {
  expect(summarizeRunResult(dreamRun())).toBe(
    "2 updated · 2 merged · 1 archived · 3 kept · 2 rejected"
  );
});

/** The run row gets one truncated line for the narrative, and boilerplate used
 *  to consume most of it: every succeeded run opened with "finished: " and the
 *  model wrote raw 36-character UUIDs into prose naming the very partition the
 *  row already shows as a chip. */
test("runDetailText drops the finished prefix and shortens UUIDs to their first segment", () => {
  const run = dreamRun({
    finishReason:
      "finished: Reviewed 35 memories in partition ebf44b48-f36d-4fa4-878f-2313e4134a3e and applied 35 actions"
  });
  expect(runDetailText(run)).toBe("Reviewed 35 memories in partition ebf44b48 and applied 35 actions");
});

test("runDetailText keeps an outcome-carrying prefix like failed:", () => {
  const run = dreamRun({
    status: "failed",
    finishReason: "failed: provider returned 500"
  });
  expect(runDetailText(run)).toBe("failed: provider returned 500");
});

test("runDetailText is empty when the reason only restates the status", () => {
  expect(runDetailText(dreamRun({ status: "skipped", finishReason: "skipped" }))).toBe("");
  expect(runDetailText(dreamRun({ finishReason: null }))).toBe("");
});
