import { expect, test } from "bun:test";
import {
  formatSubagentDuration,
  formatSubagentResultText,
  subagentResultMetadata
} from "../src/shared/subagent-messages.js";

// What a parent reads when one of its subagents ends, and how long a run
// took, as it says it.

test("a run's time reads in seconds under a minute, then minutes and seconds, then hours and minutes", () => {
  expect([0, 999, 45_000, 60_000, 63_000, 252_000, 3_599_999, 3_600_000, 3_900_000].map(formatSubagentDuration))
    .toEqual(["0s", "0s", "45s", "1m 00s", "1m 03s", "4m 12s", "59m 59s", "1h 00m", "1h 05m"]);
});

const run = {
  title: "Find the retry call sites",
  reply: "Two call sites: src/server/runtime/agent-runtime.ts:472 and src/server/modules/agent/wake-loop.ts:612.",
  error: null
};

test("a finished run: how long it took, then its reply; one that left none says how it ended alone", () => {
  expect(formatSubagentResultText({ ...run, outcome: "finished", durationMs: 252_000 })).toBe(
    "[Subagent result] “Find the retry call sites”: finished after 4m 12s.\n\n" +
    "Two call sites: src/server/runtime/agent-runtime.ts:472 and src/server/modules/agent/wake-loop.ts:612."
  );
  expect(formatSubagentResultText({ ...run, reply: "  \n", outcome: "finished", durationMs: 45_000 }))
    .toBe("[Subagent result] “Find the retry call sites”: finished after 45s.");
});

test("a run the user stopped says so, then what it had said by then", () => {
  expect(formatSubagentResultText({ ...run, reply: null, outcome: "stopped", durationMs: 63_000 }))
    .toBe("[Subagent result] “Find the retry call sites”: stopped by the user after 1m 03s, before it finished.");
  expect(formatSubagentResultText({ ...run, reply: "Halfway through src/server.", outcome: "stopped", durationMs: 63_000 })).toBe(
    "[Subagent result] “Find the retry call sites”: stopped by the user after 1m 03s, before it finished.\n\nHalfway through src/server."
  );
});

test("a failed run gives its reason with one full stop; an interrupted one says to start it again", () => {
  expect(formatSubagentResultText({ ...run, reply: null, outcome: "failed", error: "The provider refused the request.", durationMs: 130_000 }))
    .toBe("[Subagent result] “Find the retry call sites”: failed after 2m 10s: The provider refused the request.");
  expect(formatSubagentResultText({ ...run, reply: "Found one so far.", outcome: "failed", error: "it kept repeating a failing call", durationMs: 130_000 })).toBe(
    "[Subagent result] “Find the retry call sites”: failed after 2m 10s: it kept repeating a failing call.\n\nFound one so far."
  );
  expect(formatSubagentResultText({ ...run, reply: null, outcome: "failed", error: null, durationMs: 0 }))
    .toBe("[Subagent result] “Find the retry call sites”: failed after 0s: unknown error.");
  expect(formatSubagentResultText({ ...run, reply: null, outcome: "interrupted", durationMs: 90_000 }))
    .toBe("[Subagent result] “Find the retry call sites”: was interrupted when Mandate restarted, before it finished. Start it again if you still need it.");
});

// The card in the parent's conversation is drawn from the metadata alone.
test("the metadata a result carries is everything its card draws", () => {
  expect(subagentResultMetadata({ taskId: "task_1", outcome: "finished", title: "Find the retry call sites", durationMs: 252_000, reply: "Two call sites.", error: null }))
    .toEqual({ taskId: "task_1", outcome: "finished", title: "Find the retry call sites", durationMs: 252_000, reply: "Two call sites.", error: null });
  expect(subagentResultMetadata({ taskId: "task_2", outcome: "stopped", title: "Map the cache layer", durationMs: 0, reply: null, error: null }))
    .toEqual({ taskId: "task_2", outcome: "stopped", title: "Map the cache layer", durationMs: 0, reply: null, error: null });
  // Why one failed, for its card.
  expect(subagentResultMetadata({ taskId: "task_3", outcome: "failed", title: "Map the cache layer", durationMs: 9_000, reply: null, error: "it reached its step limit" }))
    .toEqual({ taskId: "task_3", outcome: "failed", title: "Map the cache layer", durationMs: 9_000, reply: null, error: "it reached its step limit" });
});
