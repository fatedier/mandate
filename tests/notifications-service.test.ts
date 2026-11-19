import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Config, NotificationChannelConfig } from "../src/server/config.js";
import type { HttpClient } from "../src/server/platform/http/http-client.js";
import type { PresenceReport } from "../src/shared/api/notifications.js";
import { initializeNotificationsSchema } from "../src/server/modules/notifications/schema.js";
import { NotificationStore } from "../src/server/modules/notifications/notification-store.js";
import { PresenceBook } from "../src/server/modules/notifications/presence.js";
import { NotificationService, STARTUP_GRACE_MS, type NotifyRequest } from "../src/server/modules/notifications/notification-service.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import type { ChannelContext, ChannelKind, OutgoingNotification, SendOutcome } from "../src/server/modules/notifications/channel-kind.js";
import { telegramKind, telegramText } from "../src/server/modules/notifications/channels/telegram.js";
import { CHANNEL_KINDS } from "../src/server/modules/notifications/channels/index.js";

// The service decides, for each notice, where it goes now and later, sends
// it, and takes it back when the user has seen it or the matter is settled.

const T0 = new Date("2026-11-02T10:00:00.000Z");
const TOKEN = "000000:example-token";

const phone: NotificationChannelConfig = {
  id: "nch_phone", kind: "telegram", name: "Phone", enabled: true, includeText: true,
  values: { botToken: TOKEN, chatId: "424242", botName: "@mandate_example_bot" }
};

type TelegramCall = { method: string; body: Record<string, unknown> };

