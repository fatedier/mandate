import { expect, test } from "bun:test";
import { threadDot, type ThreadSignal } from "../src/shared/thread-dot.js";
import { DOT_ARIA, SIDEBAR_RANK, WAITING_ORDER, WAITING_WORD } from "../src/shared/status-words.js";

const idle: ThreadSignal = { running: false, failed: false, watching: null, asking: false };

test("a current verdict shows blue, under failed and needs you, over the clock", () => {
  expect(threadDot({ ...idle, verdict: "decision" }, [])).toBe("decision");
  expect(threadDot({ ...idle, verdict: "result" }, [])).toBe("result");
  expect(threadDot({ ...idle, verdict: "result", asking: true }, [])).toBe("needs_you");
  expect(threadDot({ ...idle, verdict: "decision", failed: true }, [])).toBe("failed");
  expect(threadDot({ ...idle, verdict: "result", watching: "alarm" }, [])).toBe("result");
});

test("the sidebar ranks what wants you first, then blue, then the rest", () => {
  expect([SIDEBAR_RANK.failed, SIDEBAR_RANK.needs_you, SIDEBAR_RANK.decision, SIDEBAR_RANK.result, SIDEBAR_RANK.working, SIDEBAR_RANK.watching, SIDEBAR_RANK.idle])
    .toEqual([0, 0, 1, 1, 2, 2, 2]);
});

test("one order and one word for what waits on the user", () => {
  const kinds = ["result", "input", "decision", "stopped", "failed"] as const;
  expect([...kinds].sort((a, b) => WAITING_ORDER[a] - WAITING_ORDER[b])).toEqual(["stopped", "failed", "input", "decision", "result"]);
  expect(kinds.map((kind) => WAITING_WORD[kind])).toEqual(["Result to read", "Needs you", "Decision needed", "Stopped", "Failed"]);
  expect([DOT_ARIA.decision, DOT_ARIA.result, DOT_ARIA.needs_you, DOT_ARIA.failed]).toEqual(["decision needed", "result to read", "needs you", "failed or stopped"]);
});
