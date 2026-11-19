import type { Database } from "bun:sqlite";
import { newId } from "../../platform/ids.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { isStickyNoteKind, STICKY_NOTE_LIMITS, type StickyNoteDto, type StickyNoteKind, type StickyNotesDto } from "../../../shared/api/sticky-notes.js";
import { StickyNotesStore, type StickyNoteRow } from "./sticky-notes-store.js";

/** A request refused: its message is what the caller is told (the agent reads these words). */
export class StickyNoteRefusal extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
  }
}

export const NO_OPEN_NOTE = "No open note with that id.";
export const NOTE_INCOMPLETE = "A note needs a title, a body and a kind.";
export const REASON_NEEDED = "Say in a few words why it goes: the user sees it.";

export type StickyNoteRef = { kind: "thread" | "task"; id: string };

export interface StickyNotesServiceDeps {
  db: Database;
  sse: Pick<AgentSseEmitter, "emit">;
  /** The thread's or task's title as it is now; null once it is gone. */
  about: (ref: StickyNoteRef) => string | null;
  now?: () => number;
}

export interface StickyNoteInput {
  title: string;
  body: string;
  kind: StickyNoteKind;
  threadId?: string | null;
  taskId?: string | null;
  /** What it is about, named as it is when written: kept for when it is gone. */
  aboutTitle?: string | null;
}

/** At most `max` characters (not UTF-16 units: a cut never splits a character). */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, " ").trim();

/**
 * The only writer of the notes. Every change runs in one transaction and is
 * told once (SSE) after it commits. A note is open until the user marks it
 * done or the agent removes it; either can be restored.
 */
export class StickyNotesService {
  private readonly store: StickyNotesStore;
  private readonly now: () => number;

