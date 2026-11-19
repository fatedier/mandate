import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { API_PATHS } from "../src/shared/api-contracts.js";
import type { SideChatDto } from "../src/shared/api/side-chat.js";
import type { AgentClientMessageDto } from "../src/shared/api/agents.js";
import { respond, seedStubProvider } from "./helpers/responses-stub.js";

/**
 * Side chats through the compiled server, the model a stub: one opened from
 * the agent's page forks its conversation onto a page of its own, answers
 * there with a tool that reads and a refused write, and Send puts one card in
 * the main conversation; one discarded leaves nothing. The sidebar lists them
 * under the agent, folded, on a desktop and a phone. And History, read beside
 * a chat scrolled up.
 */

const DECISION = "Keep the old install script for 3.21, with a note that it goes in the next major.";
const ANSWER = "On Nov 2 you kept the old install script, with a note that it goes later.";
const SUMMARY = "- Keep the install script for 3.21.\n- Remove it in the next major.";
const QUESTION = "What did we decide about the install script?";

let server: RunningServer;
let stub: ReturnType<typeof Bun.serve>;
const browser = browserForFile();
let calls = 0;
/** What the personal agent's own calls were sent, newest last. */
const mainInputs: string[] = [];
/** How many calls each side chat's steps made. */
let sideSteps = 0;

/** A side chat's steps: look the decision up, try to pass it on (refused), answer. */
function sideStep(input: string): Response {
  sideSteps += 1;
  const outputs = (input.match(/function_call_output/g) ?? []).length;
  if (outputs === 0) return respond(`s${calls}`, { call: { name: "chat_history_search", args: { query: "install script" } } });
  if (outputs === 1) return respond(`s${calls}`, { call: { name: "send_to_thread", args: { threadId: "thr_none", text: "remind them" } } });
  return respond(`s${calls}`, { text: ANSWER });
}

