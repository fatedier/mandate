import { expect, test } from "bun:test";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { endedCommandsLabel } from "@/routes/window/chat/background-tasks-view";
import { arrangeTaskLines, endedOpenKey, openEndedPausesFollow, peekOpenKey, type StartedTaskLine } from "@/routes/window/chat/subagent-lines";
import type { TranscriptItem } from "@/routes/window/chat/transcript-rows";
import { agentMessage } from "../helpers/typed.js";
import { backgroundTask } from "../helpers/subagent-client.js";

// The commands a row started that have ended read as one line once two or
// more have: what they were, latest first, and how many failed, were stopped
// or were cut short. Everything else a row started keeps its own line.

const line = (n: number, kind: StartedTaskLine["kind"] = "command"): StartedTaskLine => ({ callId: `c${n}`, taskId: `task_${n}`, title: `Job ${n}`, kind });
const ended = (n: number, over: Partial<BackgroundTaskDto>): BackgroundTaskDto =>
  backgroundTask({ id: `task_${n}`, kind: "command", childThreadId: null, title: `Job ${n}`, status: "finished", exitCode: 0, ...over });
const held = (...tasks: BackgroundTaskDto[]) => new Map(tasks.map((task) => [task.id, task]));
const ids = (lines: readonly StartedTaskLine[]) => lines.map((l) => l.taskId);

test("two or more ended commands fold into one, the latest to end first; the rest stay lines of their own, in the order they started", () => {
  const lines = [line(1), line(2, "subagent"), line(3), line(4), line(5), line(6)];
  const tasks = held(
    ended(1, { finishedAt: "2026-10-18T09:00:10.000Z" }),
    backgroundTask({ id: "task_2", status: "finished", finishedAt: "2026-10-18T09:00:50.000Z" }),
    ended(3, { finishedAt: "2026-10-18T09:00:40.000Z", status: "failed", exitCode: 1 }),
    ended(4, { status: "running", finishedAt: null, exitCode: null }),
    ended(5, { finishedAt: "2026-10-18T09:00:20.000Z", status: "stopped", stoppedBy: "user", exitCode: null })
    // task_6 not read yet.
  );
  const arranged = arrangeTaskLines(lines, tasks);
  expect(ids(arranged.ended)).toEqual(["task_3", "task_5", "task_1"]);
  // An ended subagent, a running command, one not read: each its own line.
  expect(ids(arranged.single)).toEqual(["task_2", "task_4", "task_6"]);
});

test("a command whose steps are open where its line is stays that line, ended or not: it is not folded away under the reader", () => {
  const lines = [line(1), line(2), line(3)];
  const tasks = held(ended(1, { finishedAt: "2026-10-18T09:00:10.000Z" }), ended(2, { finishedAt: "2026-10-18T09:00:20.000Z" }), ended(3, { finishedAt: "2026-10-18T09:00:30.000Z" }));
  expect(ids(arrangeTaskLines(lines, tasks, new Set(["c2"])).ended)).toEqual(["task_3", "task_1"]);
  expect(ids(arrangeTaskLines(lines, tasks, new Set(["c2"])).single)).toEqual(["task_2"]);
  // Kept out, it leaves one ended: no fold.
  expect(arrangeTaskLines(lines.slice(0, 2), tasks, new Set(["c2"]))).toEqual({ ended: [], single: lines.slice(0, 2) });
});

test("ending at the same moment, or with no time, the later started comes first", () => {
  const at = "2026-10-18T09:00:10.000Z";
  const arranged = arrangeTaskLines([line(1), line(2), line(3)], held(ended(1, { finishedAt: at }), ended(2, { finishedAt: at }), ended(3, { finishedAt: null })));
  expect(ids(arranged.ended)).toEqual(["task_2", "task_1", "task_3"]);
});

test("the folded line counts them, then names only the endings that happened: failed, stopped (cut off for its output too), interrupted", () => {
  const finished = (n: number) => ended(n, {});
  expect(endedCommandsLabel([finished(1), finished(2), finished(3), finished(4), finished(5)])).toEqual({ head: "5 commands ended", clauses: [] });
  const all = [
    finished(1),
    ended(2, { status: "failed", exitCode: 1 }),
    ended(3, { status: "failed", exitCode: null }),
    ended(4, { status: "stopped", stoppedBy: "user", exitCode: null }),
    ended(5, { status: "stopped", stoppedBy: "output", exitCode: null }),
    ended(6, { status: "interrupted", exitCode: null })
  ];
  expect(endedCommandsLabel(all)).toEqual({
    head: "6 commands ended",
    clauses: [{ text: "2 failed", failed: true }, { text: "2 stopped", failed: false }, { text: "1 interrupted", failed: false }]
  });
  expect(endedCommandsLabel([finished(1), ended(2, { status: "interrupted" })]).clauses).toEqual([{ text: "1 interrupted", failed: false }]);
});

