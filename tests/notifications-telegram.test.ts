import { expect, test } from "bun:test";
import type { HttpClient } from "../src/server/platform/http/http-client.js";
import type { NotificationChannelConfig } from "../src/server/config.js";
import { connectTelegram, telegramKind } from "../src/server/modules/notifications/channels/telegram.js";
import type { ChannelContext } from "../src/server/modules/notifications/channel-kind.js";

// Telegram through the Bot API: the user's own bot sends to the chat it was
// connected to, each notice a new message that stays as it was sent.

const TOKEN = "000000:example-token";
const BASE = "https://bot-api.example.net";

type Call = { method: string; body: Record<string, unknown> };

function fakeTelegram(answers: Array<{ status?: number; json: unknown } | Error>): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const http: HttpClient = {
    async fetch(input, init) {
      const url = String(input);
      expect(url.startsWith(`${BASE}/bot${TOKEN}/`)).toBe(true);
      calls.push({ method: url.slice(`${BASE}/bot${TOKEN}/`.length), body: JSON.parse(String(init?.body ?? "{}")) });
      const answer = answers.shift();
      if (!answer) throw new Error("no answer scripted");
      if (answer instanceof Error) throw answer;
      return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200, headers: { "content-type": "application/json" } });
    }
  };
  return { http, calls };
}

const ctx = (http: HttpClient): ChannelContext => ({
  http,
  config: { linkBase: "http://mac.example.net:8080", desktopApp: false, telegramApiBase: BASE, channels: [] }
});

const channel: NotificationChannelConfig = {
  id: "nch_phone", kind: "telegram", name: "Phone", enabled: true, includeText: true,
  values: { botToken: TOKEN, chatId: "424242", botName: "@mandate_example_bot" }
};

const notice = { key: "thread:thr_a", level: "needs_you" as const, title: "Login fix needs your call", text: "The manager asks whether the migration test may use staging.", url: "http://mac.example.net:8080/threads/thr_a" };
const ok = (result: unknown) => ({ json: { ok: true, result } });

test("telegram sends title, text and the Open button, and returns the message id", async () => {
  const { http, calls } = fakeTelegram([ok({ message_id: 77 })]);
  expect(await telegramKind.send(ctx(http), channel, notice)).toEqual({ ok: true, ref: "424242:77" });
  expect(calls).toEqual([{
    method: "sendMessage",
    body: {
      chat_id: "424242",
      text: "<b>Login fix needs your call</b>\n\nThe manager asks whether the migration test may use staging.",
      parse_mode: "HTML",
      disable_notification: false,
      reply_markup: { inline_keyboard: [[{ text: "Open in Mandate", url: "http://mac.example.net:8080/threads/thr_a" }]] }
    }
  }]);
});

test("news is sent silently, and no link means no button", async () => {
  const { http, calls } = fakeTelegram([ok({ message_id: 78 })]);
  await telegramKind.send(ctx(http), channel, { ...notice, level: "news", url: null, text: "" });
  expect(calls[0]!.body).toEqual({ chat_id: "424242", text: "<b>Login fix needs your call</b>", parse_mode: "HTML", disable_notification: true });
});

test("telegram cuts and escapes text to the limit", async () => {
  const { http, calls } = fakeTelegram([ok({ message_id: 79 })]);
  await telegramKind.send(ctx(http), channel, { ...notice, title: "a < b", text: `<b>&${"x".repeat(5000)}` });
  const text = calls[0]!.body.text as string;
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(text.startsWith("<b>a &lt; b</b>\n\n&lt;b&gt;&amp;xxx")).toBe(true);
  expect(text.endsWith("…")).toBe(true);
});

test("a cut never splits an escaped character", async () => {
  const { http, calls } = fakeTelegram([ok({ message_id: 80 })]);
  await telegramKind.send(ctx(http), channel, { ...notice, title: "t", text: "&".repeat(2000) });
  const text = calls[0]!.body.text as string;
  expect(text.length).toBeLessThanOrEqual(4096);
  expect(text.endsWith("&amp;…")).toBe(true);
});

