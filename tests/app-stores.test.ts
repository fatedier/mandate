import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createAppStores } from "../src/server/app/stores.js";
import { withTempDataDir } from "./helpers/fixtures.js";
import { tempDir } from "./helpers/temp.js";

test("the database lives in the data dir, whatever MANDATE_DB_DIR says", () => {
  const data = withTempDataDir();
  const elsewhere = tempDir("md-db-elsewhere-");
  const before = process.env.MANDATE_DB_DIR;
  process.env.MANDATE_DB_DIR = elsewhere;
  try {
    const stores = createAppStores();
    try {
      expect(stores.dbDir).toBe(data.dataDir);
      expect([fs.existsSync(path.join(data.dataDir, "mandate.db")), fs.existsSync(path.join(elsewhere, "mandate.db"))]).toEqual([true, false]);
    } finally {
      stores.store.db.close();
    }
  } finally {
    if (before === undefined) delete process.env.MANDATE_DB_DIR;
    else process.env.MANDATE_DB_DIR = before;
    data.restore();
  }
});
