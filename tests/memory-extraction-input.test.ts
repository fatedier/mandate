import { expect, test } from "bun:test";
import { renderWindowForExtraction, userStatementsOf } from "../src/server/modules/memory/extraction-input.js";
import { estimateTextTokens } from "../src/server/modules/agent/compression.js";
import type { AgentMessage } from "../src/server/modules/agent/agent-store.js";
import { stub } from "./helpers/typed.js";

const message = (fields: Partial<AgentMessage> & Pick<AgentMessage, "role" | "source" | "content">) =>
  stub<AgentMessage>({ id: `m${Math.random()}`, threadId: "t", seq: 1, createdAt: "2026-10-07T00:00:00.000Z", ...fields });

test("the user's words stay whole; assistant turns name their tools; context rows and summaries are left out", () => {
  const text = renderWindowForExtraction([
    message({ role: "system", source: "self", content: { type: "text", text: "SYSTEM PROMPT" } }),
    message({ role: "user", source: "runtime-context", content: { type: "text", text: "RUNTIME" } }),
    message({ role: "user", source: "plan-reminder", content: { type: "text", text: "PLAN REMINDER" } }),
    message({ role: "user", source: "output-limit", content: { type: "text", text: "CUT NOTE" } }),
    message({ role: "user", source: "compression", content: { type: "summary", summary: "EARLIER", replacedRange: [1, 2], replacedCount: 2, retained: [] } }),
    message({ role: "user", source: "user", content: { type: "text", text: "From now on write commit messages in English" } }),
    message({ role: "assistant", source: "self", content: { type: "assistant", text: "OK", toolCalls: [{ toolCallId: "c", toolName: "bash", args: {} }] } }),
    message({ role: "user", source: "voice", content: { type: "text", text: "spoken words" } })
  ], 10_000);
  expect(text).toContain("[user] From now on write commit messages in English");
  expect(text).toContain("[assistant] OK (called bash)");
  expect(text).toContain("[user] spoken words");
  for (const absent of ["SYSTEM PROMPT", "RUNTIME", "PLAN REMINDER", "CUT NOTE", "EARLIER"]) expect(text).not.toContain(absent);
});

test("each day's part of the window starts with its date, also after the middle is cut", () => {
  const day = (d: string, text: string) => message({ role: "user", source: "user", createdAt: `2026-10-${d}T09:00:00.000Z`, content: { type: "text", text } });
  expect(renderWindowForExtraction([day("15", "a"), day("15", "b"), day("16", "c"), day("16", "d")], 10_000))
    .toBe("--- 2026-10-15 ---\n[user] a\n[user] b\n--- 2026-10-16 ---\n[user] c\n[user] d");
  // The days are those of the rows kept: the first kept after a cut still says its day.
  const many = [day("15", "start"), ...Array.from({ length: 50 }, (_, i) => day("16", `middle ${i} ${"y".repeat(400)}`)), day("17", "end")];
  const fitted = renderWindowForExtraction(many, 600);
  expect(fitted.startsWith("--- 2026-10-15 ---\n[user] start")).toBe(true);
  expect(fitted).toContain("messages omitted …]\n--- 2026-10-1");
  expect(fitted.endsWith("--- 2026-10-17 ---\n[user] end")).toBe(true);
});

test("the day lines count toward the budget", () => {
  const daily = (n: number) => Array.from({ length: n }, (_, i) => message({
    role: "user", source: "user", createdAt: new Date(Date.UTC(2026, 0, 1 + i, 9)).toISOString(),
    content: { type: "text", text: "Always keep replies concise." }
  }));
  for (const n of [30, 90, 100]) {
    const rendered = renderWindowForExtraction(daily(n), 1_000);
    // The omitted-rows line was never counted; everything else is.
    const omitted = rendered.split("\n").find((line) => line.startsWith("[… ")) ?? "";
    expect(estimateTextTokens(rendered) - estimateTextTokens(omitted)).toBeLessThanOrEqual(1_000);
  }
});

