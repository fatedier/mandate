import { expect, test } from "bun:test";
import {
  MONITOR_OUTPUT_MAX_CHARS,
  describeOutputChanges,
  normalizeMonitorOutput,
  quoteUntrusted
} from "../src/server/modules/agent/monitor-output.js";
import { tailLines } from "../src/server/platform/text/text.js";

test("normalising strips colour, carriage returns, trailing spaces and trailing blank lines", () => {
  expect(normalizeMonitorOutput("\x1b[32mok\x1b[0m  \r\nnext\t\n\n\n")).toBe("ok\nnext");
});

test("normalising keeps leading whitespace and blank lines in the middle", () => {
  expect(normalizeMonitorOutput("  a\n\n  b\n")).toBe("  a\n\n  b");
});

test("normalised output is capped at 64KB, keeping the head", () => {
  const out = normalizeMonitorOutput(`head\n${"x".repeat(200_000)}`);
  expect(MONITOR_OUTPUT_MAX_CHARS).toBe(65_536);
  expect(out.length).toBe(MONITOR_OUTPUT_MAX_CHARS);
  expect(out.startsWith("head\n")).toBe(true);
});

test("changes list added and removed lines with counts", () => {
  expect(describeOutputChanges("101\n102", "101\n102\n103\n104")).toEqual({ added: 2, removed: 0, lines: ["+ 103", "+ 104"] });
  expect(describeOutputChanges("open", "merged")).toEqual({ added: 1, removed: 1, lines: ["- open", "+ merged"] });
});

test("changes are capped at 40 lines and 2000 chars, saying how many were left out", () => {
  const next = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const changes = describeOutputChanges("", next);
  expect(changes.added).toBe(100);
  expect(changes.lines.length).toBe(41);
  expect(changes.lines.at(-1)).toBe("… 60 more changed lines");
  const wide = describeOutputChanges("", Array.from({ length: 10 }, () => "y".repeat(400)).join("\n"));
  const shown = wide.lines.slice(0, -1).join("\n");
  expect(shown.length).toBeLessThanOrEqual(2000);
  expect(wide.lines.at(-1)).toMatch(/^… \d+ more changed lines$/);
});

// Shown as printed, like bash's output: the agent wrote the command and can
// run it with bash, so hiding parts of its output here protects nothing.
test("changed lines and quoted output show the output as printed", () => {
  expect(describeOutputChanges("", "token=abc123 and sk-abcdefghijklmnop").lines).toEqual(["+ token=abc123 and sk-abcdefghijklmnop"]);
  const lines = quoteUntrusted(`${"a".repeat(5000)}\ntoken=hunter2`, 4000);
  expect(lines.every((line) => line.startsWith("| "))).toBe(true);
  expect(lines.at(-1)).toBe("| token=hunter2");
  expect(lines.join("\n").length).toBeLessThanOrEqual(4000 + 200);
  expect(quoteUntrusted("", 4000)).toEqual(["| (empty)"]);
});

test("a changed line is cut to 500 characters", () => {
  expect(describeOutputChanges("", "s".repeat(600)).lines).toEqual([`+ ${"s".repeat(500)}…`]);
});

test("a 64KB single-word output is described and quoted quickly", () => {
  const huge = `token=hunter2 ${"b".repeat(65_000)}`;
  const started = performance.now();
  const changes = describeOutputChanges("", huge);
  const quoted = quoteUntrusted(huge, 4000);
  expect(performance.now() - started).toBeLessThan(500);
  expect(changes.lines).toEqual([`+ ${huge.slice(0, 500)}…`]);
  expect(quoted.join("\n").length).toBeLessThanOrEqual(4000 + 200);
});

// Two outputs of 10,000 different lines blocked diffLines for 12.6s.
test("outputs that differ in too many places get a summary instead of a diff, quickly", () => {
  const before = Array.from({ length: 10_000 }, (_, i) => `a${i}`).join("\n");
  const after = Array.from({ length: 10_000 }, (_, i) => `b${i}`).join("\n");
  const started = performance.now();
  const changes = describeOutputChanges(before, after);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(changes.lines).toEqual(["… changed in too many places to list (10000 lines before, 10000 after)"]);
});

// `\s+$` backtracks quadratically on a long run of spaces that does not end
// the text: 256KB of them before an "x" blocked the server for 22s.
test("a long run of spaces before the end is trimmed in linear time everywhere output is shown", () => {
  const spaces = `${" ".repeat(131_072)}x`;
  const started = performance.now();
  expect(normalizeMonitorOutput(spaces)).toBe(" ".repeat(MONITOR_OUTPUT_MAX_CHARS));
  expect(quoteUntrusted(spaces, 4000).join("\n").endsWith("x")).toBe(true);
  expect(tailLines(spaces, 10).endsWith("x")).toBe(true);
  expect(performance.now() - started).toBeLessThan(500);
}, 60_000);
