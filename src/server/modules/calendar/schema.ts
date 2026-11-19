import type { Database } from "bun:sqlite";

/** The personal agent's calendar: its entries, what became of each time one
 *  came due, and what the user changed on the page. Times are epoch ms. No
 *  CHECK constraints: SQLite cannot alter one later, and the service is the
 *  only writer. A deleted entry is kept, marked, for the agent to be told. */
export function initializeCalendarSchema(db: Database): void {
  db.exec(`
    create table if not exists calendar_entries (
      id           text primary key,
      title        text not null,
      note         text not null,
      at_ms        integer,
      cron         text,
      timezone     text not null,
      until_day    text,
      paused_at    integer,
      paused_by    text,
      skips_json   text not null default '[]',
      next_due_ms  integer,
      created_at   integer not null,
      updated_at   integer not null,
      deleted_at   integer,
      deleted_by   text
    )
  `);
  db.exec("create index if not exists idx_calendar_entries_due on calendar_entries(next_due_ms) where deleted_at is null");
  db.exec(`
    create table if not exists calendar_times (
      id            integer primary key autoincrement,
      entry_id      text not null,
      due_ms        integer not null,
      outcome       text not null,
      delivered_ms  integer,
      recorded_at   integer not null
    )
  `);
  db.exec("create index if not exists idx_calendar_times_entry on calendar_times(entry_id, due_ms)");
  db.exec("create index if not exists idx_calendar_times_due on calendar_times(due_ms)");
  db.exec(`
    create table if not exists calendar_changes (
      id        integer primary key autoincrement,
      entry_id  text not null,
      kind      text not null,
      by        text not null,
      at        integer not null,
      due_ms    integer
    )
  `);
  db.exec("create index if not exists idx_calendar_changes_at on calendar_changes(at)");
}
