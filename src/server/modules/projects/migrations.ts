import type { Database } from "bun:sqlite";
import type { Migration } from "../../platform/db/migrations.js";

function hasColumn(db: Database, table: string, column: string): boolean {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/** `host_id` is an ordinary column here, not part of a key, so the plain
 *  `alter table … drop column` the runner recommends works — verified against a
 *  copy of the production database with foreign keys on, even though `features`
 *  references `projects`: DROP COLUMN does not need enforcement turned off. */
export const projectsMigrations: Migration[] = [
  {
    id: "projects/2026-08-03-drop-project-host-id",
    up: (db) => {
      // Guards the fresh database, whose converged schema never had the column.
      // Without this every new install fails to start on `no such column`.
      if (hasColumn(db, "projects", "host_id")) {
        db.exec("alter table projects drop column host_id");
      }
      // The hosts module is gone, so nothing recreates this table. Safe on a
      // fresh database, where it was never created in the first place.
      db.exec("drop table if exists hosts");
    }
  }
];
