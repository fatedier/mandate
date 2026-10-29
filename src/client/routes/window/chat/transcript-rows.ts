import type { AgentMessage, PendingMessage, ThreadState } from "@/store/agent-chat";
import { isModelOnlySource, isPageNoteSource } from "@shared/agent-message-types";
import { isRecord } from "@shared/guards";
import { EMPTY_DIVIDER_STATE, placeDivider, type DividerFacts, type DividerState } from "./chat-dividers";
import { runOpenKey, type ToolResultSpec } from "./tool-run-summary";
import { isHiddenMessage } from "./wake-causes";
import { commandResultOf } from "./subagent-lines";

/** The transcript as rows, before React: what the list draws from a thread's
 *  messages and pending sends, and where its date dividers go. Pure, so each
 *  rule is tested as data. */

/** A message the transcript may draw (with the tool-only steps folded into
 *  it), or a send still on its way. */
export type TranscriptItem =
  | { kind: "msg"; message: AgentMessage; runTail?: AgentMessage[] }
  | { kind: "pending"; pending: PendingMessage };

/** A drawn row: an item and, for a reply, the event that woke it. */
export type TranscriptRow = TranscriptItem & { cause?: AgentMessage };

/** A row, or the date divider over it. */
export type DatedRow =
  | { kind: "item"; item: TranscriptRow }
  | { kind: "date"; key: string; timestamp: string; label: string };

/** The row the running turn is on: its latest row drawn at all, while its
 *  reply has not begun. When that row has a run, the run's line names the
 *  latest call instead of the tally (ToolRun's `live`). A row of anyone
 *  else's after it (a person's message, a notice), or a step it drew nothing
 *  for (empty, or reasoning only), leaves it the turn's latest; the turn's
 *  own words end the run, being then its latest row or its reply streaming. */
export function liveRunRow<R extends TranscriptRow>(rows: readonly R[], activeWakeId: string | null, replyStreaming: boolean): R | null {
  if (!activeWakeId || replyStreaming) return null;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.kind === "msg" && row.message.role === "assistant" && row.message.wakeId === activeWakeId && !rendersNothing(row)) return row;
  }
  return null;
}

/** The wake reason for a message, falling back to the thread's per-wake map
 *  when the message itself does not carry one. */
export function wakeReasonOf(m: AgentMessage, wakeReasonsById: ThreadState["wakeReasonsById"]) {
  return m.wakeReason ?? (m.wakeId ? (wakeReasonsById.get(m.wakeId) ?? null) : null);
}

/** Each tool call's result, by its call's id. */
export function toolResultsOf(messages: readonly AgentMessage[]): Map<string, ToolResultSpec> {
  const results = new Map<string, ToolResultSpec>();
  for (const m of messages) {
    if (m.role !== "tool" || m.content.type !== "tool_result") continue;
    results.set(m.content.toolCallId, {
      result: m.content.result,
      isError: m.content.isError,
      error: m.content.error,
      createdAt: m.createdAt
    });
  }
  return results;
}

/** The thread's drawable items in order (tool results and model-only rows
 *  dropped, pending sends after everything), each tool call's result by its
 *  id, and how many queued sends were left out. */