const startCall = (n: number) => ({ toolCallId: `c${n}`, toolName: "bash", args: { command: `job-${n}`, run_in_background: true } });
const step = (id: string, calls: Array<{ toolCallId: string; toolName: string; args: unknown }>, text = "") => agentMessage({
  id, threadId: "thr_m", role: "assistant", source: "self", wakeId: "w1", createdAt: "2026-10-18T09:00:00.000Z",
  content: { type: "assistant", text, toolCalls: calls }
});
const startResults = new Map<string, { result: unknown }>([
  ["c1", { result: { taskId: "task_1", status: "running" } }],
  ["c2", { result: { taskId: "task_2", status: "running" } }],
  ["c3", { result: { taskId: "task_3", status: "running" } }],
  ["c-ls", { result: "stdout:\nok\nexitCode: 0" }]
]);
const twoEnded = held(ended(1, { finishedAt: "2026-10-18T09:00:10.000Z" }), ended(2, { finishedAt: "2026-10-18T09:00:20.000Z" }));
const msgRows = (...messages: ReturnType<typeof step>[]): TranscriptItem[] => messages.map((message) => ({ kind: "msg", message }));

test("an open fold holds the reader's place while it is drawn: two or more ended commands in one row, one of them carrying its mark", () => {
  // One run over two steps: the steps fold into one row, as the list draws it.
  const rows = msgRows(step("a1", [startCall(1)]), step("a2", [startCall(2), { toolCallId: "c-ls", toolName: "bash", args: { command: "ls" } }]));
  expect(openEndedPausesFollow(rows, startResults, new Set([endedOpenKey("c2")]), twoEnded)).toBe(true);
  expect(openEndedPausesFollow(rows, startResults, new Set(), twoEnded)).toBe(false);
  // A mark whose call is not loaded, or did not start a command, holds nothing; nor another fold's mark.
  expect(openEndedPausesFollow(rows, startResults, new Set([endedOpenKey("c9")]), twoEnded)).toBe(false);
  expect(openEndedPausesFollow(rows, startResults, new Set([endedOpenKey("c-ls")]), twoEnded)).toBe(false);
  expect(openEndedPausesFollow(rows, startResults, new Set(["c1"]), twoEnded)).toBe(false);
});

test("a mark whose fold is no longer drawn holds nothing: its row lost the other ended command, or only one has ended", () => {
  const open = new Set([endedOpenKey("c2")]);
  // The oldest messages left the cache: the row keeps only the marked command.
  expect(openEndedPausesFollow(msgRows(step("a2", [startCall(2)])), startResults, open, twoEnded)).toBe(false);
  // Words between the steps: two rows, one ended command each.
  expect(openEndedPausesFollow(msgRows(step("a1", [startCall(1)]), step("a2", [startCall(2)], "Started the second.")), startResults, open, twoEnded)).toBe(false);
  // One row, but only one of its commands has ended.
  const oneEnded = held(ended(2, { finishedAt: "2026-10-18T09:00:20.000Z" }), ended(3, { status: "running", finishedAt: null }));
  expect(openEndedPausesFollow(msgRows(step("a2", [startCall(2), startCall(3)])), startResults, open, oneEnded)).toBe(false);
});

test("the pause splits runs where the list does: a step that sent a card ends its run", () => {
  const open = new Set([endedOpenKey("c2")]);
  const rows = msgRows(step("a1", [startCall(1)]), step("a2", [startCall(2)]));
  expect(openEndedPausesFollow(rows, startResults, open, twoEnded)).toBe(true);
  // a1 sent a card: a2 is a row of its own, with one ended command, no fold.
  expect(openEndedPausesFollow(rows, startResults, open, twoEnded, (m) => m.id === "a1")).toBe(false);
});

test("a command whose steps are open is kept out of the fold for the pause as for the drawing", () => {
  // The fold lost its other commands (the cache trimmed them) but kept its
  // mark; the reader opened the remaining command's steps; another ended.
  const rows = msgRows(step("a2", [startCall(2), startCall(3)]));
  const ended23 = held(ended(2, { finishedAt: "2026-10-18T09:00:20.000Z" }), ended(3, { finishedAt: "2026-10-18T09:00:30.000Z" }));
  expect(openEndedPausesFollow(rows, startResults, new Set([endedOpenKey("c2")]), ended23)).toBe(true);
  // c2 kept as its own line: one ended command left to fold, no fold drawn, nothing to hold.
  expect(openEndedPausesFollow(rows, startResults, new Set([endedOpenKey("c2"), peekOpenKey("c2")]), ended23)).toBe(false);
});
