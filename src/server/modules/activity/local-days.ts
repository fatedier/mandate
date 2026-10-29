/**
 * Days as the reader's clock cuts them. A call's date is the date in their
 * time zone, and a day runs from their midnight to the next: the chart's
 * bars, a picked day and the log's day filter all cut the same way, so their
 * numbers agree. The page sends its zone; without one (or with one the
 * runtime does not know) days are UTC, as they always were.
 */
export interface DayClock {
  /** The zone actually used: the one asked for, or UTC. */
  zone: string;
  /** `YYYY-MM-DD` of an ISO instant in this zone. */
  dayOf(iso: string): string;
  /** The instant (ms) a `YYYY-MM-DD` date starts in this zone. */
  startOf(date: string): number;
}

export function dayClock(zone: string | null | undefined): DayClock {
  const name = knownZone(zone) ?? "UTC";
  const dates = new Intl.DateTimeFormat("en-CA", { timeZone: name, year: "numeric", month: "2-digit", day: "2-digit" });
  // A day runs from its start to the next day's start, and a call's day is
  // the one whose span holds it. The chart groups by that, and a picked day
  // and the log filter by the same two starts, so they agree by
  // construction, even where a zone's wall date runs backwards for a while
  // (Newfoundland left summer time at 00:01 in 2009: its 1 November began,
  // went back to 31 October, then began again; the minute in between is
  // the 1st here).
  const starts = new Map<string, number>();
  const startOf = (date: string) => {
    let start = starts.get(date);
    if (start === undefined) {
      start = firstMinuteOn(date);
      starts.set(date, start);
    }
    return start;
  };
  // The first minute whose wall date is this one or later. Every zone's
  // midnight lies within 16 hours of UTC's, and zones change their offset on
  // whole minutes, so a search over those minutes finds it however the clocks
  // change that night: midnight skipped (Santiago), repeated (Amman), or the
  // change between the two midnights (Sydney).
  const firstMinuteOn = (date: string) => {
    const target = dateNumber(date);
    const midnightUtc = utcMidnight(date);
    let before = midnightUtc / MINUTE - 16 * 60;
    let onOrAfter = midnightUtc / MINUTE + 16 * 60;
    while (onOrAfter - before > 1) {
      const mid = Math.floor((before + onOrAfter) / 2);
      if (dateNumber(dates.format(new Date(mid * MINUTE))) >= target) onOrAfter = mid;
      else before = mid;
    }
    // Where the clocks go back across midnight the wall clock reaches the
    // date twice, and the search can land on the second time: the day starts
    // at the first. Clocks are set back by at most a few hours (Casey's
    // three), so that is how far to look.
    let first = onOrAfter;
    for (let minute = onOrAfter - 1; minute >= onOrAfter - SET_BACK_MINUTES; minute -= 1) {
      if (dateNumber(dates.format(new Date(minute * MINUTE))) >= target) first = minute;
    }
    return first * MINUTE;
  };
  // A window holds tens of thousands of calls but far fewer distinct minutes,
  // and no zone changes its offset inside a minute.
  const byMinute = new Map<string, string>();
  const dayOf = (iso: string) => {
    const minute = iso.slice(0, 16);
    let date = byMinute.get(minute);
    if (date === undefined) {
      const t = Date.parse(`${minute}:00.000Z`);
      date = dates.format(new Date(t));
      if (t < startOf(date)) date = nextDate(date, -1);
      else if (t >= startOf(nextDate(date))) date = nextDate(date);
      byMinute.set(minute, date);
    }
    return date;
  };
  return { zone: name, dayOf, startOf };
}

/** The date `step` days after a `YYYY-MM-DD` date: calendar arithmetic, no
 *  zone. The day after 9999-12-31 is 10000-01-01. */
export function nextDate(date: string, step = 1): string {
  const [y, m, d] = ymd(date);
  const next = new Date(utcMidnight(date));
  next.setUTCFullYear(y, m, d + step);
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1, 2)}-${pad(next.getUTCDate(), 2)}`;
}

/**
 * The dates a chart draws a bar for, oldest first: from the first date with
 * calls to the later of `today` and the newest call's date (a machine whose
 * clock moved can hold calls dated ahead). A date without calls is in it, a
 * bar of zero. At most `limit`, counted back from the newest: one stale row
 * must not draw years of bars.
 */
export function chartDates(rowDates: readonly string[], today: string, limit: number): string[] {
  const first = rowDates[0];
  if (!first) return [];
  const newest = rowDates[rowDates.length - 1]!;
  const dates: string[] = [];
  for (let date = dateNumber(newest) > dateNumber(today) ? newest : today; dates.length < limit && dateNumber(date) >= dateNumber(first); date = nextDate(date, -1)) {
    dates.push(date);
  }
  return dates.reverse();
}

/** `YYYY-MM-DD` naming a date that exists: `2026-02-31` does not. */
export function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && nextDate(value, 0) === value;
}

/** The calls a summary counts: those created after `since` and before
 *  `until` (none: up to now), and its days as `clock` cuts them. */
export interface ActivityRange {
  since: string;
  until: string | null;
  clock: DayClock;
  /** The period the spend is compared with: created after `previousSince`, up to and including `previousUntil`. */
  previousSince: string;
  previousUntil: string;
  /** The one day of the window it counts, when the reader picked one. */
  day: string | null;
}

const DAY_MS = 86_400_000;
/** After every ISO time a row can hold ("~" sorts after the digits). */
export const END_OF_TIME = "~";
const MINUTE = 60_000;
const SET_BACK_MINUTES = 4 * 60;

function ymd(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m - 1, d];
}

/** UTC midnight of a `YYYY-MM-DD` date (setUTCFullYear, not Date.UTC, which
 *  reads years 0–99 as 1900–1999). */
function utcMidnight(date: string): number {
  const at = new Date(0);
  at.setUTCFullYear(...ymd(date));
  return at.getTime();
}

/** A `YYYY-MM-DD` date as a number that orders as the date does, five-digit
 *  years too (as strings, "10000-01-01" sorts before "9999-12-31"). */
function dateNumber(date: string): number {
  const [y, m, d] = ymd(date);
  return y * 10_000 + (m + 1) * 100 + d;
}

/**
 * The last `days` days up to `now`, cut into the reader's days. With a
 * `day` (a date that exists), only that day of the window: from its
 * midnight, or the window's start if that is later (the window opens
 * partway through its first day, and the day's figures are its bar's), to
 * the next midnight; its spend is compared with the whole day before.
 */
export function activityRange({ days, now, zone = null, day = null }: {
  days: number;
  now: number;
  zone?: string | null;
  day?: string | null;
}): ActivityRange {
  const clock = dayClock(zone);
  const windowStart = now - days * DAY_MS;
  if (day !== null && isCalendarDate(day)) {
    const start = clock.startOf(day);
    // `created_at > since` and whole milliseconds: a millisecond before the
    // midnight lets the midnight itself in.
    return {
      since: new Date(Math.max(start - 1, windowStart)).toISOString(),
      until: new Date(clock.startOf(nextDate(day))).toISOString(),
      clock,
      previousSince: new Date(clock.startOf(nextDate(day, -1)) - 1).toISOString(),
      previousUntil: new Date(start - 1).toISOString(),
      day
    };
  }
  const since = new Date(windowStart).toISOString();
  return { since, until: null, clock, previousSince: new Date(now - 2 * days * DAY_MS).toISOString(), previousUntil: since, day: null };
}

function knownZone(zone: string | null | undefined): string | null {
  // Trimmed, as the log trims its filters: both endpoints read one zone.
  const name = zone?.trim();
  if (!name) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
