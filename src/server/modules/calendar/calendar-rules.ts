import { dueTimesAfter, nextDue } from "../schedules/cron.js";
import { CALENDAR_LIMITS } from "../../../shared/api/calendar.js";

/** A calendar request Mandate will not take, in the words the agent or the
 *  page reads; 404 when the entry does not exist. */
export class CalendarRefusal extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = "CalendarRefusal";
  }
}

const DAY_MS = 86_400_000;
const HORIZON_MS = 400 * DAY_MS;
/** Hourly over the longest range is 2,208 times. */
const MAX_TIMES = 3000;

const LONG_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const NTH = ["First", "Second", "Third", "Fourth", "Fifth"];
const INT = /^\d{1,2}$/;

function day(token: string): number | null {
  if (/^\d$/.test(token)) {
    const n = Number(token);
    return n === 7 ? 0 : n <= 6 ? n : null;
  }
  return DAY_NAMES[token.toUpperCase()] ?? null;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** A repeat in words where its cron has a common shape; otherwise the cron
 *  itself. The time is the cron's own, in the entry's zone. */
export function repeatWords(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  const raw = `cron ${fields.join(" ")}`;
  if (fields.length !== 5) return raw;
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = fields;
  if (!INT.test(minute) || !INT.test(hour) || Number(minute) > 59 || Number(hour) > 23) return raw;
  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  if (dom === "*" && month === "*") {
    if (dow === "*") return `Daily ${time}`;
    if (dow === "1-5" || dow.toUpperCase() === "MON-FRI") return `Weekdays ${time}`;
    const nth = /^([^#]+)#([1-5])$/.exec(dow);
    if (nth) {
      const d = day(nth[1]!);
      return d === null ? raw : `${NTH[Number(nth[2]) - 1]} ${LONG_DAYS[d]} of the month, ${time}`;
    }
    const days = dow.split(",").map(day);
    if (days.some((d) => d === null)) return raw;
    if (days.length === 1) return `Every ${LONG_DAYS[days[0]!]} ${time}`;
    return `Every ${days.map((d) => SHORT_DAYS[d!]).join(", ")} ${time}`;
  }
  if (dow !== "*") return raw;
  if (dom === "L" && month === "*") return `Last day of the month, ${time}`;
  if (!INT.test(dom) || Number(dom) < 1 || Number(dom) > 31) return raw;
  if (month === "*") return `Monthly on the ${ordinal(Number(dom))}, ${time}`;
  const every = /^\*\/(\d{1,2})$/.exec(month);
  // Only a step that divides the year comes round evenly across its end.
  if (every && [2, 3, 4, 6, 12].includes(Number(every[1]))) return `Every ${every[1]} months on the ${ordinal(Number(dom))}, ${time}`;
  return raw;
}

const OFFSETS = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at `ms`, in minutes. */
function offsetMinutes(ms: number, timezone: string): number {
  let format = OFFSETS.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
    OFFSETS.set(timezone, format);
  }
  const name = format.formatToParts(ms).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = /([+-])(\d{2}):(\d{2})/.exec(name);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

/** Refuses a cron it cannot read or never due (the schedules' words), and one
 *  that can come due twice within an hour over the next 400 days. Croner takes
 *  about 90 µs a step, too slow to walk an hourly repeat for 400 days, so: one
 *  minute value means local times at least an hour apart, and only a clock
 *  change can bring two closer; the times around each change are walked. */
export function checkRepeat(cron: string, timezone: string, fromMs: number): void {
  nextDue(cron, timezone, new Date(fromMs));
  const tooClose = () => new CalendarRefusal("A repeat may be due at most once an hour.");
  const minute = cron.trim().split(/\s+/)[0] ?? "";
  // Several minutes (a list, a range, a step, *) are due alike in every hour
  // the cron matches. The first may be an hour's last one; the next 60 times
  // hold a whole matching hour after it.
  if (!/^\d{1,2}$/.test(minute)) {
    const times = dueTimesAfter(cron, timezone, new Date(fromMs), Number.MAX_SAFE_INTEGER, 61);
    for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! < CALENDAR_LIMITS.minGapMs) throw tooClose();
  }
  let before = offsetMinutes(fromMs, timezone);
  for (let day = 1; day <= HORIZON_MS / DAY_MS; day++) {
    const ms = fromMs + day * DAY_MS;
    const after = offsetMinutes(ms, timezone);
    if (after === before) continue;
    before = after;
    const times = dueTimesAfter(cron, timezone, new Date(ms - DAY_MS - 3 * 3_600_000), ms + 3 * 3_600_000, 200);
    for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! < CALENDAR_LIMITS.minGapMs) throw tooClose();
  }
}

export interface CalendarRule {
  atMs: number | null;
  cron: string | null;
  timezone: string;
  /** The last day it may be due, whole, in its zone. */
  untilDay: string | null;
}

/** Longer than any clock change (two hours at most): see dueTimesBetween. */
const GAP_LEAD_MS = 3 * 3_600_000;

/** Every time the rule is due from `fromMs` (inclusive) to `toMs` (exclusive),
 *  at most `max` of them. A time in a clock change's gap (02:30 on a spring
 *  night) croner moves to after the gap only when it walks from before the
 *  gap; walked from the moved time itself it finds the next day's. So the
 *  walk starts earlier by more than any gap, and the times before `fromMs`
 *  are dropped: a moved time is found from wherever the caller stands. */
export function dueTimesBetween(rule: CalendarRule, fromMs: number, toMs: number, max = MAX_TIMES): number[] {
  if (rule.cron === null) return rule.atMs !== null && rule.atMs >= fromMs && rule.atMs < toMs ? [rule.atMs] : [];
  const end = rule.untilDay === null ? toMs : Math.min(toMs, dayStart(nextDay(rule.untilDay), rule.timezone));
  // At most hourly: three hours of lead hold at most three times before fromMs.
  const walked = dueTimesAfter(rule.cron, rule.timezone, new Date(fromMs - GAP_LEAD_MS - 1), end, max + 3);
  return walked.filter((t) => t >= fromMs).slice(0, max);
}

/** The rule's first times after `ms` (exclusive), at most `max`, its until
 *  respected; none when it is over. */
export function dueTimesAfterMs(rule: CalendarRule, ms: number, max: number): number[] {
  return dueTimesBetween(rule, ms + 1, Number.MAX_SAFE_INTEGER, max);
}

const DAY_FORMAT = new Map<string, Intl.DateTimeFormat>();

/** The day `ms` falls on in the zone, as YYYY-MM-DD. */
export function dayOf(ms: number, timezone: string): string {
  let format = DAY_FORMAT.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    DAY_FORMAT.set(timezone, format);
  }
  return format.format(ms);
}

function parseDay(text: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) {
    const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const back = new Date(Date.UTC(y, m - 1, d));
    if (back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d) return { y, m, d };
  }
  throw new CalendarRefusal("Give days as YYYY-MM-DD.");
}

/** Whether the text is a real day written YYYY-MM-DD. */
export function isDay(text: string): boolean {
  try {
    parseDay(text);
    return true;
  } catch {
    return false;
  }
}

/** The day after, as YYYY-MM-DD. */
export function nextDay(text: string): string {
  const { y, m, d } = parseDay(text);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** When the day begins in the zone: the first local midnight of that date
 *  (croner finds it, daylight saving included). */
export function dayStart(text: string, timezone: string): number {
  const { y, m, d } = parseDay(text);
  return nextDue(`0 0 ${d} ${m} *`, timezone, new Date(Date.UTC(y, m - 1, d) - 2 * DAY_MS)).getTime();
}
