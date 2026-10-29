import { formatCalendarDate, formatClockMinutes, formatDateTime } from "@/lib/format";

/**
 * The transcript's only visible times (rows keep theirs in a title): a divider
 * opens each day with its date and time, and one with the time marks a row that
 * starts CHAT_PAUSE_MS or more after the previous row ended.
 */
const CHAT_PAUSE_MS = 5 * 60_000;

/** What the divider pass needs to know of a drawn row. */
export interface DividerFacts {
  /** When the row begins (a reply under its cause line: the cause). */
  start: string;
  /** When it ended, in ms: its last step. */
  end: number;
  wakeId: string | null;
  /** A later step of the wake the previous row belongs to: work going on,
   *  never a pause (a streamed reply lands with the time it finished). */
  continues: boolean;
}

export interface DividerState {
  date: string;
  end: number | null;
  wakeId: string | null;
}

export const EMPTY_DIVIDER_STATE: DividerState = { date: "", end: null, wakeId: null };

/** The divider before `row`, if any, and the state after it. */
export function placeDivider(row: DividerFacts, state: DividerState): { label: string | null; next: DividerState } {
  const date = formatCalendarDate(row.start);
  const start = Date.parse(row.start);
  const newDay = Boolean(date) && date !== state.date;
  const paused = !newDay && !row.continues && state.end !== null && start - state.end >= CHAT_PAUSE_MS;
  return {
    label: newDay ? formatDateTime(row.start) : paused ? formatClockMinutes(row.start) : null,
    next: { date: date || state.date, end: Number.isFinite(row.end) ? row.end : state.end, wakeId: row.wakeId }
  };
}
