import type { Database } from "bun:sqlite";

export const MIGRATION_SKIP_ENV = "MANDATE_SKIP_MIGRATIONS";

export interface Migration {
  /** Globally unique and never changed once committed. It is the primary key in
   *  schema_migrations, so editing it re-runs the migration on every database
   *  that already applied it. Convention: "<module>/<date>-<short-description>". */
  id: string;
  /** Runs inside a transaction the runner owns. Must not call begin/commit.
   *
   *  Must be synchronous. The type cannot say so — TypeScript's void-return
   *  rule accepts an `async` body wherever `=> void` is declared — so the
   *  runner throws if up() returns a thenable. It has no way to await one, and
   *  an unawaited body would run after the transaction had already committed
   *  and recorded the id. bun:sqlite is synchronous; there is nothing to await.
   *
   *  Foreign keys are enforced and cannot be turned off from in here. The
   *  schema sets `pragma foreign_keys = on` every start, and inside an open
   *  transaction — which the runner always holds — `pragma foreign_keys` is a
   *  documented no-op that neither errors nor takes effect (`defer_foreign_keys`
   *  does not substitute). Two consequences:
   *   - Deleting from a parent table cascades to its children. If that is not
   *     what the transform wants, delete the child rows explicitly first, or
   *     rewrite them, rather than relying on an FK switch.
   *   - Removing a column: use `alter table <t> drop column <c>`, which works
   *     inside the transaction (bun ships SQLite 3.51). The 12-step rebuild
   *     recipe — create new / copy / drop old / rename — fails here on any
   *     FK-referenced table, because that recipe needs FK enforcement off. A
   *     type or constraint change on such a table needs a mechanism outside
   *     this runner. */
  up(db: Database): void;
}

/** One-shot migrations for the things convergent DDL cannot express: data
 *  transforms and column drops. Runs after initializeDatabaseSchema so the
 *  schema is already converged. Table rebuilds are not in reach here — see the
 *  foreign-key note on Migration.up. */
export function runPendingMigrations(db: Database, migrations: Migration[]): void {
  assertUniqueIds(migrations);
  db.exec(`
    create table if not exists schema_migrations (
      id         text primary key,
      applied_at text not null
    )
  `);

  const applied = new Set(
    (db.prepare("select id from schema_migrations").all() as Array<{ id: string }>)
      .map((row) => row.id)
  );
  const skipped = parseSkipList(process.env[MIGRATION_SKIP_ENV]);

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    if (skipped.has(migration.id)) {
      // Deliberately not recorded: skipping is an escape hatch, not a way to
      // mark the problem solved. Dropping the env var retries it.
      console.warn(`[mandate] skipping migration ${migration.id} (${MIGRATION_SKIP_ENV})`);
      continue;
    }
    runOne(db, migration);
  }
}

function runOne(db: Database, migration: Migration): void {
  const apply = db.transaction(() => {
    const result: unknown = migration.up(db);
    if (
      result !== null && typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      // `up` is declared `=> void`, but TypeScript's void-return rule lets an
      // `async` body satisfy that, so this compiles clean and nothing warns.
      // Thrown from inside the transaction so it rolls back and the id is not
      // recorded — without this the insert below would land first and the
      // migration would be marked done with none of its work applied.
      throw new Error(
        `migration ${migration.id} returned a promise — up() must be synchronous; ` +
        "the runner cannot await it, so its work would land outside the transaction"
      );
    }
    if (!db.inTransaction) {
      // The migration committed the runner's transaction itself, so its work is
      // already durable and nothing here can undo it. Refuse to record the id
      // anyway: a recorded id would mark a half-applied migration as done and
      // it would never be retried.
      //
      // This covers the stray-`commit` shape, not transaction control in
      // general: it tests whether a transaction is open, not whether the open
      // one is still the runner's. A migration that commits and then begins a
      // fresh transaction restores inTransaction and slips through. Accepted —
      // that takes a doubly-wrong migration, and telling the two apart is
      // disproportionate to the risk.
      throw new Error(
        `migration ${migration.id} committed the runner's transaction itself — ` +
        "migrations must not call begin/commit"
      );
    }
    db.prepare("insert into schema_migrations (id, applied_at) values (?, ?)")
      .run(migration.id, new Date().toISOString());
  });
  // No post-commit `db.inTransaction` check here: after apply() returns, a still
  // open transaction belongs to the caller (bun nests this one as a savepoint),
  // not to the migration. The check above is the enforcement point — it runs
  // while the runner's own transaction should still be open, so it catches the
  // violation instead of the caller.
  try {
    apply();
  } catch (cause) {
    throw new Error(failureMessage(db, migration.id, cause), { cause });
  }
}

/** Advice text, never executed here: the sqlite3 line is for a human to paste.
 *  The runner's own insert binds its parameters. */
function failureMessage(db: Database, id: string, cause: unknown): string {
  const path = db.filename;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return [
    `migration failed: ${id}`,
    `  database: ${path}`,
    `  cause: ${reason}`,
    "",
    "  To skip it and start anyway:",
    `    ${MIGRATION_SKIP_ENV}=${id}`,
    "  Or mark it applied permanently:",
    // Quoted: the path comes from MANDATE_DATA_DIR verbatim, and a space in it
    // is ordinary on macOS. The line's whole value is being pasteable as-is.
    `    sqlite3 "${path}" "insert into schema_migrations (id, applied_at) ` +
      `values ('${id}', datetime('now'))"`
  ].join("\n");
}

function parseSkipList(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value.split(",").map((id) => id.trim()).filter((id) => id.length > 0)
  );
}

function assertUniqueIds(migrations: Migration[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(`duplicate migration id: ${migration.id}`);
    }
    seen.add(migration.id);
  }
}
