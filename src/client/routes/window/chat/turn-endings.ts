import type { AgentWakeReason } from "@shared/api-contracts";
import { drawnAsHandoffCard, handoffsCalledBy, type HandoffRef } from "@/routes/global/handoff-tools";
import type { AgentMessage } from "@/store/agent-chat";
import { askedBy } from "./ask-lines";
import { turnIsWhole } from "./row-actions";
import type { ToolResultSpec } from "./tool-run-summary";
import { rendersNothing, type TranscriptItem, type TranscriptRow } from "./transcript-rows";

/** How a finished turn that wrote no reply ends on the page.
 *
 *  A turn can end without a word: the agent tidied up and had nothing to add.
 *  Its last row was then a folded run of tool calls, which is also what a turn
 *  still at work looks like, and nothing said it was over.
 *
 *  `settled`: the turn closed its follow-up of the thread's workers, and the
 *  sentence it gave for that is its last line. The agent writes that sentence
 *  for a reader; folded into the run it took two clicks to find.
 *  `silent`: no such sentence, so the page says only that the turn finished.
 *  `interrupted`: a person stopped the turn, so it did not finish: the page
 *  says that instead, and a sentence the turn had closed with stays a call in
 *  its run.
 *
 *  In each `at` is the time of the last thing the turn did. */
export type TurnEnding =
  | { kind: "settled"; at: string; reason: string; callId: string }
  | { kind: "silent"; at: string }
  | { kind: "interrupted"; at: string };

export interface TurnEndingFacts {
  /** Every loaded row, drawn or still above the render window. */
  loaded: readonly TranscriptItem[];
  /** How far back the loaded messages reach, while older ones remain; null
   *  once everything is loaded. */
  loadedFrom: string | null;
  /** When each turn began, for the turns that say. */
  turnStarts: ReadonlyMap<string, string>;
  /** The turns that have not ended: the one under way, and one still writing
   *  (after a reconnect the stream can be back before the phase is). */
  liveWakeIds: ReadonlySet<string>;
  /** The turns a person stopped. */
  interruptedWakeIds: ReadonlySet<string>;
  /** Each tool call's result, by its call's id. */
  results: ReadonlyMap<string, ToolResultSpec>;
  /** Whether a row draws a run or a card: a line that says a turn finished
   *  needs something of the turn's above it (rowDrawsWork). */
  draws(row: TranscriptRow): boolean;
  /** What woke a message's turn, when the page knows. */
  reasonOf(message: AgentMessage): AgentWakeReason | null;
}

/** The call by which an agent says it checked its thread's workers and found
 *  nothing outstanding; its `reason` is the sentence shown. */
const CLOSING_TOOL = "end_sweep";

function stepsOf(row: TranscriptRow) {
  return row.kind === "msg" ? [row.message, ...(row.runTail ?? [])] : [];
}

/** Whether a reply row draws a run or a card. A call that became a card, or
 *  confirmed one, leaves its run, and a row of only such calls draws nothing:
 *  `placed` is the cards this row draws when its turn's were moved to it. */
export function rowDrawsWork(row: TranscriptRow, results: ReadonlyMap<string, ToolResultSpec>, placed: readonly HandoffRef[] | undefined): boolean {
  const steps = stepsOf(row);
  const called = handoffsCalledBy(steps, results);
  if ((placed ?? called).length > 0) return true;
  const cardIds = new Set(called.map((h) => h.id));
  return steps.some((step) =>
    step.content.type === "assistant" &&
    (step.content.toolCalls ?? []).some((call) => !drawnAsHandoffCard(call, results.get(call.toolCallId), cardIds)));
}

/** The ending of each turn that said nothing, by the row it is drawn under.
 *  Pure, so which turns get one is tested as data.
 *
 *  None for a turn that has not ended, for one that said anything (its reply
 *  is its end, and has its own line; a question it asked the user is as much
 *  said as a reply), or for one that stopped on a failure
 *  (its failure row says how it ended). None either for a turn whose start
 *  may not be loaded: what it said may be above.
 *
 *  The closing sentence counts when its call is in the turn's last row: there
 *  the call leaves the run and the sentence is drawn in its place. Given
 *  earlier, before a message landed and the turn went on to other work, it is
 *  not the turn's conclusion, and moving it down would leave its row empty: the
 *  call stays in its run and the turn is `silent`. A silent turn's line goes
 *  under the last row of its that draws something; a turn that drew nothing
 *  has none. So it is for a turn a person stopped, whatever it closed with. */
