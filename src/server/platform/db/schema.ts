import type { Database } from "bun:sqlite";
import type { Migration } from "./migrations.js";

export type SchemaInitializer = (db: Database) => void;

/** What this layer needs from whoever owns tables: convergent DDL and one-shot
 *  migrations. Structural on purpose — platform/ sits below modules/ and never
 *  imports the module registry; app/ passes the registered modules in, and a
 *  MandateModule satisfies this shape as it stands. */
export interface SchemaContributor {
  readonly schema?: readonly SchemaInitializer[];
  readonly migrations?: readonly Migration[];
}

export function initializeDatabaseSchema(
  db: Database,
  contributors: readonly SchemaContributor[]
): void {
  for (const contributor of contributors) {
    for (const initialize of contributor.schema ?? []) {
      initialize(db);
    }
  }
}

/** Flattened in the order given, then each contributor's array order, so the
 *  sequence is deterministic across restarts as long as the caller's list is.
 *
 *  Cross-module ordering dependencies are not supported. The registry is
 *  ordered for route mounting, and reordering it for an unrelated reason
 *  silently changes the order migrations run in on a fresh database. A
 *  migration must therefore stand on its own against the converged schema,
 *  never on another module's migration having run first. */
export function collectModuleMigrations(
  contributors: readonly SchemaContributor[]
): Migration[] {
  const migrations: Migration[] = [];
  for (const contributor of contributors) {
    migrations.push(...(contributor.migrations ?? []));
  }
  return migrations;
}
