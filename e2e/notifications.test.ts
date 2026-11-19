import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { settle } from "./helpers/settle.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { startTelegramStub, type TelegramStub } from "./helpers/telegram-stub.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { readSse } from "../tests/helpers/sse.js";
import { API_ROUTES } from "../src/shared/api-contracts.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { assertStubProvider, respond, seedStubProvider, shown } from "./helpers/responses-stub.js";

/**
 * Notifications through the real server: the personal agent (a stub model speaking
 * the Responses stream) calls `notify`; with no window in use it goes to a
 * stub Telegram at once and is deleted there once the thread is opened; with
 * a window in use elsewhere it is a toast there and Telegram hears nothing.
 * Settings connects a bot and sends a test.
 */

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
let telegram: TelegramStub;
const browser = browserForFile();
const seeded = { login: "", docs: "", release: "", changelog: "", onboarding: "", canvas: "" };
const LINK_BASE = "http://mac.example.net:8080";

/** The request from the newest case message on: one conversation holds
 *  every case (and context the server adds), and only the newest case is
 *  being answered. */
function latestTurn(body: Record<string, any>): Array<Record<string, any>> {
  const input = (body.input ?? []) as Array<Record<string, any>>;
  let at = input.length - 1;
  while (at >= 0 && !(input[at]!.role === "user" && shown({ input: [input[at]] }).includes("-case:"))) at -= 1;
  return input.slice(Math.max(0, at));
}

const hasToolOutput = (turn: Array<Record<string, any>>) => turn.some((item) => item.type === "function_call_output");

beforeAll(async () => {
  telegram = startTelegramStub();
  let step = 0;
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, any>;
      const turn = latestTurn(body);
      const text = shown({ input: turn });
      const id = `n${++step}`;
      if (text.includes("notify-case")) {
        if (!hasToolOutput(turn)) {
          return respond(id, { call: { name: "notify", args: { title: "Login fix needs your call", text: "The manager asks whether the migration test may use staging.", threadId: seeded.login } } });
        }
        return respond(id, { text: "I told you." });
      }
      if (text.includes("dialog-case")) {
        if (!hasToolOutput(turn)) {
          return respond(id, { call: { name: "notify", args: { title: "Release notes are ready", text: "They are drafted for 2.4.", threadId: seeded.release, level: "news" } } });
        }
        return respond(id, { text: "I told you." });
      }
      if (text.includes("canvas-case")) {
        if (!hasToolOutput(turn)) {
          return respond(id, { call: { name: "notify", args: { title: "The changelog is written", text: "Everything since 2.3 is in.", threadId: seeded.changelog, level: "news" } } });
        }
        return respond(id, { text: "I told you." });
      }
      if (text.includes("named-case")) {
        if (!hasToolOutput(turn)) {
          // Its context lists the channels it can name.
          const all = shown(body);
          if (!all.includes("## Notification channels") || !all.includes("- Phone · Telegram")) return respond(id, { text: "No channel list in my context." });
          return respond(id, { call: { name: "notify", args: { title: "Your phone, as asked", text: "This one goes to your phone.", channels: ["Phone"], level: "news" } } });
        }
        return respond(id, { text: "Sent to your phone." });
      }
      if (text.includes("drawer-case")) {
        if (!hasToolOutput(turn)) {
          return respond(id, { call: { name: "notify", args: { title: "Onboarding guide is up", text: "It covers the first week.", threadId: seeded.onboarding, level: "news" } } });
        }
        return respond(id, { text: "I told you." });
      }
      if (text.includes("toast-case")) {
        if (!hasToolOutput(turn)) {
          return respond(id, { call: { name: "notify", args: { title: "Docs move is done", text: "Every guide moved; the links were checked.", threadId: seeded.docs, level: "news" } } });
        }
        return respond(id, { text: "I told you." });
      }
      return respond(id, { text: "Noted." });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port, (config) => {
        config.notifications = {
          linkBase: LINK_BASE,
          telegramApiBase: telegram.url,
          channels: [{ id: "nch_phone", kind: "telegram", name: "Phone", enabled: true, includeText: true, values: { botToken: "000000:example-token", chatId: "424242", botName: "@mandate_example_bot" } }]
        };
      });
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        seeded.login = agents.createManagerThread("Login fix").id;
        seeded.docs = agents.createManagerThread("Docs move").id;
        seeded.release = agents.createManagerThread("Release notes").id;
        seeded.changelog = agents.createManagerThread("Changelog").id;
        seeded.onboarding = agents.createManagerThread("Onboarding").id;
        // A canvas the Login fix thread links to: opened from there, over the chat.
        const canvases = new CanvasStore(store.db, dataDir);
        const canvas = canvases.create({ title: "Migration plan", scope: "manager", scopeId: seeded.login, threadId: seeded.login });
        canvases.writeSource(canvas.id, "<h1>Migration plan</h1><p>Staging first.</p>");
        if (canvases.publishSource(canvas.id).error) throw new Error("canvas did not publish");
        seeded.canvas = canvas.id;
        agents.appendMessage({ threadId: seeded.login, role: "assistant", source: "self", content: { type: "assistant", text: `The plan is in [the migration plan](/canvas/${canvas.id}).` } });
      } finally {
        store.db.close();
      }
    }
  });
  await assertStubProvider(server.baseUrl, stub.port);
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
  telegram?.stop();
});

