import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  managerResourcesDir,
  migrateOverviewResourcesDir
} from "../src/server/platform/fs/resources.js";

test("managerResourcesDir points at resources/global/manager", () => {
  expect(managerResourcesDir("/tmp/md-data")).toBe(
    "/tmp/md-data/resources/global/manager"
  );
});

test("migrateOverviewResourcesDir moves the old overview bucket once, idempotently", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mandate-res-"));
  try {
    const oldDir = path.join(tmp, "resources", "global", "overview");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "x.txt"), "hello");

    migrateOverviewResourcesDir(tmp);

    const newFile = path.join(tmp, "resources", "global", "manager", "x.txt");
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(false);

    // Second call is a no-op: nothing moves, nothing throws.
    migrateOverviewResourcesDir(tmp);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("migrateOverviewResourcesDir is a no-op when neither dir exists", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mandate-res-"));
  try {
    migrateOverviewResourcesDir(tmp);
    expect(fs.existsSync(path.join(tmp, "resources"))).toBe(false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
