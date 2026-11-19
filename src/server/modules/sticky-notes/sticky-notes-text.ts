import { dayClock } from "../activity/local-days.js";
import type { StickyNoteDto, StickyNoteKind } from "../../../shared/api/sticky-notes.js";

/** How the agent's texts of notes are written: in the machine's zone, now. */
export interface StickyNoteTextClock {
  timeZone: string;
  now: number;
}

/** Each kind as the user's page names it: the agent reads the same words. */
export const STICKY_NOTE_KIND_WORD: Record<StickyNoteKind, string> = { alert: "Alert", check: "To check", fyi: "FYI", later: "Later" };

/** How many days back the notes the user finished are listed, and how many at most. */
export const DONE_LATELY = { days: 3, max: 10 } as const;

/** "15:06" today in the zone, "Nov 10 15:06" another day. */
function when(iso: string, clock: StickyNoteTextClock): string {
  const days = dayClock(clock.timeZone);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: clock.timeZone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}`;
  return days.dayOf(iso) === days.dayOf(new Date(clock.now).toISOString()) ? time : `${get("month")} ${get("day")} ${time}`;
}

/** One open note on one line, as the runtime context and the tool's answers give it. */
export function renderStickyNoteLine(note: StickyNoteDto, clock: StickyNoteTextClock): string {
  const parts = [`\`${note.id}\` ${STICKY_NOTE_KIND_WORD[note.kind]}`, `"${note.title}"`];
  if (note.about) parts.push(`${note.about.kind} "${note.about.title}"`);
  const left = `left ${when(note.createdAt, clock)}`;
  parts.push(note.updatedAt !== note.createdAt ? `${left}, updated ${when(note.updatedAt, clock)}` : left);
  if (note.doneAt) parts.push(note.doneBy === "agent" ? `removed ${when(note.doneAt, clock)}` : `done ${when(note.doneAt, clock)}`);
  else parts.push(note.seen ? "seen" : "not seen yet");
  return parts.join(" · ");
}

/** The runtime context's Sticky notes section: the open notes, then those the user finished lately. */
export function renderStickyNotesSection(open: readonly StickyNoteDto[], doneLately: readonly StickyNoteDto[], clock: StickyNoteTextClock): string {
  const lines = open.length > 0 ? open.map((note) => `- ${renderStickyNoteLine(note, clock)}`) : ["None open."];
  const done = doneLately.slice(0, DONE_LATELY.max);
  if (done.length > 0) lines.push(`Done by the user lately: ${done.map((note) => `"${note.title}" (done ${when(note.doneAt!, clock)})`).join(", ")}`);
  return lines.join("\n");
}

/** The section as the runtime context gives it, read from the notes now. */
export function stickyNotesSection(notes: { open(): StickyNoteDto[]; doneSince(ms: number): StickyNoteDto[] }, clock: StickyNoteTextClock): string {
  return renderStickyNotesSection(notes.open(), notes.doneSince(clock.now - DONE_LATELY.days * 24 * 60 * 60 * 1000), clock);
}