test("telegram resends without the button when Telegram refuses its URL", async () => {
  const { http, calls } = fakeTelegram([
    { status: 400, json: { ok: false, error_code: 400, description: "Bad Request: inline keyboard button URL 'http://192.168.1.20:4174/threads/thr_a' is invalid: Wrong HTTP URL" } },
    ok({ message_id: 81 })
  ]);
  expect(await telegramKind.send(ctx(http), channel, notice)).toEqual({ ok: true, ref: "424242:81" });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body).not.toHaveProperty("reply_markup");
});

test("an unknown token gives Telegram's description and the token is in no error", async () => {
  const { http } = fakeTelegram([
    { status: 401, json: { ok: false, error_code: 401, description: "Unauthorized" } },
    new TypeError(`fetch failed: ${BASE}/bot${TOKEN}/sendMessage`)
  ]);
  const refused = await telegramKind.send(ctx(http), channel, notice);
  expect(refused).toEqual({ ok: false, error: "Unauthorized" });
  const unreachable = await telegramKind.send(ctx(http), channel, notice);
  expect(unreachable).toEqual({ ok: false, error: "Telegram could not be reached" });
  expect(JSON.stringify([refused, unreachable])).not.toContain("example-token");
});

test("a channel is ready with a token and a chat", () => {
  expect(telegramKind.ready(channel)).toBe(true);
  expect(telegramKind.ready({ ...channel, values: { botToken: TOKEN } })).toBe(false);
  expect(telegramKind.secretKeys).toEqual(["botToken"]);
});

test("connect finds the newest private chat and the bot's name", async () => {
  const { http, calls } = fakeTelegram([
    ok({ id: 1, is_bot: true, first_name: "Mandate", username: "mandate_example_bot" }),
    ok([
      { update_id: 1, message: { chat: { id: 111, type: "private" } } },
      { update_id: 2, message: { chat: { id: -5, type: "group" } } },
      { update_id: 3, message: { chat: { id: 424242, type: "private" } } },
      { update_id: 4, my_chat_member: {} }
    ])
  ]);
  expect(await connectTelegram(ctx(http), TOKEN)).toEqual({ ok: true, chatId: "424242", botName: "@mandate_example_bot" });
  expect(calls.map((c) => c.method)).toEqual(["getMe", "getUpdates"]);
  expect(calls[1]!.body).toEqual({ limit: 100, timeout: 0 });
});

test("connect with no private message asks for one", async () => {
  const { http } = fakeTelegram([ok({ id: 1, is_bot: true, first_name: "Mandate", username: "mandate_example_bot" }), ok([])]);
  expect(await connectTelegram(ctx(http), TOKEN)).toEqual({ ok: false, error: "Send any message to your bot, then press Connect." });
});

test("a cut never splits an emoji in two", async () => {
  const { http, calls } = fakeTelegram([ok({ message_id: 82 })]);
  // "<b>t</b>\n\n" is 10 characters: the emoji's first half lands on the last kept place.
  await telegramKind.send(ctx(http), channel, { ...notice, title: "t", text: `${"x".repeat(4084)}😀${"y".repeat(100)}` });
  const text = calls[0]!.body.text as string;
  expect(text.length).toBeLessThanOrEqual(4096);
  // No half of an emoji left on its own.
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
  expect(text.endsWith("x…")).toBe(true);
});

test("Telegram keeps what it sent: no notice edits or deletes a message", async () => {
  // Each notice is a new message, which alerts; none is changed or taken
  // back later, so what the user read stays in the chat.
  expect(telegramKind.replace).toBeUndefined();
  expect(telegramKind.withdraw).toBeUndefined();
  const { http, calls } = fakeTelegram([ok({ message_id: 77 }), ok({ message_id: 78 })]);
  expect(await telegramKind.send(ctx(http), channel, notice)).toEqual({ ok: true, ref: "424242:77" });
  expect(await telegramKind.send(ctx(http), channel, notice)).toEqual({ ok: true, ref: "424242:78" });
  expect(calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
});
