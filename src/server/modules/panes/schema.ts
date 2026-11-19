import type { Database } from "bun:sqlite";

export function initializePanesSchema(db: Database): void {
  db.exec(`
    create table if not exists pane_metadata (
      pane_id              text primary key,
      worker_id           text,
      session_name         text,
      window_name          text,
      name                 text not null default '',
      description          text not null default '',
      created_at           text not null,
      updated_at           text not null
    )
  `);
  db.exec(`
    create index if not exists idx_pane_metadata_worker
      on pane_metadata(worker_id, updated_at desc)
  `);
}
