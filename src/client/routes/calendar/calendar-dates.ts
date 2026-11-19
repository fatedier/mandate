/** Days, weeks and months as the Calendar page steps through them, in the
 *  viewer's own zone: only stepping by days and months; the words are Intl's. */

export type CalendarViewKind = "day" | "week" | "month" | "list";

export const LIST_DAYS = 30;

export function startOfDay(at: Date | number): Date {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(day: Date, n: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
}

/** The Monday of the day's week. */
export function mondayOf(day: Date): Date {
  return addDays(startOfDay(day), -((day.getDay() + 6) % 7));
}

export function sameDay(a: Date | number, b: Date | number): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", options);
const CLOCK = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const SHORT_DAY = fmt({ weekday: "short", day: "numeric", month: "short" });
const DAY_MONTH = fmt({ day: "numeric", month: "short" });
const DAY_MONTH_YEAR = fmt({ day: "numeric", month: "short", year: "numeric" });
const MONTH_YEAR = fmt({ month: "long", year: "numeric" });
const WEEKDAY = fmt({ weekday: "short" });

/** "09:00". */
export const clockOf = (ms: number): string => CLOCK.format(ms);
/** "Mon 16 Nov". */
export const shortDayOf = (at: Date | number): string => SHORT_DAY.format(at);
/** "Mon". */
export const weekdayOf = (at: Date | number): string => WEEKDAY.format(at);

/** "Today", "Tomorrow" or "Mon 16 Nov". */
export function dayName(day: Date | number, now: number): string {
  if (sameDay(day, now)) return "Today";
  if (sameDay(day, addDays(startOfDay(now), 1))) return "Tomorrow";
  return shortDayOf(day);
}

function spanTitle(from: Date, last: Date): string {
  if (from.getFullYear() !== last.getFullYear()) return `${DAY_MONTH_YEAR.format(from)} – ${DAY_MONTH_YEAR.format(last)}`;
  if (from.getMonth() !== last.getMonth()) return `${DAY_MONTH.format(from)} – ${DAY_MONTH_YEAR.format(last)}`;
  return `${from.getDate()} – ${DAY_MONTH_YEAR.format(last)}`;
}

export interface CalendarPeriod {
  from: number;
  to: number;
  /** The days it draws, first to last. */
  days: Date[];
  title: string;
}

/** What a view draws around the day it is at, and its title. */
export function periodOf(view: CalendarViewKind, anchor: Date): CalendarPeriod {
  const day = startOfDay(anchor);
  const span = (first: Date, count: number) => Array.from({ length: count }, (_, i) => addDays(first, i));
  // "Fri 13 Nov 2026": Intl's own puts a comma after the weekday when a year follows.
  if (view === "day") return { from: day.getTime(), to: addDays(day, 1).getTime(), days: [day], title: `${SHORT_DAY.format(day)} ${day.getFullYear()}` };
  if (view === "week") {
    const first = mondayOf(day);
    const days = span(first, 7);
    return { from: first.getTime(), to: addDays(first, 7).getTime(), days, title: spanTitle(first, days[6]!) };
  }
  if (view === "month") {
    const firstOfMonth = new Date(day.getFullYear(), day.getMonth(), 1);
    const first = mondayOf(firstOfMonth);
    const last = new Date(day.getFullYear(), day.getMonth() + 1, 0);
    const weeks = Math.ceil((Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1) / 7);
    const days = span(first, weeks * 7);
    return { from: first.getTime(), to: addDays(first, weeks * 7).getTime(), days, title: MONTH_YEAR.format(firstOfMonth) };
  }
  const days = span(day, LIST_DAYS);
  return { from: day.getTime(), to: addDays(day, LIST_DAYS).getTime(), days, title: spanTitle(day, days[LIST_DAYS - 1]!) };
}

/** The day the view goes to with Previous (-1) or Next (1). */
export function stepAnchor(view: CalendarViewKind, anchor: Date, dir: -1 | 1): Date {
  const day = startOfDay(anchor);
  if (view === "day") return addDays(day, dir);
  if (view === "week") return addDays(day, 7 * dir);
  if (view === "month") return new Date(day.getFullYear(), day.getMonth() + dir, 1);
  return addDays(day, LIST_DAYS * dir);
}

/** The viewer's own zone. */
export function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** A YYYY-MM-DD day as "18 Dec". */
export function untilLabel(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(Date.parse(`${day}T12:00:00Z`));
}
