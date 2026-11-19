/** Sticky notes: what the personal agent leaves for the user to read, kept on
 *  their Notes page until they mark it done. */

export const STICKY_NOTE_KINDS = ["alert", "check", "fyi", "later"] as const;
export type StickyNoteKind = typeof STICKY_NOTE_KINDS[number];

export function isStickyNoteKind(value: unknown): value is StickyNoteKind {
  return typeof value === "string" && (STICKY_NOTE_KINDS as readonly string[]).includes(value);
}

/** The most a note keeps of each field, in characters. */
export const STICKY_NOTE_LIMITS = { title: 120, body: 800, reason: 200, doneShown: 50 } as const;

/** The thread or task a note is about, named as it is now (or as it was, once gone). */
export interface StickyNoteAboutDto {
  kind: "thread" | "task";
  id: string;
  title: string;
}

export interface StickyNoteDto {
  id: string;
  title: string;
  body: string;
  kind: StickyNoteKind;
  about: StickyNoteAboutDto | null;
  createdAt: string;
  updatedAt: string;
  /** Rises with every change but a look: the wall's order, and what a look names as shown. */
  version: number;
  /** Shown to the user since it was written or last updated. */
  seen: boolean;
  doneAt: string | null;
  doneBy: "user" | "agent" | null;
  /** Why the agent took it off, when it did. */
  reason: string | null;
}

/** The open notes, newest change first, and the newest done ones. */
export interface StickyNotesDto {
  open: StickyNoteDto[];
  done: StickyNoteDto[];
}

export interface StickyNoteResponse {
  note: StickyNoteDto;
}

/** The notes shown to the user, each as it was shown (its version). */
export interface StickyNotesSeenBody {
  notes: Array<{ id: string; version: number }>;
}
