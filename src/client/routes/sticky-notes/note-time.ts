import { formatCalendarDate, formatClockMinutes } from "@/lib/format";
import type { StickyNoteDto } from "@shared/api/sticky-notes";

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "15:06" today, "Yesterday 04:27", a date further back ("Nov 10"). */
export function noteTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const day = new Date(time);
  const today = new Date(now);
  if (sameDay(day, today)) return formatClockMinutes(time);
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(day, yesterday)) return `Yesterday ${formatClockMinutes(time)}`;
  return formatCalendarDate(time, now);
}

/** When a note was written, or `Updated …` once the agent changed it. */
export function noteWhen(note: Pick<StickyNoteDto, "createdAt" | "updatedAt">, now: number = Date.now()): string {
  return note.updatedAt !== note.createdAt ? `Updated ${noteTime(note.updatedAt, now)}` : noteTime(note.createdAt, now);
}
