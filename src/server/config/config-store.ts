import path from "node:path";
import { JsonFileStore, type JsonStore } from "../platform/storage/json-store.js";
import { resolveDataDir } from "../platform/fs/data-dir.js";
import { isObject } from "./json.js";
import type { JsonObject } from "./types.js";

export function configPath(dir = resolveDataDir()) {
  return path.join(dir, "config.json");
}

export function createConfigStore(dir = resolveDataDir()): JsonStore<JsonObject> {
  return new JsonFileStore<JsonObject>({
    filePath: configPath(dir),
    defaultValue: () => ({}),
    validate: isObject,
    invalidMessage: "config.json must contain an object"
  });
}
