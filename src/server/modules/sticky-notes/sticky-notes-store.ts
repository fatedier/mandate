import type { Database } from "bun:sqlite";
import type { StickyNoteKind } from "../../../shared/api/sticky-notes.js";

export interface StickyNoteRow {
  id: string;
  title: string;
  body: string;
  kind: StickyNoteKind;
  aboutKind: "thread" | "task" | null;
  aboutId: string | null;
  aboutTitle: string | null;
  createdAt: string;
  updatedAt: string;
  seenAt: string | null;
  doneAt: string | null;
  doneBy: "user" | "agent" | null;
  reason: string | null;
  /** Rises with every change but a look: the order of the wall and the Done list. */
  changeSeq: number;
}

const COLUMNS: Record<keyof StickyNoteRow, string> = {
  id: "id", title: "title", body: "body", kind: "kind", aboutKind: "about_kind", aboutId: "about_id", aboutTitle: "about_title",
  createdAt: "created_at", updatedAt: "updated_at",
  seenAt: "seen_at", doneAt: "done_at", doneBy: "done_by", reason: "reason", changeSeq: "change_seq"
};

const SELECT = `select ${Object.entries(COLUMNS).map(([key, column]) => `${column} as ${key}`).join(", ")} from sticky_notes`;

/** Moves rows: no rules, no events (the service has both). */
export class StickyNotesStore {
  constructor(private readonly db: Database) {}

  insert(row: StickyNoteRow): void {
    const keys = Object.keys(COLUMNS) as Array<keyof StickyNoteRow>;
    this.db.prepare(`insert into sticky_notes (${keys.map((k) => COLUMNS[k]).join(", ")}) values (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((k) => row[k]));
  }

  get(id: string): StickyNoteRow | null {
    return (this.db.prepare(`${SELECT} where id = ?`).get(id) as StickyNoteRow | null) ?? null;
  }

  update(id: string, change: Partial<Omit<StickyNoteRow, "id">>): void {
    const keys = Object.keys(change) as Array<keyof Omit<StickyNoteRow, "id">>;
    if (keys.length === 0) return;
    this.db.prepare(`update sticky_notes set ${keys.map((k) => `${COLUMNS[k]} = ?`).join(", ")} where id = ?`)
      .run(...keys.map((k) => change[k] ?? null), id);
  }

  /** The next change's place in the order. */
  nextChange(): number {
    const row = this.db.prepare(`select coalesce(max(change_seq), 0) + 1 as seq from sticky_notes`).get() as { seq: number };
    return row.seq;
  }

  /** Last changed first. */
  listOpen(): StickyNoteRow[] {
    return this.db.prepare(`${SELECT} where done_at is null order by change_seq desc`).all() as StickyNoteRow[];
  }

  listDone(limit: number): StickyNoteRow[] {
    return this.db.prepare(`${SELECT} where done_at is not null order by change_seq desc limit ?`).all(limit) as StickyNoteRow[];
  }

  doneByUserSince(iso: string): StickyNoteRow[] {
    return this.db.prepare(`${SELECT} where done_at >= ? and done_by = 'user' order by change_seq desc`).all(iso) as StickyNoteRow[];
  }
}
