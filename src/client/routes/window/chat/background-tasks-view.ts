import type { BackgroundTaskDto, BackgroundTaskKind, BackgroundTaskStatus, SubagentType } from "@shared/api-contracts";
import type { CommandResultMetadata } from "@shared/command-messages";
import { formatCalendarDate, formatClockMinutes } from "@/lib/format";
import type { ThreadState } from "@/store/agent-chat";
import { useBackgroundTasksStore } from "@/store/background-tasks";
import { runningToolCallId } from "./running-call";
import { describeCall, type ToolCallSpec, type ToolRunRow } from "./tool-run-summary";
import { toolResultsOf } from "./transcript-rows";

/** A background task as its line, its steps, the strip and the Background
 *  tasks list say it: one module, so a task reads the same wherever it is
 *  shown. Pure but for the count hook, so the words and the order are tested
 *  as data. */

/** How each kind of task names itself. */
const KIND_LABEL: Record<BackgroundTaskKind, string> = { subagent: "Subagent", command: "Command" };

/** Its kind's name; Your agent's page subagent says it is one. */
export function taskKindLabel(task: Pick<BackgroundTaskDto, "kind"> & { type?: SubagentType }): string {
  return task.kind === "subagent" && task.type === "page" ? "Page subagent" : KIND_LABEL[task.kind];
}

/** It still runs, or waits its turn: it can be stopped. */
export function taskOpen(task: Pick<BackgroundTaskDto, "status">): boolean {
  return task.status === "queued" || task.status === "running";
}

/** How a task stands or ended, in a word; a command that exited, by its
 *  exit code ("Exit 1"), and one killed for its output says so. */
export function taskOutcomeLabel(task: Pick<BackgroundTaskDto, "status"> & Partial<Pick<BackgroundTaskDto, "kind" | "exitCode" | "stoppedBy">>): string {
  if (task.kind === "command") {
    if ((task.status === "finished" || task.status === "failed") && typeof task.exitCode === "number") return `Exit ${task.exitCode}`;
    if (task.status === "stopped" && task.stoppedBy === "output") return OUTPUT_STOP;
  }
  switch (task.status) {
    case "finished": return "Finished";
    case "stopped": return "Stopped";
    case "failed": return "Failed";
    case "interrupted": return "Interrupted";
    case "running": return "Running";
    case "queued": return "Queued";
  }
}

const OUTPUT_STOP = "Stopped · output over 1 GB";

/** A command's result where it landed, in the words its task's row uses. */
export function commandOutcomeLabel(result: Pick<CommandResultMetadata, "outcome" | "exitCode">): string {
  switch (result.outcome) {
    case "exited": return `Exit ${result.exitCode}`;
    case "signal": return "Failed";
    case "user": return "Stopped";
    case "output": return OUTPUT_STOP;
    case "interrupted": return "Interrupted";
  }
}

/** The mark a command's result line wears: as its task ended. */
export function commandOutcomeStatus(result: Pick<CommandResultMetadata, "outcome" | "exitCode">): Exclude<BackgroundTaskStatus, "queued" | "running"> {
  switch (result.outcome) {
    case "exited": return result.exitCode === 0 ? "finished" : "failed";
    case "signal": return "failed";
    case "user":
    case "output": return "stopped";
    case "interrupted": return "interrupted";
  }
}

/** What a folded row of two or more tasks calls them: by their kind when
 *  they share one. */
export function stripGroupLabel(tasks: readonly Pick<BackgroundTaskDto, "kind">[]): string {
  const n = tasks.length;
  if (tasks.every((task) => task.kind === "subagent")) return `${n} subagents`;
  if (tasks.every((task) => task.kind === "command")) return `${n} commands`;
  return `${n} background tasks`;
}

/** How long it has run: up to `now` while it runs, start to end once ended;
 *  null when it never started (queued, or stopped while queued): a queued
 *  task has no clock. */
