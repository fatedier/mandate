import type { Database } from "bun:sqlite";

/** Add a column only when it is missing, so schema initialisation stays
 *  idempotent across restarts. `definition` is the type and constraints only —
 *  the column name is supplied separately. Five module schemas used to carry
 *  private copies of this with two different conventions, one of which repeated
 *  the name inside `definition`; this helper takes the name-free form and
 *  rejects the other outright.
 *
 *  The rejection has to be explicit: SQLite parses a type name as a run of
 *  words, so `add column label label text` is not a syntax error — it quietly
 *  creates `label` with the two-word type `label text`. Left unguarded, mixing
 *  the conventions would corrupt declared types instead of failing. The guard
 *  costs the (unused) ability to declare a column whose type equals its name. */
export function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string
): void {
  const firstWord = definition.trimStart().split(/\s+/, 1)[0] ?? "";
  if (firstWord.toLowerCase() === column.toLowerCase()) {
    throw new Error(
      `ensureColumn(${table}.${column}): definition must carry the type and constraints only, `
        + `but it repeats the column name: ${JSON.stringify(definition)}`
    );
  }
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${definition}`);
}
