import { expect, test } from "bun:test";
import { commandResultOf, startedTask } from "@/routes/window/chat/subagent-lines";
import { agentMessage } from "../helpers/typed.js";

// Which calls become a background task's line, and which messages a
// command's result line: read from the rows alone.

const bash = (args: Record<string, unknown>) => ({ toolCallId: "c1", toolName: "bash", args });

test("a bash call that went to the background starts a command's line, named by its description, else its command", () => {
  const running = { result: { taskId: "task_bg", status: "running", outputPath: "/out/task_bg.log", message: "Running in the background as task_bg…" } };
  expect(startedTask(bash({ command: "make e2e", description: " Run the e2e suite ", run_in_background: true }), running)).toEqual({ taskId: "task_bg", title: "Run the e2e suite", kind: "command" });
  // Moved at its timeout: no run_in_background in its arguments.
  const moved = { result: { taskId: "task_mv", status: "running", outputPath: "/out/task_mv.log", movedAfterMs: 60_000, outputSoFar: "early", message: "Still running…" } };
  expect(startedTask(bash({ command: "make e2e" }), moved)).toEqual({ taskId: "task_mv", title: "make e2e", kind: "command" });
  // A foreground call's transcript, an error, or no answer yet: no line.
  expect(startedTask(bash({ command: "ls" }), { result: "stdout:\nfile\nexitCode: 0" })).toBeNull();
  expect(startedTask(bash({ command: "make e2e", run_in_background: true }), { isError: true, error: "20 background commands of this conversation are running" })).toBeNull();
  expect(startedTask(bash({ command: "make e2e", run_in_background: true }), null)).toBeNull();
});

test("a subagent's call starts its line as before", () => {
  const call = { toolCallId: "c2", toolName: "subagent", args: { title: " 0.72 release notes ", task: "x" } };
  expect(startedTask(call, { result: { taskId: "task_1", status: "started", message: "…" } })).toEqual({ taskId: "task_1", title: "0.72 release notes", kind: "subagent", type: "general" });
  expect(startedTask(call, { result: { taskId: "task_1", status: "running" } })).toBeNull();
  // Your agent's page subagent: its call says so, and so does its line before its task is read.
  const page = { ...call, args: { ...call.args, type: "page" } };
  expect(startedTask(page, { result: { taskId: "task_2", status: "queued", message: "…" } })).toEqual({ taskId: "task_2", title: "0.72 release notes", kind: "subagent", type: "page" });
});

test("a command's result is read from its metadata alone; any other message, or a malformed one, is none", () => {
  const message = (metadata: unknown, source = "command-result") => agentMessage({
    id: "m1", threadId: "thr_m", seq: 3, role: "user", source: source as "command-result", createdAt: "2026-10-19T09:00:00.000Z",
    content: { type: "text", text: "[Background command] …", metadata: metadata as Record<string, unknown> }
  });
  const meta = { taskId: "task_1", title: "Lint the whole tree", outcome: "exited" as const, exitCode: 1, signal: null, durationMs: 189_000, outputLines: 412 };
  expect(commandResultOf(message(meta))).toEqual(meta);
  expect(commandResultOf(message(meta, "subagent-result"))).toBeNull();
  expect(commandResultOf(message({ ...meta, outcome: "exploded" }))).toBeNull();
  expect(commandResultOf(message({ ...meta, exitCode: "1" }))).toBeNull();
  expect(commandResultOf(message({ ...meta, durationMs: undefined }))).toBeNull();
});
