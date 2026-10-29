import type { AgentMonitorRunDto, AgentPendingMonitorDto } from "@shared/api-contracts";
import type { CauseFacts, CauseRun } from "./chatProvenance";
import { formatDurationShort } from "@shared/duration-short";
import { formatClockMinutes, formatDateTime } from "@/lib/format";
import type { AgentMessage } from "@/store/agent-chat";
import { collectToolNames, type ToolNames } from "./tool-details/names";
import type { ToolCallSpec } from "./tool-run-summary";
import { toolResultsOf } from "./transcript-rows";

/** A wait the chat draws as a waiting line: a pane watch, a command monitor
 *  or an alarm the agent set. A subagent or a background command is waited
 *  on too, but the strip above the composer shows it. */
type LineMonitor = Extract<AgentPendingMonitorDto, { kind: "pane" | "command" | "alarm" }>;

/** One thing the agent is still waiting on, as the chat's waiting line says it. */
export interface WaitingLine {
  id: string;
  kind: LineMonitor["kind"];
  /** "Watching" a pane, "Monitoring" a command: as its transcript row reads
   *  while it waits; an alarm "Wakes at" its time. */
  lead: "Watching" | "Monitoring" | "Wakes at";
  /** What it waits on: the pane as the transcript named it when the watch was
   *  registered, else its id; a command's description, else the command. */
  label: string;
  /** An id or a command, set in mono. */
  mono: boolean;
  /** What wakes the agent, and the deadline; empty for an alarm, whose
   *  label is its time. */
  detail: string;
  /** The detail as a row of the opened list says it: how long a pane must
   *  stay quiet, or how often a command runs, and the deadline. */
  brief: string;
  /** The agent's note: what it will do once woken. */
  note: string;
  /** What orders it among the others: when a watch or a monitor was set,
   *  when an alarm wakes (ms). */
  at: number;
  /** A command monitor's card: how many times it ran, the last and next run,
   *  its recent runs and its command. */
  details?: CauseFacts;
}

export function waitingLines(
  monitors: readonly AgentPendingMonitorDto[],
  names: Pick<ToolNames, "watchPanes">,
  now: number = Date.now()
): WaitingLine[] {
  return monitors.filter((monitor): monitor is LineMonitor => monitor.kind === "pane" || monitor.kind === "command" || monitor.kind === "alarm").map((monitor) => {
    if (monitor.kind === "alarm") {
      return { id: monitor.id, kind: monitor.kind, lead: "Wakes at", label: deadline(monitor.fireAt, now), mono: false, detail: "", brief: "", note: monitor.note, at: Date.parse(monitor.fireAt) };
    }
    const until = `until ${deadline(monitor.timeoutAt, now)}`;
    if (monitor.kind === "pane") {
      // The server's record of the name at registration first: the
      // transcript knows it only when the naming call is loaded.
      const name = monitor.paneName || (names.watchPanes.get(monitor.id) ?? null);
      return {
        id: monitor.id,
        kind: monitor.kind,
        lead: "Watching",
        label: name ?? monitor.paneId,
        mono: name === null,
        detail: `wakes after ${formatDurationShort(monitor.stableMs)} of quiet · ${until}`,
        brief: `${formatDurationShort(monitor.stableMs)} quiet · ${until}`,
        note: monitor.note,
        at: Date.parse(monitor.createdAt)
      };
    }
    const wakes = monitor.wakeWhen === "succeeds" ? "wakes when it succeeds" : "wakes when its output changes";
    const brief = `every ${formatDurationShort(monitor.everyMs)} · ${until}`;
    const rows = monitor.recentRuns.map((run) => cardRun(run, monitor.wakeWhen, now));
    return {
      id: monitor.id,
      kind: monitor.kind,
      lead: "Monitoring",
      label: monitor.description ?? monitor.command,
      mono: monitor.description === null,
      detail: `every ${formatDurationShort(monitor.everyMs)} · ${wakes} · ${until}`,
      brief,
      note: monitor.note,
      at: Date.parse(monitor.createdAt),
      details: {
        meta: [
          monitor.runCount === 0 ? "Not run yet" : `Ran ${monitor.runCount} ${monitor.runCount === 1 ? "time" : "times"}`,
          ...(monitor.lastRunAt ? [`last ${deadline(monitor.lastRunAt, now)}`] : []),
          `next ${deadline(monitor.nextRunAt, now)}`,
          brief
        ],
        note: monitor.note,
        ...(rows.length > 0 ? { runs: { rows, earlier: Math.max(0, monitor.runCount - rows.length) } } : {}),
        blocks: [{ label: "Command", text: monitor.command }]
      }
    };
  });
}

/** Two or more waits as one line: the one it leads with, how many wait
 *  beside it, and when the next alarm wakes the agent if the lead is not
 *  that alarm. Opened, a row each in `rows`: panes, then commands, each the
 *  latest set first (what the agent turned to last), then alarms by when
 *  they wake. The lead is the first row. Null without a wait. */
export function foldWaitingLines(lines: readonly WaitingLine[]): {
  lead: WaitingLine;
  more: number;
  nextWake: string | null;
  rows: WaitingLine[];
} | null {
  const latest = (kind: "pane" | "command") => lines.filter((line) => line.kind === kind).sort((a, b) => b.at - a.at);
  const alarms = lines.filter((line) => line.kind === "alarm").sort((a, b) => a.at - b.at);
  const rows = [...latest("pane"), ...latest("command"), ...alarms];
  const lead = rows[0];
  if (!lead) return null;
  return { lead, more: rows.length - 1, nextWake: lead.kind !== "alarm" && alarms[0] ? alarms[0].label : null, rows };
}

/** How a run ended, as its card's row says it: what the monitor waits for
 *  reads ok, nothing new muted, the rest as not yet or broken. */
function cardRun(run: AgentMonitorRunDto, wakeWhen: "changed" | "succeeds", now: number): CauseRun {
  const at = deadline(run.at, now);
  const row = (outcome: string, tone: CauseRun["tone"]): CauseRun => ({ at, outcome, tone, line: run.line });
  if (run.timedOut) return row("timed out", "fail");
  if (run.exitCode === null || run.exitCode < 0) return row("could not run", "fail");
  if (wakeWhen === "changed" && run.exitCode === 0) return run.changed ? row("changed", "ok") : row("no change", "same");
  return row(`exit ${run.exitCode}`, run.exitCode === 0 ? "ok" : "fail");
}

/** The clock today ("13:21"); on another day, with its date ("Oct 9 · 14:00"). */
function deadline(timeoutAt: string, now: number): string {
  const at = Date.parse(timeoutAt);
  return new Date(at).toDateString() === new Date(now).toDateString() ? formatClockMinutes(at) : formatDateTime(at, now);
}

/** A thread's waiting lines from its loaded messages, for a view outside its
 *  transcript (the worker page's header). */
export function threadWaitingLines(
  thread: { messages: readonly AgentMessage[]; monitors: readonly AgentPendingMonitorDto[] },
  now: number = Date.now()
): WaitingLine[] {
  if (thread.monitors.length === 0) return [];
  const calls = thread.messages.flatMap((m) => (m.content.type === "assistant" ? (m.content.toolCalls ?? []) as ToolCallSpec[] : []));
  return waitingLines(thread.monitors, collectToolNames(calls, toolResultsOf(thread.messages)), now);
}
