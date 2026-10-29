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
    phase: "user",
    projectId: null,
    projectName: null,
    candidateCount: 10,
    appliedCount: 8,
    actionCount: 10,
    actionCounts: { update: 2, merge: 2, archive: 1, move: 0, split: 0 },
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
    "2 updated · 2 merged · 1 archived · 2 rejected"
  );
});

/** The run row gets one truncated line for the narrative, and boilerplate used
 *  to consume most of it: every succeeded run opened with "finished: " and the
 *  model wrote raw 36-character UUIDs into prose naming the very partition the
 *  row already shows as a chip. */
const runDetailRows: Array<{ name: string; runs: Array<Partial<MemoryDreamRunDto>>; text: string }> = [
  {
    name: "runDetailText drops the finished prefix and shortens UUIDs to their first segment",
    runs: [{ finishReason: "finished: Reviewed 35 memories in partition 3c4d5e6f-7a8b-4c9d-8e0f-2a3b4c5d6e7f and applied 35 actions" }],
    text: "Reviewed 35 memories in partition 3c4d5e6f and applied 35 actions"
  },
  {
    name: "runDetailText keeps an outcome-carrying prefix like failed:",
    runs: [{ status: "failed", finishReason: "failed: provider returned 500" }],
    text: "failed: provider returned 500"
  },
  {
    name: "runDetailText is empty when the reason only restates the status",
    runs: [{ status: "skipped", finishReason: "skipped" }, { finishReason: null }],
    text: ""
  }
];

test.each(runDetailRows)("$name", ({ runs, text }) => {
  for (const overrides of runs) expect(runDetailText(dreamRun(overrides))).toBe(text);
});
