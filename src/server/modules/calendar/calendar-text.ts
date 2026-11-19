import type { CalendarEntryDto, CalendarTimeDto } from "../../../shared/api/calendar.js";
import { CALENDAR_LIMITS } from "../../../shared/api/calendar.js";
import { dayOf, repeatWords } from "./calendar-rules.js";
import type { CalendarChangeRow, CalendarEntryRow } from "./calendar-store.js";

const CLOCKS = new Map<string, Intl.DateTimeFormat>();
const DAYS = new Map<string, Intl.DateTimeFormat>();
const DATES = new Map<string, Intl.DateTimeFormat>();

function cached(map: Map<string, Intl.DateTimeFormat>, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let format = map.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { timeZone, ...options });
    map.set(timeZone, format);
  }
  return format;
}

/** "09:00" in the zone. */
export function clockIn(ms: number, timeZone: string): string {
  return cached(CLOCKS, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
}

/** "Mon 16 Nov" in the zone. */
export function dayLabelIn(ms: number, timeZone: string): string {
  return cached(DAYS, timeZone, { weekday: "short", day: "numeric", month: "short" }).format(ms);
}

/** "Mon 16 Nov 09:00" in the zone. */
export function dayTimeIn(ms: number, timeZone: string): string {
  return `${dayLabelIn(ms, timeZone)} ${clockIn(ms, timeZone)}`;
}

/** "13 Nov 15:40" in the zone. */
export function dateTimeIn(ms: number, timeZone: string): string {
  return `${cached(DATES, timeZone, { day: "numeric", month: "short" }).format(ms)} ${clockIn(ms, timeZone)}`;
}

/** A YYYY-MM-DD day as "18 Dec". */
export function untilLabel(day: string): string {
  return cached(DATES, "UTC", { day: "numeric", month: "short" }).format(Date.parse(`${day}T12:00:00Z`));
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The rule as the agent reads it: "every Monday 09:00", with the entry's
 *  zone when it is not the agent's; a one-off as "once Tue 17 Nov 10:00". */
export function ruleForAgent(row: Pick<CalendarEntryRow, "cron" | "atMs" | "timezone" | "untilDay">, timeZone: string, withUntil = false): string {
  if (row.cron === null) return `once ${dayTimeIn(row.atMs ?? 0, timeZone)}`;
  const zone = row.timezone === timeZone ? "" : ` (${row.timezone})`;
  const until = withUntil && row.untilDay ? ` until ${untilLabel(row.untilDay)}` : "";
  return `${lowerFirst(repeatWords(row.cron))}${zone}${until}`;
}

function rowOf(entry: CalendarEntryDto): Pick<CalendarEntryRow, "cron" | "atMs" | "timezone" | "untilDay"> {
  return { cron: entry.repeat?.cron ?? null, atMs: entry.once?.at ?? null, timezone: entry.repeat?.timezone ?? "UTC", untilDay: entry.repeat?.until ?? null };
}

export interface CalendarTextClock {
  timeZone: string;
  now: number;
}

/** An entry as the agent's context and the tool's answer say it:
 *  `cal_…` "title" · every Monday 09:00 · next Mon 16 Nov 09:00. */
export function renderCalendarLine(entry: CalendarEntryDto, clock: CalendarTextClock): string {
  const parts = [`\`${entry.id}\` "${entry.title}"`, ruleForAgent(rowOf(entry), clock.timeZone, true)];
  if (entry.paused) parts.push(entry.paused.by === "user" ? "paused by the user" : "paused");
  else if (entry.repeat && entry.next !== null) parts.push(`next ${dayTimeIn(entry.next, clock.timeZone)}`);
  return parts.join(" · ");
}

/** Still ahead: a one-off not yet delivered, a repeat not past its last day (paused or not). */
function stillAhead(entry: CalendarEntryDto): boolean {
  return entry.ahead;
}

function changeText(change: CalendarChangeRow & { title: string }, timeZone: string): string {
  const what = { pause: "paused", resume: "resumed", skip: "skipped", delete: "deleted" }[change.kind];
  if (change.kind === "skip" && change.dueMs !== null) return `${what} "${change.title}" on ${dayLabelIn(change.dueMs, timeZone)}`;
  return `${what} "${change.title}" (${dateTimeIn(change.at, timeZone)})`;
}

/** The runtime context's Calendar section: one line per entry still ahead,
 *  then what the user changed lately; "None." with nothing at all. */
export function renderCalendarSection(entries: readonly CalendarEntryDto[], userChanges: ReadonlyArray<CalendarChangeRow & { title: string }>, clock: CalendarTextClock): string {
  const lines = entries.filter(stillAhead).map((entry) => `- ${renderCalendarLine(entry, clock)}`);
  const since = clock.now - CALENDAR_LIMITS.changesDays * 86_400_000;
  const changes = userChanges.filter((c) => c.at >= since).slice(0, CALENDAR_LIMITS.changesMax);
  if (changes.length > 0) lines.push(`Changed by the user lately: ${changes.map((c) => changeText(c, clock.timeZone)).join("; ")}`);
  return lines.length > 0 ? lines.join("\n") : "None.";
}

function outcomeText(time: CalendarTimeDto, timeZone: string): string {
  if (time.outcome === "delivered") return ` · delivered ${clockIn(time.deliveredAt ?? time.at, timeZone)}`;
  return time.outcome === "due" ? "" : ` · ${time.outcome}`;
}

/** `read` of one entry: it whole, and its last due times. */
export function renderCalendarEntryRead(entry: CalendarEntryDto, skipsAhead: readonly number[], recent: ReadonlyArray<CalendarTimeDto & { missedBefore?: number }>, clock: CalendarTextClock): string {
  const tz = clock.timeZone;
  const rule = entry.repeat
    ? `${lowerFirst(entry.repeat.words)}${entry.repeat.until ? ` until ${untilLabel(entry.repeat.until)}` : ""} (cron ${entry.repeat.cron}, ${entry.repeat.timezone})`
    : `once ${dayTimeIn(entry.once?.at ?? 0, tz)}`;
  const lines = [`\`${entry.id}\` "${entry.title}" · ${rule}`];
  if (entry.paused) lines.push(`${entry.paused.by === "user" ? "Paused by the user" : "Paused"} since ${dateTimeIn(entry.paused.at, tz)}`);
  if (entry.next !== null) lines.push(`Next: ${dayTimeIn(entry.next, tz)}`);
  if (skipsAhead.length > 0) lines.push(`Skipped: ${skipsAhead.map((t) => dayTimeIn(t, tz)).join(", ")}`);
  lines.push(`Created: ${dateTimeIn(entry.createdAt, tz)}`, "Note:", entry.note, "Last times:");
  lines.push(...(recent.length > 0 ? recent.map((t) => `- ${dayTimeIn(t.at, tz)}${outcomeText(t, tz).replace(" · ", " ")}${missedToo(t.missedBefore ?? 0)}`) : ["- none yet"]));
  return lines.join("\n");
}

/** `read` of days: each day with its times, what became of the past ones. */
export function renderCalendarDaysRead(times: readonly CalendarTimeDto[], clock: CalendarTextClock): string {
  const lines: string[] = [];
  let day = "";
  for (const time of times) {
    const label = dayLabelIn(time.at, clock.timeZone);
    if (label !== day) lines.push((day = label));
    lines.push(`- ${clockIn(time.at, clock.timeZone)} \`${time.entryId}\` "${time.title}"${outcomeText(time, clock.timeZone)}`);
  }
  return lines.length > 0 ? lines.join("\n") : "None.";
}

/** The message that wakes the agent for a due time: on time, or late with
 *  when it was due (its day too when that was another day), when it came,
 *  and how many earlier times were missed. */
export function renderCalendarDue(
  row: Pick<CalendarEntryRow, "title" | "note" | "cron" | "atMs" | "timezone" | "untilDay">,
  dueMs: number,
  deliveredMs: number,
  missedBefore: number,
  late: boolean,
  timeZone: string
): string {
  const head = `Calendar: "${row.title}" (${ruleForAgent(row, timeZone)})`;
  if (!late) return `${head} is due.\n${row.note}`;
  const due = dayOf(dueMs, timeZone) === dayOf(deliveredMs, timeZone) ? clockIn(dueMs, timeZone) : dayTimeIn(dueMs, timeZone);
  return `${head} was due at ${due} and comes late, at ${clockIn(deliveredMs, timeZone)}${missedToo(missedBefore)}.\n${row.note}`;
}

/** The words for the earlier times a late delivery stood for. */
function missedToo(count: number): string {
  return count === 0 ? "" : count === 1 ? "; 1 earlier time was missed too" : `; ${count} earlier times were missed too`;
}