async function sayToAgent(content: string): Promise<void> {
  const agent = (await (await fetch(`${server.baseUrl}/api/agents/personal`)).json() as { agent: { threadId: string } }).agent;
  const res = await fetch(`${server.baseUrl}/api/agents/threads/${agent.threadId}/messages`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content })
  });
  expect(res.status).toBe(202);
}

async function open(route: string, options: { width?: number; height?: number; phone?: boolean } = {}): Promise<Page> {
  const viewport = { width: options.width ?? 1440, height: options.height ?? 900 };
  const page = await browser.newPage(options.phone ? { viewport, isMobile: true, hasTouch: true } : { viewport });
  page.setDefaultTimeout(20_000);
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}${route}`);
  return page;
}

/** The window is in use: a key pressed in it. */
async function touch(page: Page): Promise<void> {
  await page.keyboard.press("Shift");
}

const sent = () => telegram.calls.filter((call) => call.method === "sendMessage");

test("The personal agent's notify reaches Telegram, and opening the thread leaves the message there", async () => {
  await sayToAgent("notify-case: tell me what the login fix needs");
  const message = await waitUntil(() => sent().find((call) => String(call.body.text).includes("Login fix needs your call")), { timeout: 20_000, label: "the Telegram message" });
  expect(message.body).toMatchObject({
    chat_id: "424242",
    text: "<b>Login fix needs your call</b>\n\nThe manager asks whether the migration test may use staging.",
    reply_markup: { inline_keyboard: [[{ text: "Open in Mandate", url: `${LINK_BASE}/threads/${seeded.login}` }]] }
  });
  // Seen in Mandate, the matter's notices close in the windows; on Telegram
  // the message stays as it was sent, neither edited nor deleted.
  const controller = new AbortController();
  const events = readSse(await fetch(`${server.baseUrl}${API_ROUTES.events}`, { signal: controller.signal }));
  const page = await open(`/threads/${seeded.login}`);
  try {
    // Opened, and only read: no key pressed.
    await page.locator('[data-slot="composer"]').waitFor();
    await events.until((e) => e.event === "notificationWithdraw" && String((e.data as { key?: unknown }).key).includes(seeded.login));
    expect(telegram.calls.filter((call) => call.method === "deleteMessage" || call.method === "editMessageText")).toEqual([]);
  } finally {
    controller.abort();
    await page.close();
  }
}, 60_000);

test("a window in use on another page gets the toast, and Telegram nothing", async () => {
  const before = sent().length;
  const page = await open("/projects");
  try {
    await page.locator("main").waitFor();
    await touch(page);
    await sayToAgent("toast-case: tell me when the docs move is done");
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Docs move is done" });
    await toast.waitFor();
    expect(await toast.textContent()).toContain("Every guide moved; the links were checked.");
    // The personal agent was told it went to this window alone: nothing waits to
    // reach the phone later.
    const told = await waitUntil(async () => {
      const agent = (await (await fetch(`${server.baseUrl}/api/agents/personal`)).json() as { agent: { threadId: string } }).agent;
      const transcript = JSON.stringify(await (await fetch(`${server.baseUrl}/api/agents/threads/${agent.threadId}`)).json());
      return transcript.includes("Sent to: Browser") ? transcript : null;
    }, { timeout: 10_000, label: "the notify outcome in the personal agent's transcript" });
    expect(told).toContain("Sent to: Browser.");
    expect(told).not.toContain("Sent to: Browser, Phone");
    await toast.getByRole("button", { name: "Open" }).click();
    await page.waitForURL(`**/threads/${seeded.docs}`);
    expect(sent().length).toBe(before);
  } finally {
    await page.close();
  }
}, 60_000);

test("a toast over an open dialog can still be opened", async () => {
  const page = await open("/settings?tab=notifications");
  try {
    await page.getByText("Telegram · @mandate_example_bot").first().waitFor();
    await touch(page);
    // A modal dialog stops the page under it from taking clicks.
    await page.getByRole("button", { name: "Add channel" }).click();
    await page.getByRole("dialog").waitFor();
    await sayToAgent("dialog-case: tell me when the release notes are ready");
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Release notes are ready" });
    await toast.waitFor();
    await toast.getByRole("button", { name: "Open" }).click({ timeout: 5000 });
    await page.waitForURL(`**/threads/${seeded.release}`);
  } finally {
    await page.close();
  }
}, 60_000);

test("a notice's Open over a canvas opens its thread; the canvas does not take the press as a click outside", async () => {
  // A phone: a thread has no side panel there, so a canvas opens over it.
  const page = await open(`/threads/${seeded.login}`, { width: 390, height: 844, phone: true });
  try {
    await page.getByRole("link", { name: "the migration plan", exact: true }).click();
    await page.getByRole("dialog", { name: "Canvas", exact: true }).waitFor();
    await touch(page);
    // A matter of its own: a window of an earlier test may still be counted
    // on Release notes (a closed test page sends no "gone").
    await sayToAgent("canvas-case: tell me when the changelog is written");
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "The changelog is written" });
    await toast.waitFor();
    await toast.getByRole("button", { name: "Open" }).click({ timeout: 5000 });
    await page.waitForFunction((path) => location.pathname === path, `/threads/${seeded.changelog}`);
    // Not taken back by the canvas closing behind the press: by the end of
    // what is still moving (the canvas leaving, were it closed), it would have been.
    await settle(page);
    expect(await page.evaluate(() => location.pathname)).toBe(`/threads/${seeded.changelog}`);
  } finally {
    await page.close();
  }
}, 60_000);

test("a notice's Open over the phone's navigation drawer opens its thread and closes the drawer", async () => {
  const page = await open(`/threads/${seeded.login}`, { width: 390, height: 844, phone: true });
  try {
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = page.getByRole("dialog", { name: "Mandate", exact: true });
    await drawer.waitFor();
    await touch(page);
    await sayToAgent("drawer-case: tell me when the onboarding guide is up");
    const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Onboarding guide is up" });
    await toast.waitFor();
    await toast.getByRole("button", { name: "Open" }).click({ timeout: 5000 });
    await page.waitForFunction((path) => location.pathname === path, `/threads/${seeded.onboarding}`);
    // The drawer stays mounted across pages: left open, it would cover the thread.
    await drawer.waitFor({ state: "hidden", timeout: 5000 });
  } finally {
    await page.close();
  }
}, 60_000);

// That a message sent to a named channel stays there once seen is the
// service's rule (tests/notifications-service.test.ts): Telegram withdraws
// nothing, so this stub could not show it either way.
test("asked to, the personal agent sends to the phone while the user looks at its chat", async () => {
  const page = await open("/agent");
  try {
    await page.locator("main").waitFor();
    await touch(page);
    const before = sent().length;
    await sayToAgent("named-case: send it to my phone");
    await waitUntil(() => sent().slice(before).find((call) => String(call.body.text).includes("Your phone, as asked")), { timeout: 20_000, label: "the Telegram message" });
  } finally {
    await page.close();
  }
}, 60_000);

test("Settings connects a bot and sends a test", async () => {
  const page = await open("/settings?tab=notifications");
  try {
    await page.getByText("Telegram · @mandate_example_bot").waitFor();
    await page.getByRole("button", { name: "Add channel" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Tablet");
    await dialog.getByLabel("Bot token").fill("000001:example-token");
    await dialog.getByRole("button", { name: "Connect" }).click();
    await dialog.getByText("Connected to @mandate_example_bot.").waitFor();
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "detached" });
    const row = page.locator('[data-slot="setting-row"]').filter({ has: page.locator('[data-slot="setting-label"]', { hasText: /^Tablet$/ }) });
    await row.getByRole("button", { name: "Send test" }).click();
    await row.getByText(/Sent at \d\d:\d\d\. Check your phone\./).waitFor();
    const test = sent().find((call) => call.token === "000001:example-token");
    expect(test?.body).toMatchObject({ chat_id: "424242", text: "<b>Test from Mandate</b>\n\nNotifications reach you here." });
  } finally {
    await page.close();
  }
}, 60_000);

test("the Notifications settings fit a phone", async () => {
  const page = await open("/settings?tab=notifications", { width: 390, height: 844, phone: true });
  try {
    await page.getByText("Open links at").first().waitFor();
    expect(await pageOverflow(page)).toEqual([]);
  } finally {
    await page.close();
  }
}, 60_000);
