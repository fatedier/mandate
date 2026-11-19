/** The zone the machine runs in: the one agents read times in. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset"
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** A time as agents read it: "Fri 2026-10-23 21:45 +08:00", in the given
 *  zone, to the minute, with the offset in force then. Null when it does
 *  not parse. */
export function formatAgentTime(at: string | number | Date, timeZone: string): string | null {
  const ms = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  // "GMT+08:00", or bare "GMT" at a zero offset.
  const offset = (parts.timeZoneName ?? "GMT").replace(/^GMT/, "") || "+00:00";
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${offset}`;
}
