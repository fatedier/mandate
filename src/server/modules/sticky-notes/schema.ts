import type { Database } from "bun:sqlite";

/** The personal agent's sticky notes for the user. No CHECK constraints: SQLite
 *  cannot alter one later, and the service is the only writer. What a note is
 *  about keeps the title it had when written, for a thread or task gone since.
 *  change_seq orders the notes by their last change: a timestamp ties within a millisecond. */
export function initializeStickyNotesSchema(db: Database): void {
  db.exec(`
    create table if not exists sticky_notes (
      id           text primary key,
      title        text not null,
      body         text not null,
      kind         text not null,
      about_kind   text,
      about_id     text,
      about_title  text,
      created_at   text not null,
      updated_at   text not null,
      seen_at      text,
      done_at      text,
      done_by      text,
      reason       text,
      change_seq   integer not null default 0
    )
  `);
  db.exec(`create index if not exists idx_sticky_notes_change on sticky_notes (done_at, change_seq)`);
}
