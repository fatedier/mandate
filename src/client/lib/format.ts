export function compactPath(value: unknown): string {
  const path = String(value ?? "").replace(/\\/g, "/");
  if (!path) return "";
  return path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/var\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/, "~");
}

/** How long ago, for the last week ("5m ago", "2d ago"); past that, the date
 *  says when — "105d ago" takes arithmetic to place. */
export function formatRelativeTime(timestamp: unknown, now: number = Date.now()): string {
  if (timestamp == null || timestamp === 0 || timestamp === "") return "";
  const time =
    typeof timestamp === "string" ? Date.parse(timestamp) : Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return "";
  const diffMs = now - time;
  if (diffMs < 60_000) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatCalendarDate(time, now);
}

// Pinned rather than `undefined`, which resolves to the browser's locale. Two
// things went wrong with that: the width drifted between 8 and 11 characters
// (`18:03:47` vs `06:03:47 PM`) in a row that is already fighting for space
// when the dock is narrow, and the same instant read differently on two
// machines. `hourCycle: "h23"` is what pins the width; the locale only picks
// the separators.
const DATE_TIME_LOCALE = "en-GB";
// Dates are month-first and spelled ("Oct 8"), never numeric — `02/08` means
// two different days to two readers. en-US, not en-GB: en-GB writes "8 Oct"
// and spells September "Sept", the one four-letter month.
const DATE_LOCALE = "en-US";

/** Hours and minutes, 24-hour: the transcript's dividers. A row's own time,
 *  to the second, is its title (formatDateTimeTitle). */
export function formatClockMinutes(timestamp: unknown): string {
  const time = timestampToNumber(timestamp);
  if (time === null) return "";
  return new Intl.DateTimeFormat(DATE_TIME_LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(time));
}

export function formatClockTime(timestamp: unknown): string {
  const time = timestampToNumber(timestamp);
  if (time === null) return "";
  return new Intl.DateTimeFormat(DATE_TIME_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(new Date(time));
}

/** The one way a date is written: "Oct 8", with the year only when it is not
 *  this one ("Oct 8, 2025"). */
export function formatCalendarDate(timestamp: unknown, now: number = Date.now()): string {
  const time = timestampToNumber(timestamp);
  if (time === null) return "";
  return formatDate(new Date(time), now);
}

/** A day key ("2026-09-07") as a date. Read as that calendar day, not as an
 *  instant: an instant at UTC midnight is the day before west of Greenwich. */
export function formatCalendarDay(day: string, now: number = Date.now()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return "";
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const local = new Date(year, month - 1, date);
  if (local.getMonth() !== month - 1 || local.getDate() !== date) return "";
  return formatDate(local, now);
}

function formatDate(date: Date, now: number): string {
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    month: "short",
    day: "numeric",
    year: thisYear ? undefined : "numeric"
  }).format(date);
}

/** A date with its time, in text: "Sep 27 · 15:47". The second and this
 *  year's year are for titles (formatDateTimeTitle). */
export function formatDateTime(timestamp: unknown, now: number = Date.now()): string {
  const date = formatCalendarDate(timestamp, now);
  return date ? `${date} · ${formatClockMinutes(timestamp)}` : "";
}

/** A row's own time, in its title: always with the year, and the clock to the
 *  second — the same clock the dividers show to the minute. */
export function formatDateTimeTitle(timestamp: unknown): string {
  const time = timestampToNumber(timestamp);
  if (time === null) return "";
  const date = new Intl.DateTimeFormat(DATE_LOCALE, { month: "short", day: "numeric", year: "numeric" }).format(new Date(time));
  return `${date}, ${formatClockTime(time)}`;
}

export function formatDuration(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1) return "<1ms";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(n / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

/** A clock that ticks: whole seconds under a minute ("12s", not "12.3s"),
 *  then as formatDuration writes it ("1m 05s", "1h 02m"). */
export function formatElapsedClock(ms: number): string {
  const n = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (n < 60_000) return `${Math.floor(n / 1000)}s`;
  return formatDuration(n);
}

/** A `<time>` that carries a duration needs a machine duration in `dateTime`,
 *  not a clock time. HTML's valid-duration grammar allows a fractional seconds
 *  component, so milliseconds map onto `PT<seconds>S` without rounding. */
export function formatDurationAttribute(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  return `PT${n / 1000}S`;
}

function timestampToNumber(timestamp: unknown): number | null {
  if (timestamp == null || timestamp === 0 || timestamp === "") return null;
  const time =
    typeof timestamp === "string" ? Date.parse(timestamp) : Number(timestamp);
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** A size as the chat shows one: "512 B", "212.0 KB", "3.4 MB". */
export function formatByteSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "unknown size";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
