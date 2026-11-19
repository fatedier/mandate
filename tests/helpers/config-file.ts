import { fileFromFlat } from "../../src/server/config/file-layout.js";
import type { JsonObject } from "../../src/server/config/types.js";
import { MemoryJsonStore } from "./memory-json-store.js";

/** config.json's text for a fixture written in the app's flat keys
 *  (`agent.workerModel`, `port` …), in the file's groups (file-layout.ts,
 *  whose own tests pin the mapping). */
export function configJson(flat: JsonObject): string {
  return JSON.stringify(fileFromFlat(flat));
}

/** An in-memory config store holding such a fixture as the file would. */
export function flatConfigStore(flat: JsonObject): MemoryJsonStore<JsonObject> {
  return new MemoryJsonStore<JsonObject>(fileFromFlat(flat));
}
