import type { Database } from "bun:sqlite";

export type SchemaInitializer = (db: Database) => void;

/** What this layer needs from whoever owns tables: the DDL that creates
 *  them. Structural on purpose — platform/ sits below modules/ and never
 *  imports the module registry; app/ passes the registered modules in, and a
 *  MandateModule satisfies this shape as it stands. */
interface SchemaContributor {
  readonly schema?: readonly SchemaInitializer[];
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