/** A Bot API call of the kind below; "already so" answers count as done. */
async function botCall(ctx: ChannelContext, channel: NotificationChannelConfig, method: string, body: Record<string, unknown>, ref: string): Promise<SendOutcome> {
  const response = await ctx.http.fetch(`${ctx.config.telegramApiBase}/bot${channel.values.botToken}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const json = await response.json() as { ok?: boolean; description?: string };
  if (json.ok) return { ok: true, ref };
  const error = json.description ?? `Telegram answered ${response.status}`;
  return /message is not modified|message to delete not found|message can't be deleted/i.test(error) ? { ok: true, ref } : { ok: false, error };
}
const messageId = (ref: string) => Number(ref.slice(ref.lastIndexOf(":") + 1));

/** A channel that can change and take back what it sent, a capability a
 *  kind may have (Telegram keeps every message, so it has neither): the
 *  service's rules for such a channel are tested through this one, over the
 *  same fake Bot API. */
const takesBack: ChannelKind = {
  ...telegramKind,
  replace: (ctx, channel, ref, notice: OutgoingNotification) =>
    botCall(ctx, channel, "editMessageText", { chat_id: channel.values.chatId, message_id: messageId(ref), text: telegramText(notice), parse_mode: "HTML" }, ref),
  withdraw: (ctx, channel, ref) => botCall(ctx, channel, "deleteMessage", { chat_id: channel.values.chatId, message_id: messageId(ref) }, ref)
};

function harness(options: { channels?: NotificationChannelConfig[]; desktopApp?: boolean; db?: Database; telegram?: (call: TelegramCall) => { status?: number; json: unknown }; startAt?: number; kinds?: readonly ChannelKind[] } = {}) {
  const clock = { now: new Date(T0.getTime() + (options.startAt ?? 0)) };
  const db = options.db ?? (() => { const fresh = new Database(":memory:"); initializeNotificationsSchema(fresh); return fresh; })();
  const calls: TelegramCall[] = [];
  let nextMessageId = 100;
  let current: HttpClient | null = null;
  const base: HttpClient = {
    async fetch(input, init) {
      const call = { method: String(input).split("/").pop()!, body: JSON.parse(String(init?.body ?? "{}")) };
      calls.push(call);
      const answer = options.telegram?.(call) ?? { json: { ok: true, result: call.method === "sendMessage" ? { message_id: nextMessageId++ } : true } };
      return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 });
    }
  };
  const http: HttpClient = { fetch: (input, init) => (current ?? base).fetch(input, init) };
  const config = {
    notifications: { linkBase: "http://mac.example.net:8080", desktopApp: options.desktopApp ?? false, telegramApiBase: "https://bot-api.example.net", channels: options.channels ?? [phone] }
  } as unknown as Config;
  const emits: Array<{ event: string; data: unknown }> = [];
  const presence = new PresenceBook();
  const service = new NotificationService({
    store: new NotificationStore(db, () => clock.now),
    presence,
    sse: { emit: (event: string, data: unknown) => { emits.push({ event, data }); } } as never,
    getConfig: () => config,
    http,
    owners: () => null,
    now: () => clock.now,
    kinds: options.kinds ?? [takesBack]
  });
  const report = (r: Partial<PresenceReport> & { windowId: string }) => service.reportPresence({
    device: "desktop", shell: "browser", visible: true, focused: true, lastInputAt: clock.now.toISOString(), path: "/projects", canShowSystem: true, ...r
  });
  const at = (ms: number) => { clock.now = new Date(T0.getTime() + ms); };
  return { service, calls, emits, report, at, clock, db, config, http: base, setHttp: (next: HttpClient) => { current = next; } };
}

const request = (overrides: Partial<NotifyRequest> = {}): NotifyRequest => ({
  source: "agent",
  matter: { key: "thread:thr_a", link: "/threads/thr_a" },
  title: "Login fix needs your call",
  text: "The manager asks whether the migration test may use staging.",
  level: "needs_you",
  ...overrides
});

const shows = (emits: Array<{ event: string; data: unknown }>) => emits.filter((e) => e.event === SSE_EVENTS.notificationShow).map((e) => e.data);
const withdraws = (emits: Array<{ event: string; data: unknown }>) => emits.filter((e) => e.event === SSE_EVENTS.notificationWithdraw).map((e) => e.data);
const away = { visible: false, focused: false, lastInputAt: new Date(T0.getTime() - 60 * 60_000).toISOString() };

test("nothing on: no channel line", async () => {
  const h = harness({ channels: [] });
  expect(await h.service.notify(request())).toEqual({ line: "Not sent: no channel is set up.", notSent: "no_channel" });
  expect(h.emits).toStrictEqual([]);
  expect(h.calls).toStrictEqual([]);
});

test("looking: not sent and nothing emitted", async () => {
  const h = harness();
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  expect(await h.service.notify(request())).toEqual({ line: "Not sent: the user is looking at it.", notSent: "looking" });
  expect(h.emits).toStrictEqual([]);
  expect(h.calls).toStrictEqual([]);
});

test("in use elsewhere: one toast event to that window, Telegram untouched", async () => {
  const h = harness();
  h.report({ windowId: "w1", path: "/projects" });
  expect(await h.service.notify(request())).toEqual({ line: "Sent to: Browser." });
  expect(shows(h.emits)).toEqual([{ key: "thread:thr_a", title: "Login fix needs your call", body: "The manager asks whether the migration test may use staging.", link: "/threads/thr_a", level: "needs_you", toast: ["w1"], system: [] }]);
  expect(h.calls).toStrictEqual([]);
});

test("away: system event to capable windows and Telegram now; the line names both", async () => {
  const h = harness();
  h.report({ windowId: "tab", ...away });
  expect(await h.service.notify(request())).toEqual({ line: "Sent to: Browser, Phone." });
  expect(shows(h.emits)).toMatchObject([{ toast: [], system: ["tab"] }]);
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  expect(h.calls[0]!.body).toMatchObject({ chat_id: "424242", reply_markup: { inline_keyboard: [[{ text: "Open in Mandate", url: "http://mac.example.net:8080/threads/thr_a" }]] } });
});

test("desk: system now, Telegram after 5 minutes unless seen first", async () => {
  const h = harness();
  h.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
  expect(await h.service.notify(request())).toEqual({ line: "Sent to: Browser, Phone." });
  expect(shows(h.emits)).toMatchObject([{ system: ["tab"] }]);
  expect(h.calls).toStrictEqual([]);
  h.at(5 * 60_000 - 1000);
  await h.service.tick();
  expect(h.calls).toStrictEqual([]);
  h.at(5 * 60_000);
  await h.service.tick();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);

  const seen = harness();
  seen.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
  await seen.service.notify(request());
  seen.at(4 * 60_000);
  seen.report({ windowId: "tab", path: "/threads/thr_a" });
  await seen.service.idle();
  expect(withdraws(seen.emits)).toEqual([{ key: "thread:thr_a" }]);
  seen.at(6 * 60_000);
  await seen.service.tick();
  expect(seen.calls).toStrictEqual([]);
});

test("a repeat with the same text in 10 minutes sends nothing", async () => {
  const h = harness();
  const first = await h.service.notify(request());
  h.at(9 * 60_000);
  expect(await h.service.notify(request())).toEqual(first);
  expect(h.calls).toHaveLength(1);
  h.at(11 * 60_000);
  await h.service.notify(request());
  // Sent again, as a new message: it needs the user.
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage", "sendMessage"]);
});

test("a newer notice of news on the same matter edits the Telegram message", async () => {
  const h = harness();
  await h.service.notify(request());
  await h.service.notify(request({ text: "Still going.", level: "news" }));
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
  expect(h.calls[1]!.body).toMatchObject({ message_id: 100 });
  await h.service.settle("thread:thr_a");
  expect(h.calls[2]).toEqual({ method: "deleteMessage", body: { chat_id: "424242", message_id: 100 } });
});

test("seen or settled deletes the Telegram message and emits a withdraw", async () => {
  const h = harness();
  await h.service.notify(request());
  await h.service.settle("thread:thr_a");
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage"]);
  expect(withdraws(h.emits)).toEqual([{ key: "thread:thr_a" }]);

  const seen = harness();
  await seen.service.notify(request());
  seen.at(1000);
  seen.report({ windowId: "phone-page", device: "phone", path: "/threads/thr_a" });
  await seen.service.idle();
  expect(seen.calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage"]);
});

test("include text off sends the title alone", async () => {
  const h = harness({ channels: [{ ...phone, includeText: false }] });
  await h.service.notify(request());
  expect(h.calls[0]!.body.text).toBe("<b>Login fix needs your call</b>");
});

// On the phone a message's preview shows its first lines: a question's
// asking sentence comes first, then the message as written.
test("a question's message begins with the sentence that asks, then the whole message", async () => {
  const h = harness();
  h.report({ windowId: "tab", ...away });
  await h.service.notify(request({ source: "system", matter: { key: "agent:question", link: "/agent" }, title: "Juno asks", text: "I rebased the branch on `main`.\n\nShall I push it now?" }));
  expect(h.calls[0]!.body.text).toBe("<b>Juno asks</b>\n\nShall I push it now?\n\nI rebased the branch on `main`.\n\nShall I push it now?");
});

test("the 21st send in an hour is More in Mandate, the 22nd is skipped", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    h.at(i * 1000);
    expect(await h.service.notify(request({ matter: { key: `thread:t${i}`, link: `/threads/t${i}` } }))).toEqual({ line: "Sent to: Phone." });
  }
  h.at(21_000);
  await h.service.notify(request({ matter: { key: "thread:t20", link: "/threads/t20" } }));
  const more = h.calls[20]!.body.text as string;
  expect(more).toMatch(/^<b>More in Mandate<\/b>\n\nNotifications here are paused until \d\d:\d\d\.$/);
  h.at(22_000);
  expect(await h.service.notify(request({ matter: { key: "thread:t21", link: "/threads/t21" } }))).toEqual({ line: "Not sent: the hourly limit is reached.", notSent: "limit" });
  expect(h.calls).toHaveLength(21);
  h.at(60 * 60_000 + 1000);
  await h.service.notify(request({ matter: { key: "thread:t22", link: "/threads/t22" } }));
  expect(h.calls).toHaveLength(22);
});

test("a failing channel is reported once per notice and not retried", async () => {
  const h = harness({ telegram: () => ({ status: 403, json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } }) });
  expect(await h.service.notify(request())).toEqual({ line: "Failed: Phone (Forbidden: bot was blocked by the user)." });
  await h.service.tick();
  h.at(60 * 60_000);
  await h.service.tick();
  expect(h.calls).toHaveLength(1);

  const desk = harness({ telegram: () => ({ status: 403, json: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } }) });
  desk.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
  await desk.service.notify(request());
  desk.at(5 * 60_000);
  await desk.service.tick();
  desk.at(10 * 60_000);
  await desk.service.tick();
  expect(desk.calls).toHaveLength(1);
});

test("a restart keeps pending escalations and withdrawals", async () => {
  const first = harness();
  first.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
  await first.service.notify(request());
  await first.service.notify(request({ matter: { key: "thread:thr_b", link: "/threads/thr_b" } }));

  const second = harness({ db: first.db });
  second.at(5 * 60_000);
  await second.service.tick();
  expect(second.calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
  await second.service.settle("thread:thr_b");
  expect(second.calls[2]).toEqual({ method: "deleteMessage", body: { chat_id: "424242", message_id: 101 } });
});

test("isOn reads channels, the desktop app switch and windows that can show a notification", () => {
  expect(harness().service.isOn()).toBe(true);
  expect(harness({ channels: [{ ...phone, enabled: false }] }).service.isOn()).toBe(false);
  expect(harness({ channels: [{ ...phone, values: { botToken: TOKEN } }] }).service.isOn()).toBe(false);
  expect(harness({ channels: [], desktopApp: true }).service.isOn()).toBe(true);
  const browser = harness({ channels: [] });
  browser.report({ windowId: "tab", ...away });
  expect(browser.service.isOn()).toBe(true);
});

test("earlier words repeated after a newer notice on the matter are sent", async () => {
  const h = harness();
  await h.service.notify(request());
  await h.service.settle("thread:thr_a");
  await h.service.notify(request({ text: "Something else now." }));
  await h.service.notify(request());
  // The newer notice is still open: the repeat of the first words replaces
  // it, a new message since it needs the user.
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage", "sendMessage", "deleteMessage", "sendMessage"]);
});

test("identical calls at the same time send once", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.service.notify(request()), h.service.notify(request())]);
  expect(a).toEqual({ line: "Sent to: Phone." });
  expect(b).toEqual(a);
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

test("a send that fails later, at the desk's turn, is logged", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    const h = harness({ telegram: () => ({ status: 401, json: { ok: false, error_code: 401, description: "Unauthorized" } }) });
    h.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
    await h.service.notify(request());
    h.at(5 * 60_000);
    await h.service.tick();
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain("[mandate] notifications-send: Phone: Unauthorized");
  } finally {
    errors.mockRestore();
  }
});

test("a cap notice that fails is reported as the channel's failure", async () => {
  let refuse = false;
  const h = harness({ telegram: (call) => (refuse ? { status: 401, json: { ok: false, error_code: 401, description: "Unauthorized" } } : { json: { ok: true, result: { message_id: call.body.text ? 1 : 1 } } }) });
  for (let i = 0; i < 20; i++) {
    h.at(i * 1000);
    await h.service.notify(request({ matter: { key: `thread:t${i}`, link: `/threads/t${i}` } }));
  }
  refuse = true;
  h.at(21_000);
  expect(await h.service.notify(request({ matter: { key: "thread:t20", link: "/threads/t20" } }))).toEqual({ line: "Failed: Phone (Unauthorized)." });
});

test("a matter closed while its Telegram send is still on its way is taken back once it lands", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness();
  const slow: HttpClient = h.http;
  h.setHttp({ async fetch(input, init) { if (String(input).endsWith("/sendMessage")) await gate; return slow.fetch(input, init); } });
  const sending = h.service.notify(request());
  const settling = h.service.settle("thread:thr_a");
  release();
  await Promise.all([sending, settling]);
  await h.service.idle();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage"]);
});

test("a toast that replaces a Telegram notice leaves the message to be taken back with the matter", async () => {
  const h = harness();
  await h.service.notify(request());
  h.report({ windowId: "w1", path: "/projects" });
  expect(await h.service.notify(request({ text: "Still waiting." }))).toEqual({ line: "Sent to: Browser." });
  await h.service.settle("thread:thr_a");
  expect(h.calls).toEqual([
    expect.objectContaining({ method: "sendMessage" }),
    { method: "deleteMessage", body: { chat_id: "424242", message_id: 100 } }
  ]);
});

test("after the paused hour, notices go out again rather than another More in Mandate", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    h.at(i * 1000);
    await h.service.notify(request({ matter: { key: `thread:t${i}`, link: `/threads/t${i}` } }));
  }
  h.at(21_000);
  await h.service.notify(request({ matter: { key: "thread:t20", link: "/threads/t20" } }));
  expect(h.calls).toHaveLength(21);
  h.at(60 * 60_000 + 500);
  expect(await h.service.notify(request({ matter: { key: "thread:late", link: "/threads/late" } }))).toEqual({ line: "Sent to: Phone." });
  expect(h.calls.at(-1)!.body.text).toContain("Login fix needs your call");
  // The sends at 1 s … 19 s and the one just now: 20 in the hour, and the
  // channel was told it is paused: nothing more yet.
  h.at(60 * 60_000 + 900);
  expect(await h.service.notify(request({ matter: { key: "thread:later", link: "/threads/later" } }))).toEqual({ line: "Not sent: the hourly limit is reached.", notSent: "limit" });
  expect(h.calls).toHaveLength(22);
});

test("a desk notice does not reach the phone once the user is using Mandate again", async () => {
  const h = harness();
  h.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
  await h.service.notify(request());
  h.at(4 * 60_000);
  // Back in Mandate, on another page: the notice is not seen, but the user is here.
  h.report({ windowId: "tab", path: "/projects" });
  h.at(5 * 60_000);
  await h.service.tick();
  expect(h.calls).toStrictEqual([]);
});

test("a notice that needs the user replaces an unseen one with a new message, so the phone alerts", async () => {
  const h = harness();
  await h.service.notify(request({ text: "Step one is done.", level: "news" }));
  await h.service.notify(request({ text: "It needs your decision." }));
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage", "sendMessage"]);
  expect(h.calls[1]!.body).toEqual({ chat_id: "424242", message_id: 100 });
  expect(h.calls[2]!.body.disable_notification).toBe(false);
});

test("the same words after the user saw them are sent again", async () => {
  const h = harness();
  await h.service.notify(request());
  h.at(1000);
  h.report({ windowId: "phone-page", device: "phone", path: "/threads/thr_a" });
  await h.service.idle();
  h.report({ windowId: "phone-page", gone: true });
  h.at(2 * 60_000);
  expect(await h.service.notify(request())).toEqual({ line: "Sent to: Phone." });
  expect(h.calls.filter((c) => c.method === "sendMessage")).toHaveLength(2);
});

test("looking when the notice came, but untouched since: after 5 minutes it reaches the phone", async () => {
  const h = harness();
  const touchedBefore = new Date(T0.getTime() - 10_000).toISOString();
  h.report({ windowId: "tab", path: "/threads/thr_a", lastInputAt: touchedBefore });
  expect(await h.service.notify(request())).toEqual({ line: "Not sent: the user is looking at it.", notSent: "looking" });
  // The window keeps reporting, never touched: a heartbeat is not seeing it.
  h.at(2 * 60_000);
  h.report({ windowId: "tab", path: "/threads/thr_a", lastInputAt: touchedBefore });
  h.at(4 * 60_000);
  h.report({ windowId: "tab", path: "/threads/thr_a", lastInputAt: touchedBefore });
  await h.service.idle();
  expect(withdraws(h.emits)).toStrictEqual([]);
  h.at(5 * 60_000);
  await h.service.tick();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  expect(shows(h.emits)).toMatchObject([{ toast: [], system: ["tab"] }]);
});

const HELD = { line: "Not sent yet: the user may be looking at it. It goes out in 2 minutes unless they see it first.", notSent: "held" } as const;
/** The matter's page on screen in a window behind another, touched a minute
 *  before the notice. */
const behind = { path: "/threads/thr_a", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() };

// The page on screen in a window not in front: the user may be reading it,
// or another app's window may cover it. The notice waits 2 minutes for them
// to see it, then goes as it would have.
test("a page on screen behind another window holds its notice; seen within 2 minutes, nothing goes", async () => {
  const h = harness();
  h.report({ windowId: "tab", ...behind });
  expect(await h.service.notify(request())).toEqual(HELD);
  // The same words again while it waits: told the same.
  expect(await h.service.notify(request())).toEqual(HELD);
  expect(shows(h.emits)).toStrictEqual([]);
  h.at(60_000);
  h.report({ windowId: "tab", path: "/threads/thr_a" });
  await h.service.idle();
  h.at(10 * 60_000);
  h.report({ windowId: "tab", path: "/threads/thr_a" });
  await h.service.tick();
  expect(shows(h.emits)).toStrictEqual([]);
  expect(h.calls).toStrictEqual([]);
});

test("not seen in 2 minutes, a held notice goes as it would have: at the desk, the system notification then and the phone 5 minutes later", async () => {
  const h = harness();
  h.report({ windowId: "tab", ...behind });
  await h.service.notify(request());
  h.at(2 * 60_000 - 1000);
  await h.service.tick();
  expect(shows(h.emits)).toStrictEqual([]);
  h.at(2 * 60_000);
  h.report({ windowId: "tab", ...behind });
  await h.service.tick();
  expect(shows(h.emits)).toMatchObject([{ toast: [], system: ["tab"] }]);
  expect(h.calls).toStrictEqual([]);
  h.at(7 * 60_000 - 1000);
  h.report({ windowId: "tab", ...behind });
  await h.service.tick();
  expect(h.calls).toStrictEqual([]);
  h.at(7 * 60_000);
  await h.service.tick();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

test("used elsewhere in Mandate during the wait, the window in use gets the toast when the wait is over", async () => {
  const h = harness();
  h.report({ windowId: "tab", ...behind });
  await h.service.notify(request());
  h.at(60_000);
  h.report({ windowId: "other", path: "/projects" });
  h.at(2 * 60_000);
  h.report({ windowId: "tab", ...behind });
  h.report({ windowId: "other", path: "/projects" });
  await h.service.tick();
  expect(shows(h.emits)).toMatchObject([{ toast: ["other"], system: [] }]);
});

test("in front of its page when the wait is over but untouched since, the notice waits as one sent while looking does", async () => {
  const h = harness();
  h.report({ windowId: "tab", ...behind });
  await h.service.notify(request());
  // Brought to the front without a touch.
  h.at(2 * 60_000);
  h.report({ windowId: "tab", ...behind, focused: true });
  await h.service.tick();
  expect(shows(h.emits)).toStrictEqual([]);
  h.at(7 * 60_000 - 1000);
  h.report({ windowId: "tab", ...behind, focused: true });
  await h.service.tick();
  expect(shows(h.emits)).toStrictEqual([]);
  h.at(7 * 60_000);
  await h.service.tick();
  expect(shows(h.emits)).toMatchObject([{ system: ["tab"] }]);
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

// Out at the end of its wait, a notice counts what the user does from then
// on: a touch elsewhere during the wait does not cancel its later turn.
test("what the user did during a held notice's wait does not keep it from the phone afterwards", async () => {
  const h = harness();
  h.report({ windowId: "tab", ...behind });
  await h.service.notify(request());
  // Another page used at 1 minute, then left.
  const touchedAt = new Date(T0.getTime() + 60_000).toISOString();
  h.at(60_000);
  h.report({ windowId: "other", path: "/projects" });
  const both = () => {
    h.report({ windowId: "tab", ...behind });
    h.report({ windowId: "other", path: "/projects", focused: false, lastInputAt: touchedAt });
  };
  h.at(2 * 60_000);
  both();
  await h.service.tick();
  expect(shows(h.emits).map((show) => (show as { system: string[] }).system.toSorted())).toEqual([["other", "tab"]]);
  expect(h.calls).toStrictEqual([]);
  // Heartbeats carry the same touch from before it went out.
  for (const minute of [4, 6]) {
    h.at(minute * 60_000);
    both();
  }
  h.at(7 * 60_000);
  await h.service.tick();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

// Nowhere to go when its wait ends (every window closed, no channel): as a
// notice with nowhere to go is not recorded, the same words later go where
// they can rather than count as already sent.
test("with nowhere to go when its wait ends, a held notice does not count as sent: the same words later go where they can", async () => {
  const h = harness({ channels: [] });
  h.report({ windowId: "tab", ...behind });
  expect(await h.service.notify(request())).toEqual(HELD);
  h.at(60_000);
  h.report({ windowId: "tab", gone: true });
  h.at(2 * 60_000);
  await h.service.tick();
  expect(shows(h.emits)).toStrictEqual([]);
  h.at(3 * 60_000);
  h.report({ windowId: "back", path: "/projects" });
  expect(await h.service.notify(request())).toEqual({ line: "Sent to: Browser." });
  expect(shows(h.emits)).toMatchObject([{ toast: ["back"], system: [] }]);
});

// The wait's end goes the way a notice sent then would: with notices turned
// off meanwhile, nothing shows.
test("notices turned off during the wait, a held notice is not shown when it ends", async () => {
  const h = harness({ channels: [], desktopApp: true });
  h.report({ windowId: "app", shell: "desktop-app", ...behind });
  expect(await h.service.notify(request())).toEqual(HELD);
  (h.config.notifications as { desktopApp: boolean }).desktopApp = false;
  h.at(60_000);
  h.report({ windowId: "app", shell: "desktop-app", path: "/projects" });
  h.at(2 * 60_000);
  h.report({ windowId: "app", shell: "desktop-app", path: "/projects" });
  await h.service.tick();
  expect(shows(h.emits)).toStrictEqual([]);
  expect(await h.service.notify(request())).toEqual({ line: "Not sent: no channel is set up.", notSent: "no_channel" });
});

test("a held notice outlives a restart and goes once the windows have reported", async () => {
  const first = harness();
  first.report({ windowId: "tab", ...behind });
  await first.service.notify(request());
  const second = harness({ db: first.db, startAt: 3 * 60_000 });
  await second.service.tick();
  expect(shows(second.emits)).toStrictEqual([]);
  second.at(3 * 60_000 + STARTUP_GRACE_MS);
  second.report({ windowId: "tab", ...behind });
  await second.service.tick();
  expect(shows(second.emits)).toMatchObject([{ toast: [], system: ["tab"] }]);
});

test("a touch after the notice keeps the phone quiet", async () => {
  const h = harness();
  h.report({ windowId: "w1", path: "/projects", lastInputAt: new Date(T0.getTime() - 10_000).toISOString() });
  expect(await h.service.notify(request())).toEqual({ line: "Sent to: Browser." });
  h.at(60_000);
  h.report({ windowId: "w1", path: "/projects" });
  h.at(5 * 60_000);
  await h.service.tick();
  expect(h.calls).toStrictEqual([]);
});

test("a touch after the notice, reported as the window loses focus, still keeps the phone quiet", async () => {
  const h = harness();
  h.report({ windowId: "w1", path: "/projects", lastInputAt: new Date(T0.getTime() - 10_000).toISOString() });
  await h.service.notify(request());
  // Touched at 30 s; reported only as the user switched apps, then the tab closed.
  h.at(40_000);
  h.report({ windowId: "w1", path: "/projects", focused: false, lastInputAt: new Date(T0.getTime() + 30_000).toISOString() });
  h.report({ windowId: "w1", gone: true });
  h.at(5 * 60_000);
  await h.service.tick();
  expect(h.calls).toStrictEqual([]);
});

test("just after a restart, a due phone send waits for the windows to report", async () => {
  const first = harness();
  first.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
  await first.service.notify(request());
  // Restarted at 5 minutes: nobody has reported yet.
  const second = harness({ db: first.db, startAt: 5 * 60_000 });
  await second.service.tick();
  expect(second.calls).toStrictEqual([]);
  // Still nobody after a heartbeat and more: the user is not there.
  second.at(5 * 60_000 + 46_000);
  await second.service.tick();
  expect(second.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

test("at the desk, the line leaves out a channel paused for the hour", async () => {
  const h = harness();
  for (let i = 0; i < 21; i++) {
    h.at(i * 1000);
    await h.service.notify(request({ matter: { key: `thread:t${i}`, link: `/threads/t${i}` } }));
  }
  h.at(30_000);
  h.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() + 20_000).toISOString() });
  expect(await h.service.notify(request({ matter: { key: "thread:desk", link: "/threads/desk" } }))).toEqual({ line: "Sent to: Browser." });
});

// The personal agent may name channels, where the user has said they want to be
// told: those get it at once, wherever the user is, and keep it once seen.

test("named: the phone gets it at once while the user looks at it, and keeps it once seen", async () => {
  const h = harness();
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  expect(await h.service.notify(request({ channels: ["Phone"] }))).toEqual({ line: "Sent to: Phone." });
  expect(shows(h.emits)).toStrictEqual([]);
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  h.at(1000);
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  await h.service.idle();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  const row = h.db.prepare("select seen_at, escalate_at from notifications").get() as { seen_at: string | null; escalate_at: string | null };
  expect(row).toEqual({ seen_at: new Date(T0.getTime() + 1000).toISOString(), escalate_at: null });
});

test("named at the desk: sent now, not again when the desk's wait is over", async () => {
  const h = harness();
  h.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
  expect(await h.service.notify(request({ channels: ["Phone"] }))).toEqual({ line: "Sent to: Phone." });
  expect(shows(h.emits)).toStrictEqual([]);
  h.at(6 * 60_000);
  await h.service.tick();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

test("named Browser: a system notification where the window allows one, a toast in the others, kept once seen", async () => {
  const h = harness();
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  h.report({ windowId: "phone-page", device: "phone", canShowSystem: false, path: "/home", focused: false });
  h.report({ windowId: "blocked", canShowSystem: false, path: "/projects", focused: false });
  expect(await h.service.notify(request({ channels: ["browser"] }))).toEqual({ line: "Sent to: Browser." });
  expect(shows(h.emits)).toMatchObject([{ key: "thread:thr_a", toast: ["phone-page", "blocked"], system: ["w1"] }]);
  expect(h.calls).toStrictEqual([]);
  h.at(1000);
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  await h.service.idle();
  expect(withdraws(h.emits)).toStrictEqual([]);
});

test("named Desktop app reaches the desktop app's windows only", async () => {
  const h = harness({ desktopApp: true });
  h.report({ windowId: "app", shell: "desktop-app", path: "/projects", focused: false });
  h.report({ windowId: "tab", path: "/projects", focused: false });
  expect(await h.service.notify(request({ channels: ["Desktop app"] }))).toEqual({ line: "Sent to: Desktop app." });
  expect(shows(h.emits)).toMatchObject([{ toast: [], system: ["app"] }]);
});

test("named Browser with no Mandate window open fails that part; the rest goes", async () => {
  const h = harness();
  expect(await h.service.notify(request({ channels: ["Browser", "Phone"] }))).toEqual({ line: "Sent to: Phone. Failed: Browser (no Mandate window is open)." });
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

test("a name that is no channel sends nothing and lists the channels", async () => {
  const h = harness({ desktopApp: true });
  expect(await h.service.notify(request({ channels: ["Phon"] }))).toEqual({ line: "No channel named \"Phon\". Channels: Browser, Desktop app, Phone.", notSent: "channel" });
  expect(h.emits).toStrictEqual([]);
  expect(h.calls).toStrictEqual([]);
  expect(h.db.prepare("select count(*) n from notifications").get()).toEqual({ n: 0 });
});

test("a channel turned off is named back as off, and nothing goes", async () => {
  const h = harness({ channels: [{ ...phone, enabled: false }] });
  expect(await h.service.notify(request({ channels: ["Phone", "Browser"] }))).toEqual({ line: "Phone is off in Settings; nothing was sent.", notSent: "channel" });
  expect(h.emits).toStrictEqual([]);
  expect(h.calls).toStrictEqual([]);
});

test("with nothing set up, naming a channel is the no-channel line", async () => {
  const h = harness({ channels: [] });
  h.report({ windowId: "w1", path: "/projects" });
  expect(await h.service.notify(request({ channels: ["Browser"] }))).toEqual({ line: "Not sent: no channel is set up.", notSent: "no_channel" });
  expect(h.emits).toStrictEqual([]);
});

test("a repeat is the same words to the same channels: naming them after Mandate held it back sends it", async () => {
  const h = harness();
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  expect(await h.service.notify(request())).toEqual({ line: "Not sent: the user is looking at it.", notSent: "looking" });
  expect(await h.service.notify(request({ channels: ["Phone"] }))).toEqual({ line: "Sent to: Phone." });
  h.at(60_000);
  expect(await h.service.notify(request({ channels: ["Phone"] }))).toEqual({ line: "Sent to: Phone." });
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

test("the hour's limit holds for named channels", async () => {
  const h = harness();
  for (let i = 0; i < 21; i++) {
    h.at(i * 1000);
    await h.service.notify(request({ matter: { key: `thread:t${i}`, link: `/threads/t${i}` } }));
  }
  h.at(30_000);
  expect(await h.service.notify(request({ matter: { key: "thread:named", link: "/threads/named" }, channels: ["Phone"] }))).toEqual({ line: "Not sent: the hourly limit is reached.", notSent: "limit" });
});

test("the channels the personal agent can name: none until one is set up; an off one marked", () => {
  expect(harness({ channels: [] }).service.channelChoices()).toStrictEqual([]);
  expect(harness({ channels: [], desktopApp: true }).service.channelChoices().map((c) => c.name)).toEqual(["Browser", "Desktop app"]);
  expect(harness({ channels: [phone, { ...phone, id: "nch_team", name: "Team", enabled: false }] }).service.channelChoices()).toEqual([
    { name: "Browser", about: "Mandate's open browser windows: a system notification where allowed, otherwise a pop-up in the page", on: true },
    { name: "Phone", about: "Telegram", on: true },
    { name: "Team", about: "Telegram", on: false }
  ]);
});

test("named only Browser with no window open: nothing goes, nothing is recorded, what waited still waits", async () => {
  const h = harness();
  h.report({ windowId: "tab", focused: false, lastInputAt: new Date(T0.getTime() - 60_000).toISOString() });
  await h.service.notify(request());
  h.report({ windowId: "tab", gone: true });
  expect(await h.service.notify(request({ text: "Still waiting on you.", channels: ["Browser"] }))).toEqual({ line: "Failed: Browser (no Mandate window is open)." });
  expect(h.db.prepare("select count(*) n from notifications").get()).toEqual({ n: 1 });
  h.at(5 * 60_000);
  await h.service.tick();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

test("a named notice kept once seen is still taken back when its matter settles", async () => {
  const h = harness();
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  await h.service.notify(request({ channels: ["Phone"] }));
  h.at(1000);
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  await h.service.idle();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  expect(h.service.openMatterKeys()).toEqual(["thread:thr_a"]);
  await h.service.settle("thread:thr_a");
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage"]);
  expect(h.service.openMatterKeys()).toStrictEqual([]);
});

test("seen, a message is kept or taken back as the newest notice on it was sent", async () => {
  // Named first, then edited in place by one Mandate routed: it goes.
  const h = harness();
  await h.service.notify(request({ level: "news", channels: ["Phone"] }));
  h.at(1000);
  await h.service.notify(request({ level: "news", text: "The migration test ran on staging." }));
  h.at(2000);
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  await h.service.idle();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText", "deleteMessage"]);

  // Routed first, then edited in place by a named one: it stays.
  const k = harness();
  await k.service.notify(request({ level: "news" }));
  k.at(1000);
  await k.service.notify(request({ level: "news", text: "The migration test ran on staging.", channels: ["Phone"] }));
  k.at(2000);
  k.report({ windowId: "w1", path: "/threads/thr_a" });
  await k.service.idle();
  expect(k.calls.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
});

test("a name two channels share sends to each one turned on", async () => {
  const second: NotificationChannelConfig = { ...phone, id: "nch_phone2", values: { ...phone.values, chatId: "434343" } };
  const h = harness({ channels: [{ ...phone, enabled: false }, second] });
  expect(await h.service.notify(request({ channels: ["Phone"] }))).toEqual({ line: "Sent to: Phone." });
  expect(h.calls.map((c) => [c.method, c.body.chat_id])).toEqual([["sendMessage", "434343"]]);
  const both = harness({ channels: [phone, second] });
  await both.service.notify(request({ channels: ["Phone"] }));
  expect(both.calls.map((c) => c.body.chat_id)).toEqual(["424242", "434343"]);
  const off = harness({ channels: [{ ...phone, enabled: false }, { ...second, enabled: false }] });
  expect(await off.service.notify(request({ channels: ["Phone"] }))).toEqual({ line: "Phone is off in Settings; nothing was sent.", notSent: "channel" });
});

test("a named message left in place by a newer notice is still taken back when the matter settles", async () => {
  const h = harness();
  // Looking at the thread, last touched before either notice.
  h.report({ windowId: "w1", path: "/threads/thr_a", lastInputAt: new Date(T0.getTime() - 1000).toISOString() });
  await h.service.notify(request({ channels: ["Phone"] }));
  h.at(500);
  expect(await h.service.notify(request({ text: "The manager asks again." }))).toEqual({ line: "Not sent: the user is looking at it.", notSent: "looking" });
  h.at(1000);
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  await h.service.idle();
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage"]);
  expect(h.service.openMatterKeys()).toEqual(["thread:thr_a"]);
  await h.service.settle("thread:thr_a");
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "deleteMessage"]);
});

test("seen, the windows keep a named notice unless a newer one was shown there", async () => {
  // The newer one went nowhere (the user was looking): the named one stays.
  const h = harness();
  h.report({ windowId: "w1", path: "/threads/thr_a", lastInputAt: new Date(T0.getTime() - 1000).toISOString() });
  await h.service.notify(request({ channels: ["Browser"] }));
  h.at(500);
  await h.service.notify(request({ text: "The manager asks again." }));
  h.at(1000);
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  await h.service.idle();
  expect(withdraws(h.emits)).toStrictEqual([]);

  // The newer one was shown as a toast, Mandate's choice: it goes once seen.
  const k = harness();
  k.report({ windowId: "w1", path: "/projects", lastInputAt: new Date(T0.getTime() - 1000).toISOString() });
  await k.service.notify(request({ channels: ["Browser"] }));
  k.at(500);
  await k.service.notify(request({ text: "The manager asks again." }));
  k.at(1000);
  k.report({ windowId: "w1", path: "/threads/thr_a" });
  await k.service.idle();
  expect(withdraws(k.emits)).toEqual([{ key: "thread:thr_a" }]);
});

test("Telegram keeps every message: one seen or settled stays, and each later notice is a new message", async () => {
  const h = harness({ kinds: CHANNEL_KINDS });
  await h.service.notify(request());
  await h.service.notify(request({ text: "Still going.", level: "news" }));
  h.at(11 * 60_000);
  await h.service.notify(request({ text: "Needs you again." }));
  await h.service.settle("thread:thr_a");
  expect(h.calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage", "sendMessage"]);
  // The windows still close theirs.
  expect(withdraws(h.emits)).toEqual([{ key: "thread:thr_a" }]);

  const seen = harness({ kinds: CHANNEL_KINDS });
  await seen.service.notify(request());
  seen.at(1000);
  seen.report({ windowId: "phone-page", device: "phone", path: "/threads/thr_a" });
  await seen.service.idle();
  expect(seen.calls.map((c) => c.method)).toEqual(["sendMessage"]);
});

// A window in use — visible, focused, touched in the last three minutes —
// that shows a thread's own page with its chat in sight: the user is in that
// thread now.
test("the user is in a thread while a window in use shows its page with its chat in sight", () => {
  const h = harness();
  expect(h.service.userInThread("thr_a")).toBe(false);
  h.report({ windowId: "w1", path: "/threads/thr_a?tab=changes", threadChat: "thr_a" });
  expect([h.service.userInThread("thr_a"), h.service.userInThread("thr_b")]).toEqual([true, false]);
  // The page, its chat behind the worker panel (or a window too old to say).
  h.report({ windowId: "w1", path: "/threads/thr_a" });
  expect(h.service.userInThread("thr_a")).toBe(false);
  // Behind another window, or not touched for over three minutes: not in use.
  h.report({ windowId: "w1", path: "/threads/thr_a", threadChat: "thr_a", focused: false });
  expect(h.service.userInThread("thr_a")).toBe(false);
  h.report({ windowId: "w1", path: "/threads/thr_a", threadChat: "thr_a", lastInputAt: new Date(T0.getTime() - 3 * 60_000 - 1).toISOString() });
  expect(h.service.userInThread("thr_a")).toBe(false);
  // Another page, Home's list included: not the thread, whatever it said last.
  h.report({ windowId: "w1", path: "/home", threadChat: "thr_a" });
  h.report({ windowId: "w2", path: "/agent" });
  expect(h.service.userInThread("thr_a")).toBe(false);
  // A phone in use counts as much as a desktop.
  h.report({ windowId: "w3", path: "/threads/thr_a", threadChat: "thr_a", device: "phone", canShowSystem: false });
  expect(h.service.userInThread("thr_a")).toBe(true);
});
