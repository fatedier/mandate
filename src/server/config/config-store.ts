import fs from "node:fs";
import path from "node:path";
import { JsonFileStore, type JsonStore } from "../platform/storage/json-store.js";
import { resolveDataDir } from "../platform/fs/data-dir.js";
import { isObject } from "./json.js";
import { errorText } from "../../shared/error-text.js";
import type { JsonObject } from "./types.js";

export function configPath(dir = resolveDataDir()) {
  return path.join(dir, "config.json");
}

/** What the store says of a file that holds JSON but not an object. */
export const CONFIG_NOT_AN_OBJECT = "config.json must contain an object";

/** config.json holds API keys and tokens: only its owner reads it. */
const CONFIG_MODE = 0o600;

export function createConfigStore(dir = resolveDataDir()): JsonStore<JsonObject> {
  return new JsonFileStore<JsonObject>({
    filePath: configPath(dir),
    defaultValue: () => ({}),
    validate: isObject,
    invalidMessage: CONFIG_NOT_AN_OBJECT,
    mode: CONFIG_MODE
  });
}

/** A config.json that others could read (one written before, or by hand)
 *  made its owner's alone, at start. One whose mode cannot change (a symlink
 *  into a read-only store, a read-only mount, another user's file) stays as
 *  it is, with a warning: the server starts all the same. */
export function secureConfigFile(file = configPath()): void {
  try {
    if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, CONFIG_MODE);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.warn(`[mandate] ${file} could not be made readable by its owner alone (${code ?? errorText(error)}); it holds API keys`);
  }
}
