import type { Database } from "bun:sqlite";

export function initializePanesSchema(db: Database): void {
  db.exec(`
    create table if not exists pane_metadata (
      pane_id              text primary key,
      feature_id           text,
      session_name         text,
      window_name          text,
      name                 text not null default '',
      description          text not null default '',
      created_by_thread_id text,
      created_at           text not null,
      updated_at           text not null
    )
  `);
  db.exec(`
    create index if not exists idx_pane_metadata_feature
      on pane_metadata(feature_id, updated_at desc)
  `);
}
