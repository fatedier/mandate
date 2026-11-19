import { rendersNothing, type TranscriptRow } from "./transcript-rows";
import { replyText, userText } from "./row-actions";

/** What can go into a shared image or text: the user's sent words and the
 *  agent's reply text. Pure, so what is picked is tested as data. */

/** A row's key, the one its element carries. */
export function shareKeyOf(row: TranscriptRow): string {
  return row.kind === "pending" ? row.pending.localId : row.message.id;
}

/** Whose words a user bubble can be: the user's typed or spoken. A worker's
 *  chat draws its manager's instructions as bubbles too; they are not. */
const USERS_OWN = new Set(["user", "voice"]);

/** The rows that can be shared, in transcript order: the user's own messages
 *  that were sent and say something, and replies with text. Not a send still
 *  on its way, and not a turn still running (its reply is not finished). */
export function shareableRows(
  rows: readonly TranscriptRow[],
  facts: { isUserBubble(row: TranscriptRow): boolean; liveWakeIds: ReadonlySet<string> }
): TranscriptRow[] {
  return rows.filter((row) => {
    if (row.kind !== "msg" || rendersNothing(row)) return false;
    if (facts.isUserBubble(row)) return USERS_OWN.has(row.message.source) && userText(row).trim() !== "";
    if (replyText(row.message) === null) return false;
    return row.message.wakeId === null || !facts.liveWakeIds.has(row.message.wakeId);
  });
}

/** A shareable row's words: the user's, or the reply's. */
export function shareText(row: TranscriptRow): string {
  if (row.kind !== "msg") return row.pending.content;
  return replyText(row.message) ?? userText(row);
}

const isReply = (row: TranscriptRow) => row.kind === "msg" && row.message.role === "assistant";
const wakeOf = (row: TranscriptRow) => (row.kind === "msg" ? row.message.wakeId : null);

/** What is picked when sharing starts at a row: the exchange it is part of.
 *  From a reply, its turn, from the user's message just before the turn's
 *  first row in the transcript (when it is one: a turn a notice or a manager
 *  woke has none) through the turn's last row. From the user's message, it through the last row of the
 *  turn its next reply belongs to (a message sent while that turn ran picks
 *  none of the replies before it). A reply outside any turn, or a message with no reply after
 *  it, is picked alone. */
export function preselection(entryKey: string, rows: readonly TranscriptRow[], shareable: readonly TranscriptRow[]): Set<string> {
  const index = shareable.findIndex((row) => shareKeyOf(row) === entryKey);
  if (index < 0) return new Set();
  const entry = shareable[index]!;
  let wakeId = isReply(entry) ? wakeOf(entry) : null;
  if (!isReply(entry)) {
    const next = shareable.slice(index + 1).find(isReply);
    wakeId = next ? wakeOf(next) : null;
    if (!wakeId) return new Set([entryKey]);
  }
  if (!wakeId) return new Set([entryKey]);
  let first = shareable.findIndex((row) => isReply(row) && wakeOf(row) === wakeId);
  let last = first;
  shareable.forEach((row, i) => { if (isReply(row) && wakeOf(row) === wakeId) last = i; });
  // From the user's message itself: one sent while the turn ran starts there.
  if (!isReply(entry)) first = index;
  else {
    // The row before the turn's first, whatever that is (a run of commands is
    // the turn's too), when it is the user's message: from there, with what
    // they sent while the turn ran. A notice that woke the turn is its cause
    // line, not a row, so the row before can be another turn's reply.
    const start = rows.findIndex((row) => wakeOf(row) === wakeId);
    const before = start > 0 ? rows[start - 1]! : null;
    const at = before && !isReply(before) ? shareable.findIndex((row) => shareKeyOf(row) === shareKeyOf(before)) : -1;
    if (at >= 0 && at < first) first = at;
  }
  return new Set(shareable.slice(first, last + 1).map(shareKeyOf));
}

/** The keys from one row to another, both included, whichever comes first.
 *  A row no longer there leaves just the other. */
export function rangeBetween(shareable: readonly TranscriptRow[], fromKey: string, toKey: string): string[] {
  const keys = shareable.map(shareKeyOf);
  const a = keys.indexOf(fromKey);
  const b = keys.indexOf(toKey);
  if (a < 0 || b < 0) return [toKey];
  return keys.slice(Math.min(a, b), Math.max(a, b) + 1);
}

export interface ShareItem {
  key: string;
  side: "user" | "agent";
  text: string;
  /** Rows between this one and the previous picked were left out. */
  skipBefore: boolean;
}

/** The picked rows as shared, in the conversation's order. */
export function cardItems(shareable: readonly TranscriptRow[], selected: ReadonlySet<string>): ShareItem[] {
  const items: ShareItem[] = [];
  let previous = -1;
  shareable.forEach((row, i) => {
    const key = shareKeyOf(row);
    if (!selected.has(key)) return;
    items.push({ key, side: isReply(row) ? "agent" : "user", text: shareText(row), skipBefore: previous >= 0 && i > previous + 1 });
    previous = i;
  });
  return items;
}

/** Where picked rows meet: for each picked row, whether the row drawn just
 *  above it, and just below, is picked too. `drawn` is what picking draws, in
 *  order: a row's key, or null for a divider, which parts two runs. */
export function pickedRuns(drawn: readonly (string | null)[], selected: ReadonlySet<string>): Map<string, { above: boolean; below: boolean }> {
  const picked = (key: string | null | undefined) => key != null && selected.has(key);
  const runs = new Map<string, { above: boolean; below: boolean }>();
  drawn.forEach((key, i) => {
    if (key !== null && picked(key)) runs.set(key, { above: picked(drawn[i - 1]), below: picked(drawn[i + 1]) });
  });
  return runs;
}
