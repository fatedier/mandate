import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MandateStore } from "../../src/server/app/store.js";

let template: Uint8Array | null = null;

/** The database a fresh store makes, built once in this process and kept as
 *  its bytes (its folder goes at once: a test process can end without running
 *  exit handlers). A store's start-up runs every module's create statements,
 *  each a commit to disk, and a full run makes thousands of stores (96 s of
 *  the run's time). */
function templateBytes(): Uint8Array {
  if (template) return template;
  const dir = mkdtempSync(path.join(os.tmpdir(), "md-store-template-"));
  try {
    const store = new MandateStore(dir);
    // Everything in the main file, so its image alone is the whole database.
    store.db.exec("pragma wal_checkpoint(truncate)");
    template = store.db.serialize();
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return template;
}

/** A MandateStore on `dir`, started from a copy of the database a fresh store
 *  makes; a directory that already holds a database opens that one as it is.
 *  The store's own start-up still runs on it, so what it does to a database it
 *  opens is done here too. */
export function testStore(dir: string): MandateStore {
  const file = path.join(dir, "mandate.db");
  if (!existsSync(file)) writeFileSync(file, templateBytes());
  return new MandateStore(dir);
}
