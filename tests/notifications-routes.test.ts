import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Config } from "../src/server/config.js";
import type { HttpClient } from "../src/server/platform/http/http-client.js";
import { initializeNotificationsSchema } from "../src/server/modules/notifications/schema.js";
import { NotificationStore } from "../src/server/modules/notifications/notification-store.js";
import { PresenceBook } from "../src/server/modules/notifications/presence.js";
import { NotificationService } from "../src/server/modules/notifications/notification-service.js";
import { mountNotificationRoutes } from "../src/server/modules/notifications/notifications-http.js";
import { API_ROUTES } from "../src/shared/api-contracts.js";
import { postJson } from "./helpers/test-app.js";

// The page reports where it is, tests a channel, and connects a Telegram bot.

const TOKEN = "000000:example-token";

function app() {
  const db = new Database(":memory:");
  initializeNotificationsSchema(db);
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const http: HttpClient = {
    async fetch(input, init) {
      const url = String(input);
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      const method = url.split("/").pop();
      const result = method === "getMe" ? { username: "mandate_example_bot" }
        : method === "getUpdates" ? [{ update_id: 1, message: { chat: { id: 424242, type: "private" } } }]
        : { message_id: 5 };
      return new Response(JSON.stringify({ ok: true, result }));
    }
  };
  const config = {
    notifications: {
      linkBase: "", desktopApp: false, telegramApiBase: "https://bot-api.example.net",
      channels: [{ id: "nch_phone", kind: "telegram", name: "Phone", enabled: true, includeText: true, values: { botToken: TOKEN, chatId: "424242" } }]
    }
  } as unknown as Config;
  const presence = new PresenceBook();
  const service = new NotificationService({
    store: new NotificationStore(db), presence, sse: { emit: () => {} } as never, getConfig: () => config, http, owners: () => null
  });
  const hono = new Hono();
  mountNotificationRoutes(hono, { notifications: service });
  return { hono, calls, presence };
}

test("presence is accepted and a bad body is 400", async () => {
  const { hono, presence } = app();
  const ok = await postJson(hono, API_ROUTES.notificationsPresence, {
    windowId: "w1", device: "desktop", shell: "browser", visible: true, focused: true, lastInputAt: null, path: "/home", canShowSystem: false
  });
  expect(ok.status).toBe(200);
  expect(presence.live(new Date()).map((w) => w.windowId)).toEqual(["w1"]);
  expect((await postJson(hono, API_ROUTES.notificationsPresence, { windowId: "w2", device: "tablet" })).status).toBe(400);
  expect((await postJson(hono, API_ROUTES.notificationsPresence, "nope")).status).toBe(400);
});

test("presence keeps the thread whose chat the window has in sight, and only a thread id", async () => {
  const { hono, presence } = app();
  const base = { device: "desktop", shell: "browser", visible: true, focused: true, lastInputAt: null, path: "/threads/thr_a", canShowSystem: false };
  await postJson(hono, API_ROUTES.notificationsPresence, { ...base, windowId: "w1", threadChat: "thr_a" });
  await postJson(hono, API_ROUTES.notificationsPresence, { ...base, windowId: "w2", threadChat: 7 });
  expect(presence.live(new Date()).map((w) => [w.windowId, w.threadChat])).toEqual([["w1", "thr_a"], ["w2", undefined]]);
});

test("test with a saved channel sends 'Test from Mandate'", async () => {
  const { hono, calls } = app();
  const res = await postJson(hono, API_ROUTES.notificationsTest, { channelId: "nch_phone" });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(typeof res.body.sentAt).toBe("string");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({ chat_id: "424242", text: "<b>Test from Mandate</b>\n\nNotifications reach you here.", parse_mode: "HTML", disable_notification: false });
  const unsaved = await postJson(hono, API_ROUTES.notificationsTest, { channel: { id: "nch_phone", kind: "telegram", name: "Phone", enabled: true, includeText: true, values: { botToken: "", chatId: "424242" } } });
  expect(unsaved.body.ok).toBe(true);
  expect(calls[1]!.url).toContain(TOKEN);
  expect((await postJson(hono, API_ROUTES.notificationsTest, { channelId: "nch_none" })).status).toBe(400);
});

test("connect with a blank token uses the saved one", async () => {
  const { hono, calls } = app();
  const res = await postJson(hono, API_ROUTES.notificationsTelegramConnect, { channelId: "nch_phone", botToken: "" });
  expect(res.body).toEqual({ ok: true, chatId: "424242", botName: "@mandate_example_bot" });
  expect(calls.map((c) => c.url.split("/").pop())).toEqual(["getMe", "getUpdates"]);
  expect(calls[0]!.url).toContain(TOKEN);
});

test("connect's answer carries no token", async () => {
  const { hono } = app();
  const res = await postJson(hono, API_ROUTES.notificationsTelegramConnect, { botToken: TOKEN });
  expect(JSON.stringify(res.body)).not.toContain("example-token");
});