test("rows of one day share their day line: the budget keeps as many of them as fit", () => {
  const rows = Array.from({ length: 200 }, (_, i) => message({
    role: "user", source: "user", createdAt: "2026-10-16T09:00:00.000Z",
    content: { type: "text", text: `row ${String(i).padStart(3, "0")} ${"word ".repeat(10)}` }
  }));
  const rowTokens = estimateTextTokens(`[user] row 000 ${"word ".repeat(10)}`);
  const dayLine = estimateTextTokens("--- 2026-10-16 ---");
  const kept = renderWindowForExtraction(rows, 1_000).split("\n").filter((line) => line.startsWith("[user]")).length;
  // Two day lines (the start and after the cut), the rest rows.
  expect(kept).toBeGreaterThanOrEqual(Math.floor((1_000 - 2 * dayLine) / rowTokens) - 1);
});

test("the first and the last row always fit together, day lines and all", () => {
  // Each row just under half the budget, so none is cut: only the day lines
  // can push the last one out.
  const sized = (text: string) => {
    let pad = 0;
    while (estimateTextTokens(`[user] ${text} ${"z".repeat(pad + 1)}`) < 499) pad += 1;
    return `${text} ${"z".repeat(pad)}`;
  };
  const big = (text: string) => message({ role: "user", source: "user", createdAt: "2026-10-16T09:00:00.000Z", content: { type: "text", text: sized(text) } });
  const rendered = renderWindowForExtraction([big("first"), big("middle"), big("last correction")], 1_000);
  expect(rendered).toContain("[user] first");
  expect(rendered).toContain("[user] last correction");
  expect(rendered).not.toContain("[user] middle");
});

test("a long tool result is cut, and a window over budget keeps its start and end", () => {
  const big = "x".repeat(40_000);
  const one = renderWindowForExtraction([
    message({ role: "user", source: "self", content: { type: "tool_result", toolCallId: "c", toolName: "read_file", result: big } })
  ], 100_000);
  expect(one.length).toBeLessThan(12_000);
  expect(one).toContain("[cut]");

  const many = Array.from({ length: 200 }, (_, i) =>
    message({ role: "user", source: "user", content: { type: "text", text: `turn ${i} ${"y".repeat(400)}` } }));
  const fitted = renderWindowForExtraction(many, 2_000);
  expect(fitted).toContain("turn 0 ");
  expect(fitted).toContain("turn 199 ");
  expect(fitted).toMatch(/\[… \d+ messages omitted …\]/);
});

test("a window over budget keeps a large first turn and the last turn when both fit", () => {
  const turn = (label: string, size: number) =>
    message({ role: "user", source: "user", content: { type: "text", text: `${label} ${"y".repeat(size)}` } });
  const lines = [turn("first", 2_000), ...Array.from({ length: 20 }, (_, i) => turn(`middle ${i}`, 100)), turn("last", 1_000)];
  const fitted = renderWindowForExtraction(lines, 1_000);
  expect(fitted).toContain("first ");
  expect(fitted).toContain("last ");
  expect(fitted).toMatch(/\[… \d+ messages omitted …\]/);
  expect(estimateTextTokens(fitted)).toBeLessThanOrEqual(1_000 + 20);
});

// A retained turn too large to keep whole reaches extraction as stored, and
// can be larger than the whole budget: its start and its end are both kept.
test("a turn larger than the whole budget keeps its start and its end", () => {
  const paste = `START ${"log line ".repeat(5_000)}END-INSTRUCTION keep releases tagged from main`;
  const fitted = renderWindowForExtraction([message({ role: "user", source: "user", content: { type: "text", text: paste } })], 1_000);
  expect(fitted).toContain("[user] START");
  expect(fitted).toContain("END-INSTRUCTION keep releases tagged from main");
  expect(fitted).not.toContain("omitted");
  expect(estimateTextTokens(fitted)).toBeLessThanOrEqual(1_000);
});

test("the user's statements are the typed and spoken user turns only, with when and which", () => {
  expect(userStatementsOf([
    message({ id: "m_typed", role: "user", source: "user", content: { type: "text", text: "typed" } }),
    message({ id: "m_spoken", role: "user", source: "voice", content: { type: "text", text: "spoken" }, createdAt: "2026-10-07T01:00:00.000Z" }),
    message({ role: "user", source: "manager", content: { type: "text", text: "from the manager" } })
  ])).toEqual([
    { text: "typed", at: "2026-10-07T00:00:00.000Z", id: "m_typed" },
    { text: "spoken", at: "2026-10-07T01:00:00.000Z", id: "m_spoken" }
  ]);
});
