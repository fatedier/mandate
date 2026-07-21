import { expect, test } from "bun:test";
import { truncateToolResultContent } from "../src/server/platform/db/tool-result-truncate.js";

const toolResult = (result: unknown) => JSON.stringify({
  type: "tool_result",
  toolCallId: "call_abc123",
  toolName: "bash",
  result
});

test("truncates a long string result and keeps the head", () => {
  const out = truncateToolResultContent(toolResult("x".repeat(5000)), 2000);
  expect(out).not.toBeNull();
  const parsed = JSON.parse(out!);
  expect(parsed.result.startsWith("x".repeat(2000))).toBe(true);
  expect(parsed.result).toContain("[truncated, original 5000 chars]");
  // Identity fields survive: the row must stay a usable transcript entry.
  expect(parsed.type).toBe("tool_result");
  expect(parsed.toolCallId).toBe("call_abc123");
  expect(parsed.toolName).toBe("bash");
});

test("leaves an object result alone", () => {
  // 34,701 rows in production hold an object here and only 29.7 MB between them.
  // Truncating one needs its schema; this is a deliberate limit, not an oversight.
  expect(truncateToolResultContent(toolResult({ stdout: "y".repeat(9000) }), 2000)).toBeNull();
});

test("leaves a result already shorter than the cap alone", () => {
  // Without this, every pass rewrites the same rows forever and never reaches
  // the ones behind them.
  expect(truncateToolResultContent(toolResult("short"), 2000)).toBeNull();
});

test("a result exactly the length of the cap is left alone", () => {
  // The boundary the `<=` above turns on, and the one worth pinning: at `<`
  // this row would be rewritten to the same 2,000 characters plus a marker
  // claiming 2,000 were truncated, growing the row it was meant to shrink and
  // then asking to be selected again on the next pass.
  expect(truncateToolResultContent(toolResult("t".repeat(2000)), 2000)).toBeNull();
  // One character over is the first length that does change, so the assertion
  // above is about the boundary and not about truncation being broken.
  expect(truncateToolResultContent(toolResult("t".repeat(2001)), 2000)).not.toBeNull();
});

test("is idempotent: a truncated result is not truncated again", () => {
  const once = truncateToolResultContent(toolResult("z".repeat(5000)), 2000)!;
  expect(truncateToolResultContent(once, 2000)).toBeNull();
});

test("leaves a non-tool_result message alone", () => {
  const assistant = JSON.stringify({ type: "assistant", toolCalls: [] });
  expect(truncateToolResultContent(assistant, 2000)).toBeNull();
  const text = JSON.stringify({ type: "text", text: "w".repeat(9000) });
  expect(truncateToolResultContent(text, 2000)).toBeNull();
});

test("leaves malformed JSON alone instead of throwing", () => {
  expect(truncateToolResultContent("{not json", 2000)).toBeNull();
});

test("counts the ORIGINAL length in the marker, not the truncated one", () => {
  const parsed = JSON.parse(truncateToolResultContent(toolResult("q".repeat(7777)), 2000)!);
  expect(parsed.result).toContain("original 7777 chars");
});