export function turnEndings(rows: readonly TranscriptRow[], facts: TurnEndingFacts): Map<TranscriptRow, TurnEnding> {
  const spoke = new Set<string>();
  const failed = new Set<string>();
  const endedAt = new Map<string, string>();
  const closing = new Map<string, { reason: string; callId: string }>();
  const lasted = (wakeId: string, at: string | undefined) => {
    if (!at) return;
    const last = endedAt.get(wakeId);
    if (last === undefined || Date.parse(at) > Date.parse(last)) endedAt.set(wakeId, at);
  };
  for (const item of facts.loaded) {
    if (item.kind !== "msg") continue;
    const message = item.message;
    const wakeId = message.wakeId;
    if (!wakeId) continue;
    lasted(wakeId, message.createdAt);
    if (message.content.type === "wake_failure") failed.add(wakeId);
    if (message.role !== "assistant" || message.content.type !== "assistant") continue;
    if (message.content.text?.trim()) spoke.add(wakeId);
    for (const call of message.content.toolCalls ?? []) {
      const answer = facts.results.get(call.toolCallId);
      // The rows hold no tool messages: a call's answer is the turn's too,
      // and the last thing of a turn stopped before its next step.
      lasted(wakeId, answer?.createdAt);
      if (askedBy(call, answer)) spoke.add(wakeId);
      if (call.toolName !== CLOSING_TOOL) continue;
      const reason = (call.args as { reason?: unknown } | undefined)?.reason;
      if (!answer || answer.isError || typeof reason !== "string" || !reason.trim()) continue;
      closing.set(wakeId, { reason: reason.trim(), callId: call.toolCallId });
    }
  }

  const lastRow = new Map<string, TranscriptRow>();
  const lastDrawing = new Map<string, TranscriptRow>();
  for (const row of rows) {
    if (row.kind !== "msg" || row.message.role !== "assistant" || !row.message.wakeId || rendersNothing(row)) continue;
    lastRow.set(row.message.wakeId, row);
    if (facts.draws(row)) lastDrawing.set(row.message.wakeId, row);
  }

  const endings = new Map<TranscriptRow, TurnEnding>();
  for (const [wakeId, row] of lastRow) {
    if (facts.liveWakeIds.has(wakeId) || spoke.has(wakeId) || failed.has(wakeId)) continue;
    if (!turnIsWhole(wakeId, facts.loadedFrom, facts.turnStarts)) continue;
    const at = endedAt.get(wakeId) ?? (row.kind === "msg" ? row.message.createdAt : "");
    const interrupted = facts.interruptedWakeIds.has(wakeId);
    const closed = closing.get(wakeId);
    const inLastRow = closed !== undefined && stepsOf(row).some((step) =>
      step.content.type === "assistant" && (step.content.toolCalls ?? []).some((call) => call.toolCallId === closed.callId));
    if (closed && inLastRow && !interrupted) {
      endings.set(row, { kind: "settled", at, ...closed });
      continue;
    }
    const drawing = lastDrawing.get(wakeId);
    if (drawing) endings.set(drawing, { kind: interrupted ? "interrupted" : "silent", at });
  }

  // A turn that drew nothing at all, woken by a worker's message: the manager
  // read it and had nothing to add. Its line goes under that message, the row
  // just before the turn with nothing drawn between; without it the page
  // shows no sign the message was read. A worker's message that came while
  // the turn ran was read too, so the line goes under the last of them. Only a
  // turn woken by mail: a message just before a heartbeat did not wake it (a
  // note the user wrote to a worker directly wakes nobody).

  // Whether a turn drew anything is judged over every loaded row: the list
  // draws the last ones first, and a turn's work above them counts the same.
  // Its own replies and runs only: a resumed turn opens with a recovery line
  // that carries its id and is none of its work.
  const drew = new Set<string>();
  for (const item of facts.loaded) {
    if (item.kind === "msg" && item.message.role === "assistant" && item.message.wakeId && !rendersNothing(item)) drew.add(item.message.wakeId);
  }
  const readLast = new Map<string, TranscriptRow>();
  let reply: TranscriptRow | null = null;
  for (const row of rows) {
    const wakeId = row.kind === "msg" ? row.message.wakeId : null;
    if (row.kind === "msg" && rendersNothing(row)) {
      if (!wakeId) continue;
      if (reply && facts.reasonOf(row.message) === "user") readLast.set(wakeId, reply);
      // The message is this turn's, whether or not it gets a line.
      reply = null;
      continue;
    }
    reply = row.kind === "msg" && row.message.role === "user" && row.message.source === "feature-message" ? row : null;
  }
  for (const [wakeId, row] of readLast) {
    if (drew.has(wakeId) || facts.liveWakeIds.has(wakeId) || failed.has(wakeId)) continue;
    if (!turnIsWhole(wakeId, facts.loadedFrom, facts.turnStarts)) continue;
    const at = endedAt.get(wakeId) ?? (row.kind === "msg" ? row.message.createdAt : "");
    endings.set(row, { kind: facts.interruptedWakeIds.has(wakeId) ? "interrupted" : "silent", at });
  }
  return endings;
}

/** The calls that leave their runs because their turn's ending shows what
 *  they said: drawn as the closing sentence, and not a second time as a call. */
export function callsShownAsEndings(endings: ReadonlyMap<TranscriptRow, TurnEnding>): Set<string> {
  const ids = new Set<string>();
  for (const ending of endings.values()) if (ending.kind === "settled") ids.add(ending.callId);
  return ids;
}
