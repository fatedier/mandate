import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Browser, Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { look, trackPageErrors } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { PageStore } from "../src/server/modules/page/page-store.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

/**
 * A reply opened in the right panel, through the built app: the button after
 * Copy opens it as a tab named by its first line; another browser sees the
 * tab without a reload and its Close removes it everywhere; a thread's tab
 * follows Workers; on a phone a tap opens the panel on it and Back
 * returns to the chat. Pictures for a look are taken when
 * MANDATE_E2E_CAPTURE_FRAMES=1.
 */

let server: RunningServer;
const browser = browserForFile();
let threadId = "";

const CHECK = [
  "**Release check**: two of three albums are ready.",
  "",
  "| Album | State |",
  "|---|---|",
  "| holiday | ready |",
  "| garden | waits on its photo import |"
].join("\n");
const IMPORT = "**Photo import**: done in 20 minutes, no errors.";
/** Long enough to scroll in the panel. */
const NOTES = ["**Release notes draft** for 3.21", "", ...Array.from({ length: 60 }, (_, i) => `- Change ${i + 1}: a line of the draft notes.`)].join("\n");

function seed(dataDir: string): void {
  const file = path.join(dataDir, "config.json");
  const config = (flatFromFile(JSON.parse(fs.readFileSync(file, "utf8"))) as unknown as Record<string, any>);
  config.agent = { ...config.agent, personalAgentName: "Juno" };
  fs.writeFileSync(file, JSON.stringify(fileFromFlat(config), null, 2));
  const store = new MandateStore(dataDir);
  try {
    new PageStore(store.db).publish([{ path: "index.html", bytes: new TextEncoder().encode("<title>Today</title><h1 id=\"head\">What I'm following</h1>") }], "seed");
    const agents = new AgentStore(store.db);
    let n = 0;
    const say = (thread: string, role: "user" | "assistant", text: string) => {
      n += 1;
      agents.appendMessage(role === "user"
        ? { threadId: thread, role, source: "user", content: { type: "text", text } }
        : { threadId: thread, role, source: "self", wakeId: `wake_${n}`, content: { type: "assistant", text } });
    };
    const personal = agents.getOrCreatePersonalThread().id;
    say(personal, "user", "What is left before the release?");
    say(personal, "assistant", CHECK);
    say(personal, "user", "Run the garden photo import first.");
    say(personal, "assistant", "Started it; I will tell you when it is done.");
    say(personal, "user", "Draft the release notes.");
    say(personal, "assistant", NOTES);
    threadId = agents.createManagerThread("Release 3.21", { titleByUser: true }).id;
    say(threadId, "user", "Did the photo import finish?");
    say(threadId, "assistant", IMPORT);
  } finally {
    store.db.close();
  }
}

beforeAll(async () => {
  server = await startServer({ configured: true, seed });
}, 60_000);
afterAll(() => server?.cleanup());

