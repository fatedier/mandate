import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { startServer, type RunningServer } from "./helpers/server.js";
import { expectFit, onPhone, PHONE, startTouchHarness, stopTouchHarness } from "./helpers/touch-targets";
import { pressBack, recordCloseWatchers } from "./helpers/close-requests";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { settle } from "./helpers/settle.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { formatSubagentResultText, subagentResultMetadata } from "../src/shared/subagent-messages.js";

/**
 * A subagent's result is one line in the conversation that started it. Its
 * reply is not drawn there: the line opens it in a box at the line, inside
 * the window and scrolling inside, and on a phone in the sheet. The thread is
 * seeded with a result whose reply is long.
 */

const TITLE = "Check the session table's indexes";
const REPLY = [
  "## Findings",
  "",
  "The session table has **one index**, on user_id alone.",
  "",
  ...Array.from({ length: 40 }, (_, i) => `- Checked query ${i + 1}: it filters on user_id and expires_at.`)
].join("\n");

let browser: Browser;
let server: RunningServer;
let threadId = "";

beforeAll(async () => {
  browser = (await startTouchHarness({ server: false })).browser;
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        threadId = agent.createManagerThread("Login timeout").id;
        agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "Logins time out. Find out why, and look at the session table's indexes." } });
        agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: "w1", content: { type: "assistant", text: "I'll read the auth log; a subagent checks the indexes." } });
        const result = { taskId: "task_e2e", outcome: "finished" as const, title: TITLE, durationMs: 134_000, reply: REPLY, error: null };
        agent.appendMessage({
          threadId, role: "user", source: "subagent-result",
          content: { type: "text", text: formatSubagentResultText(result), metadata: subagentResultMetadata(result) }
        });
        agent.appendMessage({ threadId, role: "assistant", source: "self", wakeId: "w2", content: { type: "assistant", text: "The table lacks an index on (user_id, expires_at)." } });
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(async () => {
  await stopTouchHarness();
  server?.cleanup();
});

const OPEN = '[data-slot="subagent-result-open"]';
const BOX = '[data-slot="subagent-reply"]';

test("on a desktop the result is one line; its reply opens in a box at it, inside the window and scrolling inside; Esc closes it", async () => {
  // Wide enough for the box: under 768px the page takes the phone's layout,
  // and the sheet.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    const line = page.locator(OPEN);
    await line.waitFor();
    await page.getByText("The table lacks an index on (user_id, expires_at).").waitFor();
    expect((await page.locator('[data-slot="subagent-result-head"]').innerText()).trim()).toBe(`Subagent · ${TITLE} · Finished · 2m 14s`);
    // One line, and the reply is not in the conversation.
    expect((await line.boundingBox())!.height).toBeLessThan(48);
    expect(await page.getByText("The session table has").count()).toBe(0);
    await line.click();
    const box = page.locator(BOX);
    await box.waitFor();
    await settle(page);
    expect((await box.locator('[data-slot="subagent-reply-title"]').innerText()).trim()).toBe(TITLE);
    expect((await box.locator('[data-slot="subagent-reply-state"]').innerText()).trim()).toBe("Subagent · Finished · 2m 14s");
    expect(await box.locator('[data-slot="subagent-result-reply"] strong').innerText()).toBe("one index");
    const at = await page.evaluate((selector) => {
      const box = document.querySelector(selector)!.getBoundingClientRect();
      const scroller = document.querySelector(`${selector} [data-slot="subagent-result-reply"]`)!.parentElement!;
      return { top: box.top, bottom: box.bottom, window: innerHeight, shown: scroller.clientHeight, whole: scroller.scrollHeight, role: document.querySelector(selector)!.getAttribute("role") };
    }, BOX);
    // The box at the line, not the sheet.
    expect(at.role).toBe("dialog");
    expect(await box.locator('[data-slot="bottom-sheet-body"]').count()).toBe(0);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.bottom).toBeLessThanOrEqual(at.window);
    expect(at.whole).toBeGreaterThan(at.shown);
    await page.keyboard.press("Escape");
    await box.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-slot") === "subagent-result-open");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("on a phone the line opens the reply in the sheet and Back closes it; the line keeps the touch law", async () => {
  const url = `${server.baseUrl}/threads/${threadId}`;
  // The sheet holds nothing to tap (no way elsewhere, as a thread's reply
  // has): only the line is measured.
  expectFit("thread, a subagent's result line", await onPhone(url, OPEN));

  const phone = await browser.newContext(PHONE);
  try {
    const page = await phone.newPage();
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    await recordCloseWatchers(page);
    await page.goto(url);
    await page.locator(OPEN).tap();
    const sheet = page.locator(BOX);
    await sheet.locator('[data-slot="subagent-result-reply"]').waitFor();
    expect(await sheet.locator('[data-slot="bottom-sheet-body"]').count()).toBe(1);
    const width = await sheet.evaluate((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, window: innerWidth }; });
    expect(width.left).toBe(0);
    expect(width.right).toBe(width.window);
    // Back closes the sheet, not the thread.
    expect(await pressBack(page)).toBe(true);
    await sheet.waitFor({ state: "detached" });
    expect(page.url()).toBe(url);
    expect(errors).toEqual([]);
  } finally {
    await phone.close();
  }
}, 60_000);
