import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { applySettingsConfigPatch } from "../src/server/modules/settings/config-schema.js";
import { buildSettingsConfigPayload } from "../src/server/modules/settings/settings-payload.js";
import { tempDir } from "./helpers/temp.js";
import { configFileProblems } from "../src/server/config/file-check.js";

// Notifications keep a few settings and a list of channels. A channel's
// secret (Telegram's bot token) is written from the page and never read back.

type Raw = Record<string, unknown>;

function load(raw: Raw) {
  const dir = tempDir("md-notifications-config-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(raw));
  return loadConfig(dir);
}

const TOKEN = "000000:example-token";
const phone = { kind: "telegram", name: "Phone", enabled: true, includeText: true, values: { botToken: TOKEN, chatId: "424242", botName: "@mandate_example_bot" } };

test("a config without notifications loads with the defaults", () => {
  expect(load({}).notifications).toEqual({ linkBase: "", desktopApp: false, telegramApiBase: "https://api.telegram.org", channels: [] });
});

test("channels keep their shape; one Settings could not have written is refused", () => {
  const config = load({
    notifications: {
      linkBase: "http://mac.example.net:8080",
      desktopApp: true,
      channels: [{ id: "nch_one", kind: "telegram", name: "Phone", enabled: true, values: { botToken: TOKEN, botName: "@b" } }]
    }
  });
  expect(config.notifications.linkBase).toBe("http://mac.example.net:8080");
  expect(config.notifications.desktopApp).toBe(true);
  expect(config.notifications.channels).toEqual([
    { id: "nch_one", kind: "telegram", name: "Phone", enabled: true, includeText: true, values: { botToken: TOKEN, botName: "@b" } }
  ]);
  expect(configFileProblems({
    notifications: {
      channels: [
        { id: "nch_one", kind: "telegram", values: { botToken: TOKEN, chatId: 424242 } },
        { kind: "telegram", name: "No id" },
        { id: "nch_two", name: "No kind" },
        "junk"
      ]
    }
  })).toEqual([
    "notifications.channels[0].values.chatId: must be text (it is a number)",
    "notifications.channels[1].id: must be text, not empty (it is missing)",
    "notifications.channels[2].kind: must be text, not empty (it is missing)",
    "notifications.channels[3]: must be an object (it is text)"
  ]);
});

test("the payload never carries a secret", () => {
  const saved = applySettingsConfigPatch({}, { notifications: { upsert: [phone] } });
  const dir = tempDir("md-notifications-payload-");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(saved));
  const payload = buildSettingsConfigPayload(false, { config: loadConfig(dir) }).notifications;
  expect(payload.channels).toHaveLength(1);
  expect(payload.channels[0]!.values).toEqual({ chatId: "424242", botName: "@mandate_example_bot" });
  expect(payload.channels[0]!.secretsSaved).toEqual(["botToken"]);
  expect(JSON.stringify(payload)).not.toContain("example-token");
  expect(payload).not.toHaveProperty("telegramApiBase");
});

test("a blank secret keeps the saved one, null removes it", () => {
  const saved = applySettingsConfigPatch({}, { notifications: { upsert: [phone] } });
  const id = (saved.notifications as { channels: Array<{ id: string }> }).channels[0]!.id;
  const kept = applySettingsConfigPatch(saved, { notifications: { upsert: [{ ...phone, id, name: "My phone", values: { botToken: "", chatId: "424242" } }] } });
  const keptChannel = (kept.notifications as { channels: Array<{ name: string; values: Raw }> }).channels[0]!;
  expect(keptChannel.name).toBe("My phone");
  expect(keptChannel.values.botToken).toBe(TOKEN);
  const removed = applySettingsConfigPatch(saved, { notifications: { upsert: [{ ...phone, id, values: { botToken: null } }] } });
  expect((removed.notifications as { channels: Array<{ values: Raw }> }).channels[0]!.values.botToken).toBeUndefined();
});

test("upsert adds with a new id and edits by id; remove deletes", () => {
  const one = applySettingsConfigPatch({}, { notifications: { upsert: [phone] } });
  const two = applySettingsConfigPatch(one, { notifications: { upsert: [{ ...phone, name: "Tablet" }] } });
  const channels = (two.notifications as { channels: Array<{ id: string; name: string }> }).channels;
  expect(channels.map((c) => c.name)).toEqual(["Phone", "Tablet"]);
  for (const channel of channels) expect(channel.id).toMatch(/^nch_/);
  const edited = applySettingsConfigPatch(two, { notifications: { upsert: [{ ...phone, id: channels[1]!.id, name: "Tablet 2", enabled: false }] } });
  expect((edited.notifications as { channels: Array<{ name: string; enabled: boolean }> }).channels.map((c) => [c.name, c.enabled])).toEqual([["Phone", true], ["Tablet 2", false]]);
  const removed = applySettingsConfigPatch(edited, { notifications: { remove: [channels[0]!.id] } });
  expect((removed.notifications as { channels: Array<{ name: string }> }).channels.map((c) => c.name)).toEqual(["Tablet 2"]);
});

test("linkBase must be http(s)", () => {
  expect(() => applySettingsConfigPatch({}, { notifications: { linkBase: "ftp://x" } })).toThrow("Open links at must be an http or https address");
  const saved = applySettingsConfigPatch({}, { notifications: { linkBase: "http://mac.example.net:8080/" } });
  expect((saved.notifications as Raw).linkBase).toBe("http://mac.example.net:8080");
  const cleared = applySettingsConfigPatch(saved, { notifications: { linkBase: null } });
  expect(load(cleared).notifications.linkBase).toBe("");
});

test("an unknown kind or a blank name is refused", () => {
  expect(() => applySettingsConfigPatch({}, { notifications: { upsert: [{ ...phone, kind: "pager" }] } })).toThrow("unknown notification channel kind: pager");
  expect(() => applySettingsConfigPatch({}, { notifications: { upsert: [{ ...phone, name: "  " }] } })).toThrow("A channel needs a name");
});

test("the desktop app switch saves", () => {
  const saved = applySettingsConfigPatch({}, { notifications: { desktopApp: true } });
  expect(load(saved).notifications.desktopApp).toBe(true);
});
