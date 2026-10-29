import type { AgentMessage } from "@/store/agent-chat";
import { rendersNothing, type TranscriptItem, type TranscriptRow } from "./transcript-rows";
import type { TurnEnding } from "./turn-endings";

/** What the line under a turn that wrote no reply says before its time. */
export const FINISHED_WITHOUT_REPLY = "Finished without a reply";
/** And under one a person stopped before it wrote any. */
export const INTERRUPTED = "Interrupted";

/** A row's action line: the line under the user's message and
 *  under each turn's last reply that holds Copy and the row's time; and under
 *  the last row of a turn that said nothing, where it marks the turn's end.
 *  Pure, so which rows get one, and what each copies, is tested as data. */
export interface RowActions {
  /** Under the bubble's right edge, or under the reply's left. */
  side: "start" | "end";
  /** What Copy writes, as written; null when there is nothing safe to copy. */
  copy: string | null;
  /** The row's time: when the message was sent, or the reply finished, or
   *  the turn that said nothing ended. */
  at: string;
  /** Words before the time: a silent turn says it finished, or that it was
   *  interrupted. Null for a row whose own words already say so. */
  label: string | null;
  /** How long the reply's turn worked, for a turn long enough to say. */
  workedMs: number | null;
  /** The transcript's most recent reply, or the ending after it of a turn
   *  that said nothing: these lines always show. */
  latest: boolean;
}

export interface TranscriptFacts {
  /** Every loaded row, drawn or still above the render window: a turn's
   *  Copy takes all it said, and it may have begun above the window. */
  loaded: readonly TranscriptItem[];
  /** How far back the loaded messages reach, while older ones remain to be
   *  loaded; null once everything is. */
  loadedFrom: string | null;
  /** When each turn began, for the turns that say. */
  turnStarts: ReadonlyMap<string, string>;
  /** The turn under way: it has no line until it ends. */
  activeWakeId: string | null;
  workedFor: ReadonlyMap<string, number>;
  /** How each turn that said nothing ends, by its last drawn row. */
  endings: ReadonlyMap<TranscriptRow, TurnEnding>;
  /** Whether a row is drawn as the user's bubble. */
  isUserBubble(row: TranscriptRow): boolean;
}

/** What a reply said, as written; null for anything else or nothing. */
function replyText(message: AgentMessage): string | null {
  if (message.role !== "assistant" || message.content.type !== "assistant") return null;
  return message.content.text?.trim() ? message.content.text : null;
}

/** Whether everything a turn wrote is among the loaded messages. Everything
 *  a turn said came after it began, so it is whole once the loaded messages
 *  reach back to that moment; which turn the first loaded message belongs to
 *  does not say, as a message in no turn (an alarm firing mid-turn) can be the
 *  first. A turn that does not say when it began is not known to be whole. */
export function turnIsWhole(wakeId: string, loadedFrom: string | null, turnStarts: ReadonlyMap<string, string>): boolean {
  if (loadedFrom === null) return true;
  const began = turnStarts.get(wakeId);
  return began !== undefined && Date.parse(loadedFrom) <= Date.parse(began);
}

function userText(row: TranscriptRow): string {
  if (row.kind === "pending") return row.pending.content;
  return row.message.content.type === "text" ? row.message.content.text : "";
}

/** The action line of each drawn row that has one.
 *
 *  The user's bubble copies itself. A turn has one line, under the last row in
 *  which it said something, and its Copy takes everything the turn said, in
 *  order: what it said on the way is part of the answer, and a Copy per
 *  paragraph would need a line under each. A reply outside any turn is its own.
 *
 *  A turn whose start may not be loaded offers no Copy rather than half of
 *  itself (turnIsWhole).
 *
 *  A turn that said nothing has a line too, under its last row, with no Copy:
 *  its time, after the words that it finished unless the row's own closing
 *  sentence says so, or that it was interrupted (turnEndings). The most
 *  recent reply's line always shows, and so does such an ending when no reply
 *  or ending follows it: the last thing on the page then says the turn is
 *  over. */
export function rowActions(rows: readonly TranscriptRow[], facts: TranscriptFacts): Map<TranscriptRow, RowActions> {
  const said = new Map<string, string[]>();
  for (const item of facts.loaded) {
    if (item.kind !== "msg" || rendersNothing(item)) continue;
    const text = replyText(item.message);
    const wakeId = item.message.wakeId;
    if (!text || !wakeId) continue;
    const texts = said.get(wakeId);
    if (texts) texts.push(text);
    else said.set(wakeId, [text]);
  }
  const lastSaid = new Map<string, TranscriptRow>();
  for (const row of rows) {
    if (row.kind === "msg" && row.message.wakeId && replyText(row.message) && !rendersNothing(row)) lastSaid.set(row.message.wakeId, row);
  }

  const whole = (wakeId: string): boolean => turnIsWhole(wakeId, facts.loadedFrom, facts.turnStarts);

  const actions = new Map<TranscriptRow, RowActions>();
  let latest: TranscriptRow | null = null;
  // The last turn's line of either kind: a reply's, or a silent turn's ending.
  let lastEnd: TranscriptRow | null = null;
  for (const row of rows) {
    if (rendersNothing(row)) continue;
    if (facts.isUserBubble(row)) {
      const text = userText(row);
      const at = row.kind === "pending" ? row.pending.createdAt : row.message.createdAt;
      actions.set(row, { side: "end", copy: text.trim() ? text : null, at, label: null, workedMs: null, latest: false });
      continue;
    }
    if (row.kind !== "msg") continue;
    const ending = facts.endings.get(row);
    if (ending) {
      const workedMs = row.message.wakeId ? facts.workedFor.get(row.message.wakeId) ?? null : null;
      const label = ending.kind === "silent" ? FINISHED_WITHOUT_REPLY : ending.kind === "interrupted" ? INTERRUPTED : null;
      actions.set(row, { side: "start", copy: null, at: ending.at, label, workedMs, latest: false });
      lastEnd = row;
      continue;
    }
    const text = replyText(row.message);
    if (!text) continue;
    const wakeId = row.message.wakeId ?? null;
    if (wakeId !== null && (wakeId === facts.activeWakeId || lastSaid.get(wakeId) !== row)) continue;
    const copy = wakeId === null ? text : whole(wakeId) ? (said.get(wakeId) ?? [text]).join("\n\n") : null;
    const workedMs = wakeId === null ? null : facts.workedFor.get(wakeId) ?? null;
    actions.set(row, { side: "start", copy, at: row.message.createdAt, label: null, workedMs, latest: false });
    latest = row;
    lastEnd = row;
  }
  if (latest) actions.set(latest, { ...actions.get(latest)!, latest: true });
  if (lastEnd && lastEnd !== latest) actions.set(lastEnd, { ...actions.get(lastEnd)!, latest: true });
  return actions;
}
