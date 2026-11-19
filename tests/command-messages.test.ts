import { expect, test } from "bun:test";
import { COMMAND_LIMIT_REACHED, formatCommandResultText } from "../src/shared/command-messages.js";

// What the conversation reads when its background command ends.

const base = { title: "Lint the whole tree", durationMs: 189_000, tail: "3 issues found", shownLines: 1, totalLines: 412, outputPath: "/out/task_1.log", signal: null };

test("the result text says how it ended, the end of its output and where the whole is", () => {
  expect(formatCommandResultText({ ...base, outcome: "exited", exitCode: 1 })).toBe(
    "[Background command] “Lint the whole tree”: exited 1 after 3m 09s.\n\nLast 1 of 412 lines (the whole output is in /out/task_1.log):\n3 issues found");
  expect(formatCommandResultText({ ...base, outcome: "user", exitCode: null }).split("\n")[0]).toBe("[Background command] “Lint the whole tree”: stopped by the user after 3m 09s.");
  expect(formatCommandResultText({ ...base, outcome: "output", exitCode: null }).split("\n")[0]).toBe("[Background command] “Lint the whole tree”: stopped after 3m 09s: its output passed 1 GB.");
  expect(formatCommandResultText({ ...base, outcome: "signal", exitCode: null, signal: "SIGSEGV" }).split("\n")[0]).toBe("[Background command] “Lint the whole tree”: ended on SIGSEGV after 3m 09s.");
  expect(formatCommandResultText({ ...base, outcome: "interrupted", exitCode: null }).split("\n")[0]).toBe("[Background command] “Lint the whole tree”: was stopped when Mandate restarted, after 3m 09s. Run it again if you still need it.");
  expect(formatCommandResultText({ ...base, outcome: "exited", exitCode: 0, shownLines: 412, totalLines: 412 }).split("\n")[2]).toBe("Its 412 lines (the whole output is in /out/task_1.log):");
  expect(formatCommandResultText({ ...base, outcome: "exited", exitCode: 0, tail: "", shownLines: 0, totalLines: 0 })).toBe("[Background command] “Lint the whole tree”: exited 0 after 3m 09s.\n\nIt printed nothing.");
  expect(COMMAND_LIMIT_REACHED).toBe("20 background commands of this conversation are running: stop one (stop_task) or wait for one to end.");
});
