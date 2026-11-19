import { diffLines } from "diff";
import { stripAnsi, tailLines } from "../../platform/text/text.js";

/** What a command monitor keeps of an output to compare the next run against. */
export const MONITOR_OUTPUT_MAX_CHARS = 65_536;
const CHANGE_LINES_MAX = 40;
const CHANGE_CHARS_MAX = 2000;
const QUOTED_LINES_MAX = 400;
/** A changed line is cut to this. */
const CHANGE_LINE_MAX_CHARS = 500;
/** Diffing gives up past this edit distance (in lines) or time: two outputs of
 *  10,000 different lines blocked diffLines for 12.6s. */
const DIFF_MAX_EDIT_LENGTH = 1000;
const DIFF_TIMEOUT_MS = 200;

/** Exact comparison, after only what a terminal adds: colour codes, carriage
 *  returns, trailing spaces, trailing blank lines. Nothing else is guessed at:
 *  what an output means is the agent's to make stable. Capped,
 *  keeping the head. Shown as printed, like bash's output: the agent wrote the
 *  command and can run it with bash, so hiding parts of it here protects
 *  nothing. */
export function normalizeMonitorOutput(stdout: string): string {
  const lines = stripAnsi(stdout).replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n").slice(0, MONITOR_OUTPUT_MAX_CHARS);
}

/** The lines added and removed between two normalised outputs, capped for a
 *  wake message. */
export function describeOutputChanges(previous: string, next: string): { added: number; removed: number; lines: string[] } {
  let added = 0;
  let removed = 0;
  const changed: string[] = [];
  const parts = diffLines(previous ? `${previous}\n` : "", next ? `${next}\n` : "", { maxEditLength: DIFF_MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS });
  if (!parts) {
    const before = countLines(previous);
    const after = countLines(next);
    return { added: after, removed: before, lines: [`… changed in too many places to list (${before} lines before, ${after} after)`] };
  }
  for (const part of parts) {
    if (!part.added && !part.removed) continue;
    const partLines = part.value.replace(/\n$/, "").split("\n");
    if (part.added) added += partLines.length;
    else removed += partLines.length;
    for (const line of partLines) {
      changed.push(`${part.added ? "+" : "-"} ${line.length > CHANGE_LINE_MAX_CHARS ? `${line.slice(0, CHANGE_LINE_MAX_CHARS)}…` : line}`);
    }
  }
  const lines: string[] = [];
  let chars = 0;
  for (const line of changed) {
    if (lines.length >= CHANGE_LINES_MAX || chars + line.length > CHANGE_CHARS_MAX) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const left = changed.length - lines.length;
  if (left > 0) lines.push(`… ${left} more changed lines`);
  return { added, removed, lines };
}

/** Text from outside (a command's output) as quoted lines, its tail kept
 *  within maxChars: marked line by line so it reads as data, not instructions. */
export function quoteUntrusted(text: string, maxChars: number): string[] {
  let tail = tailLines(stripAnsi(text).replace(/\r\n?/g, "\n"), QUOTED_LINES_MAX);
  if (tail.length > maxChars) tail = `[truncated ${tail.length - maxChars} leading chars]\n${tail.slice(-maxChars)}`;
  const body = tail.trim() ? tail : "(empty)";
  return body.split("\n").map((line) => `| ${line}`);
}

function countLines(text: string): number {
  return text ? text.split("\n").length : 0;
}
