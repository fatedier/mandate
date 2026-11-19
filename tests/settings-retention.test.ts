import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { applySettingsConfigPatch } from "../src/server/modules/settings/config-schema.js";
import { buildSettingsConfigPayload } from "../src/server/modules/settings/settings-payload.js";
import { tempDir } from "./helpers/temp.js";

// Settings › Storage shows and saves the chat history limit (the size past
// which the hourly pass shortens long tool outputs, oldest conversations
// first). The rest of the retention block is the file's alone.

const GB = 1024 * 1024 * 1024;

function payloadFor(config: unknown) {
  const dir = tempDir("mandate-settings-retention-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config), "utf8");
  return buildSettingsConfigPayload(false, { config: loadConfig(dir) });
}

test("the chat history limit is in the settings: as configured, 1 GB when the file names none, with the head a shortened output keeps", () => {
  expect(payloadFor({}).retention).toEqual({ chatMaxTableBytes: GB, chatToolResultHeadChars: 2000 });
  expect(payloadFor({ retention: { chatMaxTableBytes: 2 * GB, chatToolResultHeadChars: 3000 } }).retention).toEqual({ chatMaxTableBytes: 2 * GB, chatToolResultHeadChars: 3000 });
});

test("a saved limit leaves the rest of the retention block as it was; one under 1 MB, or not a whole number of bytes, is refused", () => {
  const root = { retention: { chatRetentionDays: 30, chatToolResultHeadChars: 3000 } };
  expect(applySettingsConfigPatch(root, { retention: { chatMaxTableBytes: 2 * GB } }).retention).toEqual({ chatRetentionDays: 30, chatToolResultHeadChars: 3000, chatMaxTableBytes: 2 * GB });
  expect(() => applySettingsConfigPatch(root, { retention: { chatMaxTableBytes: 1000 } })).toThrow(/chatMaxTableBytes/);
  expect(() => applySettingsConfigPatch(root, { retention: { chatMaxTableBytes: 1.5 * 1024 * 1024 + 0.5 } })).toThrow(/chatMaxTableBytes/);
  // Only the limit is the page's to change.
  expect(applySettingsConfigPatch(root, { retention: { chatRetentionDays: 1 } }).retention).toEqual(root.retention);
});
