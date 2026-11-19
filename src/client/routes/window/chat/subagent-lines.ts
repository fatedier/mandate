import { isRecord } from "@shared/guards";
import type { BackgroundTaskDto, BackgroundTaskKind, SubagentType } from "@shared/api-contracts";
import type { CommandOutcome, CommandResultMetadata } from "@shared/command-messages";
import type { SubagentOutcome, SubagentResultMetadata } from "@shared/subagent-messages";
import type { AgentMessage } from "@/store/agent-chat";
import type { ToolCallSpec, ToolResultSpec } from "./tool-run-summary";
import type { TranscriptItem } from "./transcript-rows";
import { groupToolRuns } from "./group-tool-runs";

/** A background task where it started and where its result landed, read
 *  from the conversation's rows. Pure, so which calls and messages become
 *  lines and cards is tested as data. */

const SUBAGENT_TOOL = "subagent";

/** The task a call started: a subagent the server took (its result names
 *  the task, started or queued), or a bash command that went to the
 *  background (run_in_background, or moved at its timeout: its result names
 *  the task, running). One refused, or still on its way, started nothing and
 *  stays a call in its run. */
export function startedTask(
  call: ToolCallSpec,
  result: ToolResultSpec | null | undefined
): { taskId: string; title: string; kind: BackgroundTaskKind; type?: SubagentType } | null {
  if (!result || result.isError) return null;
  const value = result.result;
  if (!isRecord(value) || typeof value.taskId !== "string" || !value.taskId) return null;
  const args = isRecord(call.args) ? call.args : {};
  if (call.toolName === "bash") {
    if (value.status !== "running") return null;
    const description = typeof args.description === "string" ? args.description.trim() : "";
    return { taskId: value.taskId, title: description || (typeof args.command === "string" ? args.command : ""), kind: "command" };
  }
  if (call.toolName !== SUBAGENT_TOOL) return null;
  if (value.status !== "started" && value.status !== "queued") return null;
  return { taskId: value.taskId, title: typeof args.title === "string" ? args.title.trim() : "", kind: "subagent", type: args.type === "page" ? "page" : "general" };
}

/** A background task's line where it started: the call that started it,
 *  and what its call says of it until its task is read. */
export interface StartedTaskLine {
  callId: string;
  taskId: string;
  title: string;
  kind: BackgroundTaskKind;
  type?: SubagentType;
}

/** How a row draws the tasks it started: the commands that have ended folded
 *  into one line once two or more have, the latest to end first (ties: the
 *  later started), and every other task a line of its own, in the order they
 *  were started. One ended alone keeps its own line, and so does one `kept`
 *  (by its call): its steps are open at its line, and folded away the line
 *  would take them from under the reader. */
export function arrangeTaskLines<L extends Pick<StartedTaskLine, "callId" | "taskId" | "kind">>(
  lines: readonly L[],
  tasks: ReadonlyMap<string, Pick<BackgroundTaskDto, "status" | "finishedAt">>,
  kept: ReadonlySet<string> = NO_LINES
): { ended: L[]; single: L[] } {
  const isEnded = (l: L) => {
    const task = tasks.get(l.taskId);
    return l.kind === "command" && !kept.has(l.callId) && task !== undefined && task.status !== "queued" && task.status !== "running";
  };
  const ended = lines.flatMap((l, order) => (isEnded(l) ? [{ l, order, at: Date.parse(tasks.get(l.taskId)!.finishedAt ?? "") }] : []));
  if (ended.length < 2) return { ended: [], single: [...lines] };
  const endedAt = (at: number) => (Number.isNaN(at) ? -Infinity : at);
  ended.sort((a, b) => endedAt(b.at) - endedAt(a.at) || b.order - a.order);
  return { ended: ended.map((e) => e.l), single: lines.filter((l) => !isEnded(l)) };
}

const NO_LINES: ReadonlySet<string> = new Set();

const ENDED_OPEN_PREFIX = "ended:";
const PEEK_OPEN_PREFIX = "peek:";

/** The mark of a task line whose steps are open at it (a box on a desktop,
 *  the sheet on a phone), in the set that holds the opened runs: such a line
 *  is kept out of the fold (arrangeTaskLines). */
export function peekOpenKey(callId: string): string {
  return `${PEEK_OPEN_PREFIX}${callId}`;
}

