/** The personal agent's calendar: what is planned for a time, once or on a
 *  repeat. The server expands the rules; the client only draws what it is
 *  given for a range. */

export const CALENDAR_LIMITS = {
  title: 120,
  note: 2000,
  /** The longest range one read or one page fetch may ask for. */
  readDays: 92,
  /** Delivered later than this after its due time, a time reads as late. */
  lateMs: 5 * 60_000,
  /** Two due times of a repeat are never closer than this. */
  minGapMs: 60 * 60_000,
  onceMinMs: 60_000,
  onceMaxMs: 365 * 86_400_000,
  /** The due times `read` of one entry lists. */
  recentTimes: 10,
  /** The user's changes the agent's context lists: how far back, how many. */
  changesDays: 3,
  changesMax: 10
} as const;

/** What became of a due time: still ahead, delivered, missed (passed while it
 *  could not be delivered), skipped, or passed (or ahead) while paused. */
export type CalendarOutcome = "due" | "delivered" | "missed" | "skipped" | "paused";

export type CalendarActor = "user" | "agent";

export interface CalendarEntryDto {
  id: string;
  title: string;
  note: string;
  once: { at: number } | null;
  repeat: { cron: string; timezone: string; until: string | null; words: string } | null;
  paused: { by: CalendarActor; at: number } | null;
  createdAt: number;
  updatedAt: number;
  /** The next time it is due, skipped and paused times passed over; null when none. */
  next: number | null;
  /** It has a time still ahead, skipped or paused alike: false once a one-off
   *  is delivered or a repeat is past its last day. */
  ahead: boolean;
}

export interface CalendarTimeDto {
  entryId: string;
  title: string;
  at: number;
  outcome: CalendarOutcome;
  deliveredAt: number | null;
  repeating: boolean;
}

export interface CalendarDto {
  entries: CalendarEntryDto[];
  times: CalendarTimeDto[];
  from: number;
  to: number;
}

export interface CalendarEntryResponse {
  entry: CalendarEntryDto;
}

export interface CalendarSkipBody {
  at: number;
}

/** The SSE ping: something on the calendar changed; a view refetches its range. */
export interface CalendarChangedEvent {
  ids: string[];
}
