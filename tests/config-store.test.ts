import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createConfigStore, secureConfigFile } from "../src/server/config/config-store.js";
import { tempDir } from "./helpers/temp.js";

// config.json holds API keys and tokens: only its owner may read it.
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

test("a write leaves config.json readable by its owner alone", () => {
  const dir = tempDir("md-config-mode-");
  createConfigStore(dir).write({ logging: { level: "info" } });
  expect(modeOf(path.join(dir, "config.json"))).toBe(0o600);
});

test("one that others could read is made its owner's alone; none is not made", () => {
  const dir = tempDir("md-config-mode-");
  const file = path.join(dir, "config.json");
  secureConfigFile(file);
  expect(fs.existsSync(file)).toBe(false);
  fs.writeFileSync(file, "{}", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  secureConfigFile(file);
  expect(modeOf(file)).toBe(0o600);
});

// A config.json the server can read but not change the mode of (a symlink
// into a read-only store, a read-only mount, a file of another user): the
// server starts all the same and says why the mode stayed.
test.skipIf(process.getuid?.() === 0)("a file whose mode cannot be changed is left as it is, with a warning, not a failed start", () => {
  const dir = tempDir("md-config-mode-");
  const file = path.join(dir, "config.json");
  fs.symlinkSync("/etc/hosts", file);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    expect(() => secureConfigFile(file)).not.toThrow();
  } finally {
    console.warn = warn;
  }
  expect(warned).toHaveLength(1);
  expect(warned[0]).toStartWith(`[mandate] ${file} could not be made readable by its owner alone (`);
});
