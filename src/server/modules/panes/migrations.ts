import type { Database } from "bun:sqlite";
import type { Migration } from "../../platform/db/migrations.js";

function hasColumn(db: Database, table: string, column: string): boolean {
  // db.prepare(...), not db.query(...): this repo's hand-rolled bun:sqlite
  // ambient type (src/server/server-env.d.ts) only declares prepare/exec/
  // transaction/close, matching the convention in ensure-column.ts and
  // memory/schema.ts's own pragma table_info check.
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/** `host_id` is a member of the composite primary key `(host_id, pane_id)`, and
 *  SQLite refuses `alter table … drop column` for a primary-key column, so the
 *  table has to be rebuilt. The runner's own note warns that a rebuild fails
 *  here on any FK-involved table, because the recipe needs foreign keys off and
 *  they cannot be turned off inside the transaction it holds. This table is the
 *  exception the note allows for: it declares no `references` and no other table
 *  references it, so nothing cascades and the rebuild is safe as written. */
export const panesMigrations: Migration[] = [
  {
    id: "panes/2026-08-03-drop-pane-host-id",
    up: (db) => {
      // Not for idempotency — schema_migrations already guarantees one run per
      // database. This guards the *fresh* database, whose converged schema never
      // had the column: the copy step's select list never names host_id, so
      // without this guard a fresh install would not fail — it would just
      // pointlessly drop and rebuild a table it had no reason to touch, and this
      // migration would stop being a no-op there.
      if (!hasColumn(db, "pane_metadata", "host_id")) return;
      db.exec(`
        create table pane_metadata_new (
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
      // Every host_id in the wild is 'local' and pane ids do not repeat across
      // hosts, so this cannot lose a row to the narrower key. Ordered so a
      // hypothetical duplicate keeps the most recently updated one rather than
      // whichever the scan reached first.
      db.exec(`
        insert or replace into pane_metadata_new
          (pane_id, feature_id, session_name, window_name, name, description,
           created_by_thread_id, created_at, updated_at)
        select pane_id, feature_id, session_name, window_name, name, description,
               created_by_thread_id, created_at, updated_at
        from pane_metadata
        order by updated_at asc
      `);
      db.exec("drop table pane_metadata");
      db.exec("alter table pane_metadata_new rename to pane_metadata");
      // Dropping the old table dropped its indexes with it. Recreate with the
      // original two-column definition, not just (feature_id).
      db.exec(`
        create index if not exists idx_pane_metadata_feature
          on pane_metadata(feature_id, updated_at desc)
      `);
    }
  }
];