export function taskRunMs(task: Pick<BackgroundTaskDto, "status" | "startedAt" | "finishedAt">, now: number): number | null {
  const start = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
  if (!Number.isFinite(start)) return null;
  if (task.status === "running") return Math.max(0, now - start);
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Number.NaN;
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export interface TaskSections {
  running: BackgroundTaskDto[];
  queued: BackgroundTaskDto[];
  done: BackgroundTaskDto[];
}

const time = (value: string | null): number => {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
};

/** The three parts the list shows and the strip takes its first two from:
 *  running, the longest at it first (as the strip orders workers); queued,
 *  in the order they will start; done, the latest to end first. Ties keep
 *  the order given, the server's (newest first). */
export function taskSections(tasks: readonly BackgroundTaskDto[]): TaskSections {
  return {
    running: tasks.filter((t) => t.status === "running").sort((a, b) => time(a.startedAt ?? a.createdAt) - time(b.startedAt ?? b.createdAt)),
    queued: tasks.filter((t) => t.status === "queued").sort((a, b) => time(a.createdAt) - time(b.createdAt)),
    done: tasks.filter((t) => t.status !== "running" && t.status !== "queued").sort((a, b) => time(b.finishedAt ?? b.createdAt) - time(a.finishedAt ?? a.createdAt))
  };
}

/** "2 running · 1 queued": each part only when it counts something. Done
 *  ones are not counted: like a conversation's messages, older ones are
 *  there to load, not to number. */
export function taskCountsLine(sections: TaskSections): string {
  return ([[sections.running.length, "running"], [sections.queued.length, "queued"]] as const)
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(" · ");
}

/** When a task ended: the clock on the day it ended ("16:20"), its date on
 *  another day ("Oct 9"), as the chat's waiting lines tell a day apart. */
export function doneTimeLabel(task: Pick<BackgroundTaskDto, "finishedAt" | "createdAt">, now: number): string {
  const at = Date.parse(task.finishedAt ?? task.createdAt);
  if (!Number.isFinite(at)) return "";
  return new Date(at).toDateString() === new Date(now).toDateString() ? formatClockMinutes(at) : formatCalendarDate(at, now);
}

/** Whether a thread has started a background task, as read so far. */
export function useHasBackgroundTasks(threadId: string): boolean {
  return useBackgroundTasksStore((s) => (s.byThread.get(threadId)?.length ?? 0) > 0);
}

/** A subagent's calls as the transcript's tool rows: a call starts at the
 *  completion before it in its step, the first at the step's own message (as
 *  AssistantMessage takes it), and the one its running wake is on runs. */
export function taskStepRows(thread: Pick<ThreadState, "messages" | "wakePhase"> | null): ToolRunRow[] {
  if (!thread) return [];
  const results = toolResultsOf(thread.messages);
  const activeWakeId = thread.wakePhase.phase === "idle" ? null : thread.wakePhase.wakeId;
  const running = runningToolCallId(thread.messages, activeWakeId, (id) => results.has(id));
  const rows: ToolRunRow[] = [];
  for (const step of thread.messages) {
    if (step.role !== "assistant" || step.content.type !== "assistant") continue;
    let nextStartedAt: string | undefined = step.createdAt;
    for (const call of (step.content.toolCalls ?? []) as ToolCallSpec[]) {
      const result = results.get(call.toolCallId) ?? null;
      const startedAt = nextStartedAt;
      nextStartedAt = result?.createdAt;
      rows.push({ call, result, isRunning: running === call.toolCallId && !result, startedAt });
    }
  }
  return rows;
}

/** What a running subagent is doing, in a few words: the call it is on, else
 *  the heading its reasoning has reached, else the call it made last (as a
 *  run's live line names the latest), else Working. */
export function taskStep(rows: readonly ToolRunRow[], heading: string | null): string {
  const current = rows.find((row) => row.isRunning);
  if (current) return phraseText(current);
  if (heading) return heading;
  const last = rows.at(-1);
  return last ? phraseText(last) : "Working";
}

function phraseText(row: ToolRunRow): string {
  const phrase = describeCall(row);
  return [phrase.lead, phrase.detail].filter(Boolean).join(" ");
}