export function transcriptItems(
  messages: readonly AgentMessage[],
  pendingUserMessages: ThreadState["pendingUserMessages"],
  hideQueuedPending: boolean | undefined
): { renderItems: TranscriptItem[]; toolResultsByCallId: Map<string, ToolResultSpec>; hiddenQueuedCount: number } {
  const toolResultsByCallId = toolResultsOf(messages);
  const commandStarts = commandStartTurns(messages);
  const renderItems: TranscriptItem[] = [];
  for (const [index, m] of messages.entries()) {
    if (m.role === "tool") continue;
    // A command's result that lands while the turn that started it goes on is
    // no row: the line where it started already shows how it ended.
    if (m.source === "command-result" && landedInStartingTurn(messages, index, commandStarts)) continue;
    // Model-only rows (runtime context, a plan reminder) are dropped here,
    // before runs are grouped and new rows counted: a reminder lands in the
    // middle of a wake, and left in it would split one tool run in two.
    if (m.role === "user" && isModelOnlySource(m.source)) continue;
    // A skip is said on its question's line, not as a row.
    if (m.source === "question-skip") continue;
    // Notes about Your agent's page are the model's, never rows; dropped here
    // for the same reason as model-only rows.
    if (isPageNoteSource(m.source)) continue;
    renderItems.push({ kind: "msg", message: m });
  }
  let hiddenQueuedCount = 0;
  for (const p of pendingUserMessages.values()) {
    if (hideQueuedPending && p.status === "queued") {
      hiddenQueuedCount++;
      continue;
    }
    if (p.status === "sent" && p.messageId && messages.some((m) => m.id === p.messageId))
      continue;
    renderItems.push({ kind: "pending", pending: p });
  }
  return { renderItems, toolResultsByCallId, hiddenQueuedCount };
}

/** Rows the transcript deliberately renders as nothing (see isHiddenMessage).
 *  A date separator must never be anchored to one: `ensureSystemMessage` seeds
 *  every thread with a hidden `role: "system"` row at seq 0, and if that row
 *  opened the day, the heading would sit over an empty stretch of transcript
 *  and the day's first VISIBLE message would then be judged as "same day, no
 *  separator needed". */
/** The turn that started each background command, by its task id: the
 *  turn of the tool result that said it runs in the background, when the
 *  call that started it is loaded too (its line draws how it ended; an older
 *  page not loaded yet has neither). */
function commandStartTurns(messages: readonly AgentMessage[]): Map<string, string> {
  const loadedCalls = new Set(messages.flatMap((m) => (m.content.type === "assistant" ? (m.content.toolCalls ?? []).map((call) => call.toolCallId) : [])));
  const starts = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "tool" || m.content.type !== "tool_result" || !m.wakeId || !loadedCalls.has(m.content.toolCallId)) continue;
    const result = m.content.result;
    if (isRecord(result) && typeof result.taskId === "string") starts.set(result.taskId, m.wakeId);
  }
  return starts;
}

/** Whether a command's result landed in the turn that started the command:
 *  the next step after it belongs to that turn. A result that woke a later
 *  turn, or that nothing has answered yet, did not. */
function landedInStartingTurn(messages: readonly AgentMessage[], index: number, starts: ReadonlyMap<string, string>): boolean {
  const taskId = commandResultOf(messages[index]!)?.taskId;
  const started = taskId ? starts.get(taskId) : undefined;
  if (!started) return false;
  for (const next of messages.slice(index + 1)) {
    if (next.role === "user") continue;
    return next.wakeId === started;
  }
  return false;
}

export function rendersNothing(item: { kind: "msg"; message: AgentMessage; runTail?: AgentMessage[] } | { kind: "pending" }) {
  return item.kind === "msg" && isHiddenMessage(item.message, item.runTail);
}

/** A drawn row as the divider pass reads it: where it begins (a reply under its
 *  cause line begins at the cause), where its last step ended, and whether it
 *  is a later step of the wake the previous row belongs to. */
function dividerFactsOf(
  item: { kind: "msg"; message: AgentMessage; runTail?: AgentMessage[]; cause?: AgentMessage } | { kind: "pending"; pending: PendingMessage },
  state: DividerState
): DividerFacts {
  if (item.kind === "pending") {
    return { start: item.pending.createdAt, end: Date.parse(item.pending.createdAt), wakeId: null, continues: false };
  }
  const start = (item.cause ?? item.message).createdAt;
  const times = [start, item.message.createdAt, ...(item.runTail ?? []).map((step) => step.createdAt)]
    .map((time) => Date.parse(time))
    .filter((time) => !Number.isNaN(time));
  const wakeId = item.message.wakeId ?? null;
  return {
    start,
    end: times.length ? Math.max(...times) : Number.NaN,
    wakeId,
    continues: item.message.role === "assistant" && !item.cause && wakeId !== null && wakeId === state.wakeId
  };
}

