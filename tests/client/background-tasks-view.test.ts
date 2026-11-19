import { expect, test } from "bun:test";
import type { BackgroundTaskDto } from "@shared/api-contracts";
import { formatCalendarDate, formatClockMinutes } from "@/lib/format";
import {
  commandOutcomeLabel, commandOutcomeStatus, doneTimeLabel, stripGroupLabel, taskCountsLine, taskKindLabel, taskOpen, taskOutcomeLabel, taskRunMs, taskSections
} from "@/routes/window/chat/background-tasks-view";
import { backgroundTask } from "../helpers/subagent-client.js";

// The words and the order the line, the list and the strip share: one
// module, so a task reads the same wherever it is shown.

const at = (minute: number) => `2026-10-18T09:${String(minute).padStart(2, "0")}:00.000Z`;
const task = (id: string, over: Partial<BackgroundTaskDto>) => backgroundTask({ id, title: id, ...over });

test("a task's kind, whether it can be stopped, and how it stands or ended", () => {
  expect(taskKindLabel({ kind: "subagent" })).toBe("Subagent");
  // A page subagent says so wherever a task is named; a general one is a Subagent.
  expect(taskKindLabel({ kind: "subagent", type: "page" })).toBe("Page subagent");
  expect(taskKindLabel({ kind: "subagent", type: "general" })).toBe("Subagent");
  expect(taskKindLabel(task("t_page", { type: "page" }))).toBe("Page subagent");
  expect((["queued", "running", "finished", "stopped", "failed", "interrupted"] as const).map((status) => [status, taskOpen({ status })]))
    .toEqual([["queued", true], ["running", true], ["finished", false], ["stopped", false], ["failed", false], ["interrupted", false]]);
  expect((["finished", "stopped", "failed", "interrupted", "queued", "running"] as const).map((status) => taskOutcomeLabel({ status })))
    .toEqual(["Finished", "Stopped", "Failed", "Interrupted", "Queued", "Running"]);
});

test("how long a task has run: up to now while it runs, start to end once ended; none for one that never started", () => {
  const now = Date.parse(at(10));
  expect(taskRunMs({ status: "running", startedAt: at(8), finishedAt: null }, now)).toBe(120_000);
  expect(taskRunMs({ status: "finished", startedAt: at(1), finishedAt: at(5) }, now)).toBe(240_000);
  // A queued one has no clock: it has not started.
  expect(taskRunMs({ status: "queued", startedAt: null, finishedAt: null }, now)).toBeNull();
  // Stopped while it waited: it never ran.
  expect(taskRunMs({ status: "stopped", startedAt: null, finishedAt: at(4) }, now)).toBeNull();
});

test("the list's order: running the longest at it first, queued in the order they start, done the latest to end first; the counts say only what runs and waits", () => {
  // As the server lists them: newest first.
  const tasks = [
    task("q2", { status: "queued", startedAt: null, createdAt: at(9) }),
    task("q1", { status: "queued", startedAt: null, createdAt: at(8) }),
    task("r2", { status: "running", createdAt: at(7), startedAt: at(7) }),
    task("d2", { status: "stopped", startedAt: at(2), finishedAt: at(6) }),
    task("r1", { status: "running", createdAt: at(1), startedAt: at(1) }),
    task("d1", { status: "finished", startedAt: at(1), finishedAt: at(3) })
  ];
  const sections = taskSections(tasks);
  expect([sections.running, sections.queued, sections.done].map((part) => part.map((t) => t.id))).toEqual([["r1", "r2"], ["q1", "q2"], ["d2", "d1"]]);
  expect(taskCountsLine(sections)).toBe("2 running · 2 queued");
  expect(taskCountsLine(taskSections([tasks[2]!]))).toBe("1 running");
  // Done ones are not counted: older ones are there to load, not to number.
  expect(taskCountsLine(taskSections([tasks[3]!]))).toBe("");
});

test("when a task ended: the clock on its day, its date on another", () => {
  const now = Date.parse(at(10));
  expect(doneTimeLabel({ finishedAt: at(5), createdAt: at(1) }, now)).toBe(formatClockMinutes(at(5)));
  const earlier = "2026-10-15T09:05:00.000Z";
  expect(doneTimeLabel({ finishedAt: earlier, createdAt: earlier }, now)).toBe(formatCalendarDate(earlier, now));
});

test("a command names itself Command and says how it exited", () => {
  const cmd = (over: Partial<BackgroundTaskDto>) => backgroundTask({ kind: "command", childThreadId: null, command: "make e2e", outputPath: "/out/x.log", ...over });
  expect(taskKindLabel(cmd({}))).toBe("Command");
  expect(taskOutcomeLabel(cmd({ status: "finished", exitCode: 0 }))).toBe("Exit 0");
  expect(taskOutcomeLabel(cmd({ status: "failed", exitCode: 1 }))).toBe("Exit 1");
  expect(taskOutcomeLabel(cmd({ status: "failed", exitCode: null }))).toBe("Failed");
  expect(taskOutcomeLabel(cmd({ status: "stopped", stoppedBy: "output" }))).toBe("Stopped · output over 1 GB");
  expect(taskOutcomeLabel(cmd({ status: "stopped", stoppedBy: "user" }))).toBe("Stopped");
  expect(taskOutcomeLabel(cmd({ status: "interrupted" }))).toBe("Interrupted");
  // A subagent's words are as they were.
  expect(taskOutcomeLabel(backgroundTask({ status: "finished" }))).toBe("Finished");
  expect(stripGroupLabel([cmd({}), cmd({ id: "b" })])).toBe("2 commands");
  expect(stripGroupLabel([cmd({}), backgroundTask({ id: "s" })])).toBe("2 background tasks");
  expect(stripGroupLabel([backgroundTask({ id: "s1" }), backgroundTask({ id: "s2" })])).toBe("2 subagents");
});

test("a command's result says how it ended in the list's words, with the mark of its kind of end", () => {
  const meta = (outcome: "exited" | "user" | "output" | "signal" | "interrupted", exitCode: number | null = null) =>
    ({ taskId: "t", title: "Lint", outcome, exitCode, signal: outcome === "signal" ? "SIGSEGV" : null, durationMs: 189_000, outputLines: 3 });
  expect([meta("exited", 0), meta("exited", 1), meta("signal"), meta("user"), meta("output"), meta("interrupted")].map((m) => [commandOutcomeLabel(m), commandOutcomeStatus(m)])).toEqual([
    ["Exit 0", "finished"], ["Exit 1", "failed"], ["Failed", "failed"], ["Stopped", "stopped"], ["Stopped · output over 1 GB", "stopped"], ["Interrupted", "interrupted"]
  ]);
});