  constructor(private readonly deps: StickyNotesServiceDeps) {
    this.store = new StickyNotesStore(deps.db);
    this.now = deps.now ?? (() => Date.now());
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private dto(row: StickyNoteRow): StickyNoteDto {
    const about = row.aboutKind && row.aboutId
      ? { kind: row.aboutKind, id: row.aboutId, title: this.deps.about({ kind: row.aboutKind, id: row.aboutId }) ?? row.aboutTitle ?? row.aboutId }
      : null;
    return {
      id: row.id, title: row.title, body: row.body, kind: row.kind, about,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      version: row.changeSeq,
      seen: row.seenAt !== null,
      doneAt: row.doneAt, doneBy: row.doneBy, reason: row.reason
    };
  }

  private write(id: string, change: () => void): StickyNoteDto {
    this.deps.db.transaction(change).immediate();
    const row = this.store.get(id);
    if (!row) throw new StickyNoteRefusal(NO_OPEN_NOTE, 404);
    const note = this.dto(row);
    this.deps.sse.emit(SSE_EVENTS.stickyNoteUpdated, { note });
    return note;
  }

  private openRow(id: string): StickyNoteRow {
    const row = this.store.get(id);
    if (!row || row.doneAt) throw new StickyNoteRefusal(NO_OPEN_NOTE, 404);
    return row;
  }

  private static aboutOf(input: { threadId?: string | null; taskId?: string | null }): Pick<StickyNoteRow, "aboutKind" | "aboutId"> | null {
    if (input.threadId) return { aboutKind: "thread", aboutId: input.threadId };
    if (input.taskId) return { aboutKind: "task", aboutId: input.taskId };
    return null;
  }

  add(input: StickyNoteInput): StickyNoteDto {
    const title = cut(oneLine(input.title ?? ""), STICKY_NOTE_LIMITS.title);
    const body = cut((input.body ?? "").trim(), STICKY_NOTE_LIMITS.body);
    if (!title || !body || !isStickyNoteKind(input.kind)) throw new StickyNoteRefusal(NOTE_INCOMPLETE);
    const at = this.iso();
    const about = StickyNotesService.aboutOf(input);
    const row: StickyNoteRow = {
      id: newId("note"), title, body, kind: input.kind,
      aboutKind: about?.aboutKind ?? null, aboutId: about?.aboutId ?? null, aboutTitle: about ? this.titleWhenWritten(about, input.aboutTitle) : null,
      createdAt: at, updatedAt: at, seenAt: null, doneAt: null, doneBy: null, reason: null, changeSeq: 0
    };
    return this.write(row.id, () => this.store.insert({ ...row, changeSeq: this.store.nextChange() }));
  }

  /** What is given replaces that field; the note is new to the user again. */
  update(id: string, change: Partial<StickyNoteInput>): StickyNoteDto {
    const before = this.openRow(id);
    // New again: an update clears the mark, so a look in the same millisecond cannot count as seeing it.
    const fields: Partial<Omit<StickyNoteRow, "id">> = { updatedAt: this.iso(), seenAt: null };
    if (change.title !== undefined) {
      const title = cut(oneLine(change.title), STICKY_NOTE_LIMITS.title);
      if (!title) throw new StickyNoteRefusal(NOTE_INCOMPLETE);
      fields.title = title;
    }
    if (change.body !== undefined) {
      const body = cut(change.body.trim(), STICKY_NOTE_LIMITS.body);
      if (!body) throw new StickyNoteRefusal(NOTE_INCOMPLETE);
      fields.body = body;
    }
    if (change.kind !== undefined) {
      if (!isStickyNoteKind(change.kind)) throw new StickyNoteRefusal(NOTE_INCOMPLETE);
      fields.kind = change.kind;
    }
    // A thread or task named replaces what it was about (the same one named
    // again, gone since, keeps the name it had); both given as null clear it.
    const about = StickyNotesService.aboutOf(change);
    if (about) {
      const same = about.aboutKind === before.aboutKind && about.aboutId === before.aboutId;
      Object.assign(fields, about, { aboutTitle: this.titleWhenWritten(about, change.aboutTitle) ?? (same ? before.aboutTitle : null) });
    } else if (change.threadId === null && change.taskId === null) {
      Object.assign(fields, { aboutKind: null, aboutId: null, aboutTitle: null });
    }
    return this.write(id, () => this.store.update(id, { ...fields, changeSeq: this.store.nextChange() }));
  }

  /** The thread's or task's name as it is now, kept with the note for when it is gone. */
  private titleWhenWritten(about: Pick<StickyNoteRow, "aboutKind" | "aboutId">, given: string | null | undefined): string | null {
    return given ?? this.deps.about({ kind: about.aboutKind!, id: about.aboutId! });
  }

  /** The agent takes an open note off, saying why. */
  remove(id: string, reason: string): StickyNoteDto {
    this.openRow(id);
    const why = cut(oneLine(reason ?? ""), STICKY_NOTE_LIMITS.reason);
    if (!why) throw new StickyNoteRefusal(REASON_NEEDED);
    return this.write(id, () => this.store.update(id, { doneAt: this.iso(), doneBy: "agent", reason: why, changeSeq: this.store.nextChange() }));
  }

  /** The user marks an open note done. */
  done(id: string): StickyNoteDto {
    this.openRow(id);
    return this.write(id, () => this.store.update(id, { doneAt: this.iso(), doneBy: "user", reason: null, changeSeq: this.store.nextChange() }));
  }

  /** A done note back on the wall, as it was, and seen. */
  restore(id: string): StickyNoteDto {
    const row = this.store.get(id);
    if (!row) throw new StickyNoteRefusal(NO_OPEN_NOTE, 404);
    if (!row.doneAt) return this.dto(row);
    return this.write(id, () => this.store.update(id, { doneAt: null, doneBy: null, reason: null, seenAt: this.iso(), changeSeq: this.store.nextChange() }));
  }

  /** The user was shown these, each as it was then (its version): an open one
   *  not seen yet is marked and told once. A look at an older version marks
   *  nothing: what changed since was not shown. */
  markSeen(shown: ReadonlyArray<{ id: string; version: number }>): void {
    for (const { id, version } of shown) {
      const row = this.store.get(id);
      if (!row || row.doneAt || row.seenAt !== null || row.changeSeq !== version) continue;
      this.write(id, () => this.store.update(id, { seenAt: this.iso() }));
    }
  }

  open(): StickyNoteDto[] {
    return this.store.listOpen().map((row) => this.dto(row));
  }

  list(): StickyNotesDto {
    return { open: this.open(), done: this.store.listDone(STICKY_NOTE_LIMITS.doneShown).map((row) => this.dto(row)) };
  }

  /** The notes the user marked done since then (not the agent's removals), newest first. */
  doneSince(ms: number): StickyNoteDto[] {
    return this.store.doneByUserSince(new Date(ms).toISOString()).map((row) => this.dto(row));
  }

  /** What a thread or task is called now; null once it is gone. */
  aboutTitle(ref: StickyNoteRef): string | null {
    return this.deps.about(ref);
  }

  get(id: string): StickyNoteDto | null {
    const row = this.store.get(id);
    return row ? this.dto(row) : null;
  }
}