/** The calls whose lines have their steps open, read from the marks. */
export function peekingCalls(marks: ReadonlySet<string>): ReadonlySet<string> {
  const calls = new Set<string>();
  for (const id of marks) if (id.startsWith(PEEK_OPEN_PREFIX)) calls.add(id.slice(PEEK_OPEN_PREFIX.length));
  return calls;
}

/** The mark of the ended commands' line opened, by one of its commands'
 *  calls, in the set that holds the opened runs. */
export function endedOpenKey(callId: string): string {
  return `${ENDED_OPEN_PREFIX}${callId}`;
}

/** Whether an ended commands' line is open where it is drawn: then it holds
 *  the reader's place, as an open run does, on a phone too (it opens in
 *  place there as well). Read as the list draws it: the loaded rows with
 *  their runs joined, a row's started commands arranged (arrangeTaskLines),
 *  and one of the folded ones carrying its mark. Never from the marks alone:
 *  a mark outlives its fold when the row loses its other ended commands (the
 *  oldest messages leave the cache). */
export function openEndedPausesFollow(
  rows: readonly TranscriptItem[],
  results: ReadonlyMap<string, ToolResultSpec>,
  expandedIds: ReadonlySet<string>,
  tasks: ReadonlyMap<string, Pick<BackgroundTaskDto, "status" | "finishedAt">>,
  endsRun?: (step: AgentMessage) => boolean
): boolean {
  if (![...expandedIds].some((id) => id.startsWith(ENDED_OPEN_PREFIX))) return false;
  // As drawn: a line whose steps are open is kept out of the fold.
  const kept = peekingCalls(expandedIds);
  return groupToolRuns([...rows], endsRun).some((item) => {
    if (item.kind !== "msg") return false;
    const lines = [item.message, ...(item.runTail ?? [])].flatMap((step) =>
      step.content.type === "assistant"
        ? ((step.content.toolCalls ?? []) as ToolCallSpec[]).flatMap((call) => {
          const started = startedTask(call, results.get(call.toolCallId));
          return started ? [{ callId: call.toolCallId, ...started }] : [];
        })
        : []);
    return arrangeTaskLines(lines, tasks, kept).ended.some((l) => expandedIds.has(endedOpenKey(l.callId)));
  });
}

const OUTCOMES: ReadonlySet<string> = new Set<SubagentOutcome>(["finished", "stopped", "failed", "interrupted"]);

/** A result as it landed in its conversation, read from its metadata alone
 *  (what the server recorded for the card: subagentResultMetadata);
 *  null for any other message, or one whose metadata is not a result's. The
 *  message's text is the model's and is never read here. */
export function subagentResultOf(message: AgentMessage): SubagentResultMetadata | null {
  if (message.source !== "subagent-result" || message.content.type !== "text") return null;
  const meta = message.content.metadata;
  if (!isRecord(meta)) return null;
  const { taskId, outcome, title, durationMs, reply, error } = meta;
  if (typeof taskId !== "string" || typeof outcome !== "string" || !OUTCOMES.has(outcome)) return null;
  if (typeof title !== "string" || typeof durationMs !== "number" || !Number.isFinite(durationMs)) return null;
  if (reply !== null && typeof reply !== "string") return null;
  return { taskId, outcome: outcome as SubagentOutcome, title, durationMs, reply, error: typeof error === "string" ? error : null };
}

const COMMAND_OUTCOMES: ReadonlySet<string> = new Set<CommandOutcome>(["exited", "user", "output", "signal", "interrupted"]);

/** A command's result as it landed, read from its metadata alone (what the
 *  server recorded: commandResultMetadata); null for any other message, or
 *  one whose metadata is not a command result's. Its text is the model's. */
export function commandResultOf(message: AgentMessage): CommandResultMetadata | null {
  if (message.source !== "command-result" || message.content.type !== "text") return null;
  const meta = message.content.metadata;
  if (!isRecord(meta)) return null;
  const { taskId, title, outcome, exitCode, signal, durationMs, outputLines } = meta;
  if (typeof taskId !== "string" || typeof title !== "string" || typeof outcome !== "string" || !COMMAND_OUTCOMES.has(outcome)) return null;
  if (exitCode !== null && typeof exitCode !== "number") return null;
  if (signal !== null && typeof signal !== "string") return null;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || typeof outputLines !== "number") return null;
  return { taskId, title, outcome: outcome as CommandOutcome, exitCode, signal, durationMs, outputLines };
}
