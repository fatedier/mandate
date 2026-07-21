import type { Database } from "bun:sqlite";
import { getMandateModules } from "../../modules/registry.js";
import type { MandateModule } from "../../modules/module.js";
import type { Migration } from "./migrations.js";

export function initializeDatabaseSchema(db: Database): void {
  for (const module of getMandateModules()) {
    for (const initialize of module.schema ?? []) {
      initialize(db);
    }
  }
}

/** Flattened in registry order, then module array order, so the sequence is
 *  deterministic across restarts. The parameter exists so the flattening can be
 *  tested against a fixed module list — asserting over the real registry is
 *  vacuous until a module declares its first migration.
 *
 *  Cross-module ordering dependencies are not supported. MODULES is ordered for
 *  route mounting, and reordering it for an unrelated reason silently changes
 *  the order migrations run in on a fresh database. A migration must therefore
 *  stand on its own against the converged schema, never on another module's
 *  migration having run first. */
export function collectModuleMigrations(
  modules: readonly MandateModule[] = getMandateModules()
): Migration[] {
  const migrations: Migration[] = [];
  for (const module of modules) {
    migrations.push(...(module.migrations ?? []));
  }
  return migrations;
}
