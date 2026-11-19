import type { CalendarEntryDto, CalendarTimeDto } from "@shared/api/calendar";
import { untilLabel, viewerZone } from "./calendar-dates";

/** A time as the page keys it: the entry and when. */
export const timeKey = (time: Pick<CalendarTimeDto, "entryId" | "at">): string => `${time.entryId}@${time.at}`;

/** The repeat in words, in its own zone (named when it is not the viewer's), with its end. */
export function repeatText(entry: CalendarEntryDto, zone: string = viewerZone()): string | null {
  if (!entry.repeat) return null;
  const tz = entry.repeat.timezone === zone ? "" : ` (${entry.repeat.timezone})`;
  const until = entry.repeat.until ? ` · until ${untilLabel(entry.repeat.until)}` : "";
  return `${entry.repeat.words}${tz}${until}`;
}

/** Past: its time has come, or it was delivered or missed already. */
export const isPast = (time: CalendarTimeDto, now: number): boolean => time.at <= now || time.outcome === "delivered" || time.outcome === "missed";
