import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  collectModuleMigrations,
  initializeDatabaseSchema
} from "../src/server/platform/db/schema.js";
import { runPendingMigrations } from "../src/server/platform/db/migrations.js";
import { getMandateModules } from "../src/server/modules/registry.js";
import { MandateStore } from "../src/server/app/store.js";
import type { MandateModule } from "../src/server/modules/module.js";

// Feed the collector a fake module list to test the flattening itself, so the
// expected order stays fixed as real modules declare migrations of their own,
// and keep one test against the real registry for the properties of its ids.
function fakeModules(): MandateModule[] {
  return [
    { id: "alpha", migrations: [
      { id: "alpha/one", up: () => {} },
      { id: "alpha/two", up: () => {} }
    ] },
    { id: "beta" },
    { id: "gamma", migrations: [{ id: "gamma/one", up: () => {} }] }
  ];
}

test("collectModuleMigrations: flattens in registry order, then array order", () => {
  const ids = collectModuleMigrations(fakeModules()).map((migration) => migration.id);
  expect(ids).toEqual(["alpha/one", "alpha/two", "gamma/one"]);
});

test("collectModuleMigrations: a module without migrations contributes nothing", () => {
  const ids = collectModuleMigrations([{ id: "beta" }]).map((migration) => migration.id);
  expect(ids).toEqual([]);
});

test("collectModuleMigrations: the real registry has unique, module-prefixed ids", () => {
  // The id is a database primary key shared across modules, so a missing
  // prefix or a collision would let one module silently mark another's
  // migration applied.
  const migrations = collectModuleMigrations();
  const ids = migrations.map((migration) => migration.id);
  expect(ids.length).toBe(new Set(ids).size);
  // Tied to the declaring module, not merely to the shape: the prefix exists so
  // each module owns its slice of that shared key, which a memory/* id declared
  // by the agent module would defeat while still matching a generic pattern.
  const misprefixed = getMandateModules().flatMap((module) =>
    (module.migrations ?? [])
      .filter((migration) => !migration.id.startsWith(`${module.id}/`))
      .map((migration) => `${module.id} declares ${migration.id}`)
  );
  expect(misprefixed).toEqual([]);
});

test("the collected migrations apply cleanly to a fresh database", () => {
  const db = new Database(":memory:");
  // Converge the schema first, exactly as the store does. A migration is a
  // transform over tables the convergent DDL creates, so running one against a
  // bare database would throw for a reason that is not a defect.
  initializeDatabaseSchema(db);
  expect(() => runPendingMigrations(db, collectModuleMigrations())).not.toThrow();
  const applied = db.prepare("select count(*) c from schema_migrations").get() as { c: number };
  expect(applied.c).toBe(collectModuleMigrations().length);
});

test("opening a MandateStore runs the migrations", () => {
  // Guards the one line that makes migrations run at startup. Without the
  // runner call in the constructor, schema_migrations is never created.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-migrations-"));
  try {
    const store = new MandateStore(dir);
    const table = store.db
      .prepare("select name from sqlite_master where type = 'table' and name = 'schema_migrations'")
      .get() as { name: string } | null;
    expect(table?.name).toBe("schema_migrations");
    const applied = store.db
      .prepare("select count(*) c from schema_migrations")
      .get() as { c: number };
    expect(applied.c).toBe(collectModuleMigrations().length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