/** Where the divider pass stands at the first drawn row: the items above the
 *  render window are not drawn, but they decide whether that row opens a day
 *  or a pause. */
export function dividerSeedFor(renderItems: readonly TranscriptItem[], drawnCount: number): DividerState {
  let state = EMPTY_DIVIDER_STATE;
  const before = renderItems.length - drawnCount;
  for (let i = 0; i < before; i++) {
    const item = renderItems[i]!;
    if (rendersNothing(item)) continue;
    state = placeDivider(dividerFactsOf(item, state), state).next;
  }
  return state;
}

/** The drawn rows with a date divider over each that opens a day or follows a
 *  pause. */
export function datedRows(rows: readonly TranscriptRow[], seed: DividerState): DatedRow[] {
  const dated: DatedRow[] = [];
  // From the rows before the render window, so the first drawn row is not
  // mistaken for a new day, and no divider changes when the window grows.
  let state = seed;
  for (const item of rows) {
    if (rendersNothing(item)) {
      dated.push({ kind: "item", item });
      continue;
    }
    const facts = dividerFactsOf(item, state);
    const placed = placeDivider(facts, state);
    if (placed.label) {
      const key = item.kind === "pending" ? item.pending.localId : item.message.id;
      dated.push({ kind: "date", key, timestamp: facts.start, label: placed.label });
    }
    state = placed.next;
    dated.push({ kind: "item", item });
  }
  return dated;
}

const NO_CALLS: ReadonlySet<string> = new Set();

/** Past this many characters a message from the manager is drawn folded. A
 *  task it writes for a worker runs to thousands: about eighty lines beside
 *  its thread. */
export const FOLD_OVER_CHARS = 600;

/** A message drawn folded to a few lines until opened: the manager's, when
 *  long. The user's own words are never folded. */
export function foldsWhenLong(message: AgentMessage): boolean {
  return message.role === "user" && message.source === "manager" &&
    message.content.type === "text" && message.content.text.length > FOLD_OVER_CHARS;
}

/** The mark of a folded message opened, in the set that holds the opened runs. */
export function foldOpenKey(messageId: string): string {
  return `fold:${messageId}`;
}

/** Whether a long message opened in place pauses following, as an open run
 *  does and for the same reason: opened at the end, it would be scrolled away
 *  by its own growth. It opens in place on a phone too. Read from the
 *  messages loaded, never from the marks alone (see openRunPausesFollow). */
export function openFoldPausesFollow(rows: readonly TranscriptItem[], expandedIds: ReadonlySet<string>): boolean {
  if (expandedIds.size === 0) return false;
  return rows.some((item) => item.kind === "msg" && foldsWhenLong(item.message) && expandedIds.has(foldOpenKey(item.message.id)));
}

/** Whether a run open on screen pauses following new messages, so it is not
 *  scrolled away while being read. Read from the runs actually drawn, never
 *  from the marks alone: a mark can outlive what it opened (the run lost its
 *  messages, or the pane went phone-sized, where nothing opens in place), and
 *  a pause held by something no one can see is a transcript that silently
 *  stops following. A call drawn elsewhere (a turn's closing sentence) is in
 *  no run: the run it opened may have left the page with it. */
export function openRunPausesFollow(
  rows: readonly TranscriptItem[],
  expandedToolIds: ReadonlySet<string>,
  isMobile: boolean,
  drawnElsewhere: ReadonlySet<string> = NO_CALLS
): boolean {
  if (isMobile || expandedToolIds.size === 0) return false;
  return rows.some((item) =>
    item.kind === "msg" &&
    [item.message, ...(item.runTail ?? [])].some((step) =>
      step.content.type === "assistant" &&
      (step.content.toolCalls ?? []).some((call) => !drawnElsewhere.has(call.toolCallId) && expandedToolIds.has(runOpenKey(call.toolCallId)))
    )
  );
}
