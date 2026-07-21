export function compactPath(value: unknown): string {
  const path = String(value ?? "").replace(/\\/g, "/");
  if (!path) return "";
  return path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/var\/home\/[^/]+(?=\/|$)/, "~")
    .replace(/^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/, "~");
}

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
  return `${diffDay}d ago`;
}

// Pinned rather than `undefined`, which resolves to the browser's locale. Two
// things went wrong with that: the width drifted between 8 and 11 characters
// (`18:03:47` vs `06:03:47 PM`) in a row that is already fighting for space
// when the dock is narrow, and the same instant read differently on two
// machines. `hourCycle: "h23"` is what pins the width; the locale only picks
// the separators. Month is spelled, never numeric — a chat read across
// timezones cannot afford `02/08` meaning two different days to two readers.
const DATE_TIME_LOCALE = "en-GB";

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

export function formatCalendarDate(timestamp: unknown): string {
  const time = timestampToNumber(timestamp);
  if (time === null) return "";
  return new Intl.DateTimeFormat(DATE_TIME_LOCALE, {
    year: "numeric",
    month: "short",
    day: "2-digit"
  }).format(new Date(time));
}

/** Composed from the two above rather than formatted in one pass, so the date a
 *  tooltip shows is character-identical to the date separator above the row and
 *  its clock is character-identical to the clock beside it. One vocabulary. */
export function formatDateTimeTitle(timestamp: unknown): string {
  const date = formatCalendarDate(timestamp);
  if (!date) return "";
  return `${date}, ${formatClockTime(timestamp)}`;
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