async function open(target: Browser, url: string, viewport: { width: number; height: number }, phone = false): Promise<{ page: Page; errors: string[] }> {
  const context = await target.newContext({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = trackPageErrors(page);
  await page.goto(`${server.baseUrl}${url}`);
  await page.locator('[data-slot="transcript-row"]').first().waitFor();
  return { page, errors };
}
const row = (page: Page, text: string) => page.locator('[data-slot="transcript-row"]', { hasText: text }).first();
const openButton = (page: Page, text: string) => row(page, text).locator('[data-slot="open-in-panel"]');
const replyTabs = (page: Page) => page.locator('[role="tab"][data-reply-tab]');

test("a reply opens as a tab beside Personal agent's page, the same in another browser, and goes from both when closed", async () => {
  const first = await open(browser, "/agent", { width: 1440, height: 900 });
  const second = await open(browser, "/agent", { width: 1440, height: 900 });
  try {
    await row(first.page, "Release check").hover();
    await openButton(first.page, "Release check").click();
    // Selected once the add answers: the event's read can draw the tab first.
    const tab = first.page.locator('[role="tab"][data-reply-tab][aria-selected="true"]');
    await tab.waitFor();
    expect((await tab.textContent())?.trim()).toBe("Release check: two of three albums are ready.");
    const view = first.page.locator('[data-slot="reply-tab-view"]');
    expect(await view.locator("h2").textContent()).toBe("Reply");
    expect(await view.locator("td", { hasText: "waits on its photo import" }).count()).toBe(1);
    expect(await openButton(first.page, "Release check").getAttribute("aria-label")).toBe("Show in panel");
    await look(first.page, "agent-desktop");
    // Again, from Page: the same tab shown, not a second one.
    await first.page.locator('[role="tablist"][aria-label="Page tabs"] [role="tab"]', { hasText: "Page" }).click();
    await first.page.locator('[data-slot="agent-page-body"]:not(.hidden)').waitFor();
    await row(first.page, "Release check").hover();
    await openButton(first.page, "Release check").click();
    await tab.waitFor();
    expect(await replyTabs(first.page).count()).toBe(1);

    // The other browser hears of it and closes it; the first gives way to Page.
    const elsewhere = second.page.locator('[role="tab"][data-reply-tab]');
    await elsewhere.waitFor();
    await elsewhere.locator('[aria-label^="Close"]').click();
    await elsewhere.waitFor({ state: "detached" });
    await replyTabs(first.page).first().waitFor({ state: "detached" });
    await first.page.locator('[data-slot="agent-page-body"]:not(.hidden)').waitFor();
    expect([...first.errors, ...second.errors]).toEqual([]);
  } finally {
    await first.page.context().close();
    await second.page.context().close();
  }
}, 60_000);

test("a thread's reply tab follows Workers", async () => {
  const { page, errors } = await open(browser, `/threads/${threadId}`, { width: 1440, height: 900 });
  try {
    // Not "Photo import": the question above says it too (hasText ignores case).
    await row(page, "done in 20 minutes").hover();
    await openButton(page, "done in 20 minutes").click();
    const panel = page.locator('[data-slot="worker-panel-side"]');
    await panel.locator('[role="tab"][data-reply-tab][aria-selected="true"]').waitFor();
    const names = await panel.locator('[role="tablist"][aria-label="Worker tabs"] [role="tab"]').allTextContents();
    expect(names.map((name) => name.replace(/\s+/g, " ").trim())).toEqual(["Workers0", "Photo import: done in 20 minutes, no errors."]);
    await look(page, "thread-desktop");
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 60_000);

test("on a phone a tap opens the panel on the reply, and Back returns to the chat", async () => {
  const { page, errors } = await open(browser, "/agent", { width: 390, height: 844 }, true);
  try {
    // Opened in the first test and closed again: this one opens it afresh.
    await openButton(page, "Release check").scrollIntoViewIfNeeded();
    await openButton(page, "Release check").tap();
    const pill = (name: string) => page.locator('[role="tablist"][aria-label="View"] [role="tab"]', { hasText: name });
    await page.locator('[role="tablist"][aria-label="View"] [role="tab"][aria-selected="true"]', { hasText: "Panel" }).waitFor();
    // On screen, not beside it: the side has slid in.
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-slot="reply-tab-view"]')?.getBoundingClientRect();
      return box !== undefined && box.left >= 0 && box.right <= window.innerWidth + 1 && box.width > 300;
    });
    expect(await page.locator('[role="tablist"][aria-label="Page tabs"] [role="tab"]').count()).toBe(2);
    // Back takes the step the page pushed when it opened.
    await page.waitForFunction(() => (history.state as { usr?: { agentPage?: boolean } } | null)?.usr?.agentPage === true);
    await look(page, "agent-phone");
    await page.goBack();
    await page.locator('[role="tablist"][aria-label="View"] [role="tab"][aria-selected="true"]', { hasText: "Chat" }).waitFor();
    expect(await pill("Panel").getAttribute("aria-selected")).toBe("false");
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-slot="reply-tab-view"]')?.getBoundingClientRect();
      return box === undefined || box.left >= window.innerWidth - 1 || box.width === 0;
    });
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 60_000);

test("a long reply switched away from and back to keeps its place", async () => {
  const { page, errors } = await open(browser, "/agent", { width: 1440, height: 900 });
  try {
    await row(page, "Release notes draft").hover();
    await openButton(page, "Release notes draft").click();
    const scroller = page.locator('[data-slot="reply-tab-view"]:not(.hidden) .overflow-y-auto');
    await scroller.waitFor();
    await scroller.evaluate((el) => { el.scrollTop = 600; });
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
    await page.locator('[role="tablist"][aria-label="Page tabs"] [role="tab"]', { hasText: "Page" }).click();
    await page.locator('[data-slot="agent-page-body"]:not(.hidden)').waitFor();
    await page.locator('[role="tab"][data-reply-tab]', { hasText: "Release notes draft" }).click();
    await scroller.waitFor();
    expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 60_000);

test("on a phone a thread's reply opens in its sheet, and Back closes the sheet", async () => {
  const { page, errors } = await open(browser, `/threads/${threadId}`, { width: 390, height: 844 }, true);
  try {
    await openButton(page, "done in 20 minutes").scrollIntoViewIfNeeded();
    await openButton(page, "done in 20 minutes").tap();
    const sheet = page.locator('[data-slot="worker-panel-sheet"]');
    await sheet.locator('[role="tab"][data-reply-tab][aria-selected="true"]').waitFor();
    // On screen, in the sheet pulled up to full height.
    await page.waitForFunction(() => {
      const box = document.querySelector('[data-slot="worker-panel-sheet"] [data-slot="reply-tab-view"]:not(.hidden)')?.getBoundingClientRect();
      return box !== undefined && box.top >= 0 && box.top < window.innerHeight / 3 && box.height > 200;
    });
    expect(await sheet.locator('[data-slot="reply-tab-view"]:not(.hidden)').textContent()).toContain("done in 20 minutes, no errors.");
    // Back takes the step the sheet pushed when it opened.
    await page.waitForFunction(() => (history.state as { usr?: { workerSheet?: boolean } } | null)?.usr?.workerSheet === true);
    await look(page, "thread-phone");
    await page.goBack();
    await sheet.waitFor({ state: "detached" });
    await row(page, "done in 20 minutes").waitFor({ state: "visible" });
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 60_000);