beforeAll(async () => {
  stub = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "POST" || !url.pathname.endsWith("/responses")) return new Response("not here", { status: 404 });
      const body = await request.json() as Record<string, unknown>;
      const input = JSON.stringify(body.input ?? []);
      calls += 1;
      // A side chat's call carries its first row; the message Send puts in
      // the main conversation starts "[Side chat] The user talked" instead.
      if (input.includes("[Side chat] Everything above")) {
        if (input.includes("The user is sending this side chat")) return respond(`sum${calls}`, { text: SUMMARY });
        return sideStep(input);
      }
      mainInputs.push(input);
      return respond(`x${calls}`, { text: "Noted." });
    }
  });
  server = await startServer({
    configured: true,
    seed(dataDir) {
      seedStubProvider(dataDir, stub.port, (config) => {
        config.agent.personalAgentName = "Juno";
      });
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const personal = agents.getOrCreatePersonalThread();
        // A long conversation: enough to scroll back through.
        for (let i = 1; i <= 20; i++) {
          agents.appendMessage({ threadId: personal.id, role: "user", source: "user", content: { type: "text", text: i === 4 ? DECISION : `Question ${i}: how is the release going?` } });
          agents.appendMessage({ threadId: personal.id, role: "assistant", source: "self", content: { type: "assistant", text: `Answer ${i}: ${"the release notes are coming along. ".repeat(6)}` } });
        }
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => {
  server?.cleanup();
  stub?.stop(true);
});

const api = async <T>(pathname: string, init?: RequestInit): Promise<T> => (await fetch(`${server.baseUrl}${pathname}`, init)).json() as Promise<T>;
const personalMessages = async () => {
  const agent = (await api<{ agent: { threadId: string } }>("/api/agents/personal")).agent;
  return (await api<{ messages: AgentClientMessageDto[] }>(`${API_PATHS.agentThread(agent.threadId)}?limit=200`)).messages;
};
const sideChats = async () => (await api<{ sideChats: SideChatDto[] }>(API_PATHS.sideChats())).sideChats;

async function open(viewport: { width: number; height: number }, path = "/agent"): Promise<Page> {
  const page = await browser.newPage({ viewport, ...(viewport.width < 768 ? { hasTouch: true, isMobile: true } : {}) });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}${path}`);
  if (path === "/agent") await page.getByText("Answer 20:").first().waitFor({ timeout: 15_000 });
  return page;
}

test("a side chat forks the agent, talks on its own page, and Send puts one card in the main conversation", async () => {
  const before = (await personalMessages()).length;
  const page = await open({ width: 1440, height: 900 });
  try {
    await page.getByLabel("Agent actions").click();
    await page.getByRole("menuitem", { name: "New side chat" }).click();
    await page.waitForURL(/\/agent\/side-chats\/thr_/, { timeout: 10_000 });
    const start = page.locator('[data-slot="side-chat-start"]');
    await start.waitFor({ timeout: 10_000 });
    expect(await start.textContent()).toMatch(/^Started from Juno's conversation on \w{3} \d{1,2}\. Thread updates don't come here\.$/);
    await page.locator('[data-slot="side-chat-empty"]').waitFor();
    // No canvas yet: the chat has the row, no empty panel beside it.
    expect(await page.locator('[data-slot="side-chat-canvases"]').count()).toBe(0);
    // Opening it unfolded the agent's side chats in the sidebar.
    const toggle = page.locator('[data-slot="side-chats-toggle"]');
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    const box = page.locator('[data-slot="side-chat-chat"] textarea');
    expect(await box.getAttribute("placeholder")).toBe("Reply in this side chat");
    await box.fill(QUESTION);
    await page.locator('[data-slot="side-chat-chat"] button[aria-label="Send message"]:not([disabled])').click({ timeout: 5_000 });
    await page.locator('[data-slot="side-chat-chat"]').getByText(ANSWER).waitFor({ timeout: 20_000 });
    await page.locator('[data-slot="side-chat-empty"]').waitFor({ state: "detached" });
    expect(sideSteps).toBe(3);
    // Its row is named by its first line.
    await page.locator('[data-slot="side-chat-row"]', { hasText: QUESTION }).waitFor();
    // The main conversation is as it was.
    expect((await personalMessages()).length).toBe(before);
    await look(page, "desktop");

    await page.getByRole("button", { name: "Send to Juno", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('[data-slot="side-chat-summary"]').waitFor({ timeout: 20_000 });
    await dialog.locator("textarea").fill("Go with it.");
    await dialog.getByRole("button", { name: "Send to Juno" }).click();
    await page.waitForURL(/\/agent$/, { timeout: 10_000 });
    const card = page.locator('[data-slot="agent-chat"] [data-slot="side-chat-summary"]');
    await card.waitFor({ timeout: 20_000 });
    await page.locator('[data-slot="agent-chat"]').getByText("Go with it.").waitFor();
    const read = await waitUntil(() => mainInputs.find((input) => input.includes("The user talked this over")) ?? null, { timeout: 20_000, label: "the agent's call on it" });
    expect(read).toContain("Keep the install script for 3.21.");
    expect(read).toContain("Go with it.");
    expect(/The whole side chat: (\S+\.md)/.exec(read)![1]!).toContain("/resources/global/side-chats/");
    // One message more in the main conversation; the side chat is gone.
    const after = await personalMessages();
    expect(after.filter((m) => m.content.type === "text" && "sideChat" in m.content && m.content.sideChat).length).toBe(1);
    expect(await sideChats()).toEqual([]);
    await toggle.waitFor({ state: "detached", timeout: 5_000 });
  } finally {
    await page.close();
  }
}, 90_000);

test("Discard asks and leaves nothing; the sidebar group folds and unfolds, on a desktop and a phone", async () => {
  const page = await open({ width: 1440, height: 900 });
  try {
    await page.getByLabel("Agent actions").click();
    await page.getByRole("menuitem", { name: "New side chat" }).click();
    await page.waitForURL(/\/agent\/side-chats\/thr_/, { timeout: 10_000 });
    // Its header is over its chat, Send in it; with no canvas yet, no panel.
    const header = page.locator('[data-slot="side-chat-chat"] [data-slot="pane-header"]');
    await header.getByRole("button", { name: "Send to Juno", exact: true }).waitFor();
    expect(await page.locator('[data-slot="side-chat-canvases"]').count()).toBe(0);
    // An end that cannot be undone: in the ⋯, not beside Send.
    await page.getByRole("button", { name: "Side chat actions" }).click();
    await page.getByRole("menuitem", { name: "Discard side chat" }).click();
    const confirm = page.locator("[data-confirm-dialog]");
    await confirm.getByText("Discard this side chat?").waitFor();
    await confirm.getByRole("button", { name: "Discard" }).click();
    await page.waitForURL(/\/agent$/, { timeout: 10_000 });
    expect(await sideChats()).toEqual([]);
  } finally {
    await page.close();
  }

  // Two side chats, opened elsewhere: folded under the agent's row.
  for (let i = 0; i < 2; i++) await api(API_PATHS.sideChats(), { method: "POST" });
  const desk = await open({ width: 1440, height: 900 }, "/home");
  try {
    const toggle = desk.locator('[data-slot="side-chats-toggle"]');
    await toggle.waitFor({ timeout: 10_000 });
    // The fold choice of the first test is kept in this browser's storage,
    // which a new page starts without: folded.
    expect([await toggle.getAttribute("aria-expanded"), (await toggle.textContent())?.trim()]).toEqual(["false", "2"]);
    expect(await desk.locator('[data-slot="side-chat-row"]').count()).toBe(0);
    await toggle.click();
    await desk.locator('[data-slot="side-chat-row"]').nth(1).waitFor();
    await desk.locator('[data-slot="side-chat-row"]').first().click();
    await desk.waitForURL(/\/agent\/side-chats\/thr_/, { timeout: 10_000 });
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await desk.close();
  }

  const phone = await open({ width: 390, height: 844 }, "/home");
  try {
    await phone.getByRole("button", { name: "Open navigation" }).tap();
    const toggle = phone.locator('[data-slot="side-chats-toggle"]').last();
    await toggle.waitFor({ timeout: 10_000 });
    await toggle.tap();
    await phone.locator('[data-slot="side-chat-row"]').first().tap();
    await phone.waitForURL(/\/agent\/side-chats\/thr_/, { timeout: 10_000 });
    // Chat / Canvases one at a time; Send and Discard in its ⋯.
    await phone.getByRole("tab", { name: "Canvases" }).tap();
    await phone.getByText("Canvases this side chat writes open here.").waitFor();
    await phone.getByLabel("Side chat actions").tap();
    await phone.getByRole("menuitem", { name: "Send to Juno" }).waitFor();
    await phone.getByRole("menuitem", { name: "Discard side chat" }).waitFor();
    await look(phone, "phone");
  } finally {
    await phone.close();
  }
}, 90_000);

/** Scrolls the chat up, as a reader does (the wheel over the middle of the
 *  chat pane), and names the row at its top. */
async function readUp(page: Page): Promise<string | null> {
  const box = (await page.locator('[data-slot="agent-chat"]').first().boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -600);
  await page.locator('[data-slot="agent-chat"]').getByLabel("Scroll to latest message").waitFor({ timeout: 5_000 });
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-slot="agent-chat"] [data-slot="transcript-column"]')!.parentElement!;
    const top = scroller.getBoundingClientRect().top;
    const row = [...scroller.querySelectorAll('[data-slot="transcript-row"]')].find((r) => r.getBoundingClientRect().bottom > top);
    return row?.getAttribute("data-row-key") ?? null;
  });
}

/** Whether History shows the row named `key`. */
const historyShows = (page: Page, key: string | null) => page.evaluate((k) => {
  const scroller = document.querySelector('[data-slot="history-tab"] [data-slot="transcript-column"]')!.parentElement!;
  const box = scroller.getBoundingClientRect();
  const row = scroller.querySelector(`[data-row-key="${k}"]`)?.getBoundingClientRect();
  return row ? row.bottom > box.top && row.top < box.bottom : false;
}, key);
const chatAtLatest = (page: Page) => waitUntil(async () => !(await page.locator('[data-slot="agent-chat"]').getByLabel("Scroll to latest message").isVisible()) || null, { timeout: 5_000, label: "the chat back at its latest" });

test("History opened from a chat scrolled up opens at what was being read, the chat goes back to its latest", async () => {
  const page = await open({ width: 1440, height: 900 });
  try {
    const reading = await readUp(page);
    // Nothing floats over what is being read but the way to the latest.
    expect(await page.locator('[data-slot="read-beside"]').count()).toBe(0);
    await page.getByLabel("Agent actions").click();
    await page.getByRole("menuitem", { name: "History" }).click();
    const history = page.locator('[data-slot="history-tab"]');
    await history.waitFor({ timeout: 5_000 });
    expect(await historyShows(page, reading)).toBe(true);
    await chatAtLatest(page);
    await page.getByRole("button", { name: "Close History" }).click();
    await history.waitFor({ state: "detached", timeout: 5_000 });
  } finally {
    await page.close();
  }

  const phone = await open({ width: 390, height: 844 });
  try {
    const reading = await readUp(phone);
    await phone.getByLabel("Agent actions").click();
    await phone.getByRole("menuitem", { name: "History" }).click();
    await phone.locator('[data-slot="history-tab"]').waitFor({ timeout: 5_000 });
    expect(await historyShows(phone, reading)).toBe(true);
    // The chat comes back from the side, at its latest.
    await phone.getByRole("tab", { name: "Chat" }).click();
    await phone.locator('[data-slot="agent-chat"]').getByText("Answer 20:").waitFor({ timeout: 5_000 });
  } finally {
    await phone.close();
  }
}, 90_000);
