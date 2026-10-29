import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { seedThreadNotice } from "./helpers/global-notice.js";
import { seedNamedAgentWithVoice, startServer, type RunningServer } from "./helpers/server.js";
import { settle } from "./helpers/settle.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { ThreadNoticeStop } from "../src/shared/thread-notice.js";

/**
 * A thread's name on the line over the agent's reply opens what that thread
 * said, in place: a box at the name that stays inside the window, on a phone
 * the sheet. Going to the thread is a button in it. The agent's conversation
 * is seeded: three threads that stopped, the last with a long reply, so its
 * line is at the bottom of the page.
 */

const SHORT = "3.21 is **ready** to tag. The changelog is written.";
const LONG = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: checked module ${i + 1} and found nothing to change.`).join("\n\n");
const THREADS: Array<{ title: string; stop: ThreadNoticeStop; reply: string | null }> = [
  { title: "project-1 3.21 release", stop: "done", reply: SHORT },
  { title: "Docs overhaul", stop: "stopped", reply: null },
  { title: "Flaky upload test", stop: "needs_you", reply: LONG }
];

let server: RunningServer;
const threadIds: string[] = [];
const browser = browserForFile();

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const configFile = path.join(dataDir, "config.json");
      const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
      seedNamedAgentWithVoice(config);
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        for (const t of THREADS) {
          const thread = agent.createManagerThread(t.title);
          threadIds.push(thread.id);
          seedThreadNotice(store.db, agent, { threadId: thread.id, ...t });
        }
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => server?.cleanup());

async function openAgent(page: Page) {
  page.setDefaultTimeout(8000);
  await page.goto(`${server.baseUrl}/agent`);
  await page.locator('[data-slot="notice-name"]').nth(2).waitFor();
  await settle(page);
}

/** The box, the name it opened from, and the window, as the browser lays them out. */
async function layout(page: Page, index: number) {
  return page.evaluate((i) => {
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
    const box = document.querySelector('[data-slot="thread-reply"]')!;
    const body = box.querySelector('[data-slot="thread-reply-body"]')?.parentElement ?? null;
    return {
      window: { width: innerWidth, height: innerHeight },
      name: rect(document.querySelectorAll('[data-slot="notice-name"]')[i]!),
      box: rect(box),
      go: rect(box.querySelector('[data-slot="thread-reply-go"]')!),
      body: body ? { shown: body.clientHeight, whole: body.scrollHeight } : null
    };
  }, index);
}

test("a thread's name opens what it said in a box at the name; the page stays, and Esc or a click outside closes it", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = trackPageErrors(page);
  try {
    await openAgent(page);
    const name = page.locator('[data-slot="notice-name"]').nth(0);
    const box = page.locator('[data-slot="thread-reply"]');
    await name.scrollIntoViewIfNeeded();
    expect(await box.count()).toBe(0);
    await name.click();
    await box.waitFor();
    await settle(page);
    expect((await box.locator('[data-slot="thread-reply-title"]').innerText()).trim()).toBe("project-1 3.21 release");
    expect((await box.locator('[data-slot="thread-reply-state"]').innerText()).trim()).toMatch(/^says your request is done · \d{2}:\d{2}$/);
    expect((await box.locator('[data-slot="thread-reply-body"]').innerText()).trim()).toBe("3.21 is ready to tag. The changelog is written.");
    expect(new URL(page.url()).pathname).toBe("/agent");
    // At the name: under its line, starting where the name starts, as tall as the reply needs.
    const at = await layout(page, 0);
    expect(at.box.top).toBeGreaterThanOrEqual(at.name.bottom);
    expect(at.box.top - at.name.bottom).toBeLessThanOrEqual(12);
    expect(Math.abs(at.box.left - at.name.left)).toBeLessThanOrEqual(1);
    expect(at.body!.shown).toBe(at.body!.whole);
    // Esc closes it and the name has the keyboard again.
    await page.keyboard.press("Escape");
    await box.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-slot") === "notice-name");
    // So does a click anywhere else, which does nothing more.
    await name.click();
    await box.waitFor();
    await page.locator('[data-slot="transcript-column"]').click({ position: { x: 4, y: 4 } });
    await box.waitFor({ state: "detached" });
    expect(new URL(page.url()).pathname).toBe("/agent");
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("a long reply on the last line of the page: the box opens upward, stays inside the window, scrolls inside, and its button leads to the thread", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = trackPageErrors(page);
  try {
    await openAgent(page);
    // As the page opens: at the end of the conversation, the newest line low in the window.
    const name = page.locator('[data-slot="notice-name"]').nth(2);
    await name.click();
    const box = page.locator('[data-slot="thread-reply"]');
    await box.waitFor();
    await settle(page);
    const at = await layout(page, 2);
    expect(at.name.top).toBeGreaterThan(at.window.height / 2);
    expect(at.box.bottom).toBeLessThanOrEqual(at.name.top);
    expect(at.box.top).toBeGreaterThanOrEqual(0);
    expect(at.box.height).toBeLessThanOrEqual(480.5);
    expect(at.body!.whole).toBeGreaterThan(at.body!.shown);
    // The way to the thread is in view whatever the reply's length.
    expect(at.go.top).toBeGreaterThanOrEqual(at.box.top);
    expect(at.go.bottom).toBeLessThanOrEqual(at.box.bottom);
    await box.locator('[data-slot="thread-reply-go"]').click();
    await page.waitForURL(new RegExp(`/threads/${threadIds[2]}$`));
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);

test("in a short window the box is as tall as the window leaves it, never past its edge", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 420 } });
  try {
    await openAgent(page);
    await page.locator('[data-slot="notice-name"]').nth(2).click();
    await page.locator('[data-slot="thread-reply"]').waitFor();
    await settle(page);
    const at = await layout(page, 2);
    expect(at.box.top).toBeGreaterThanOrEqual(0);
    expect(at.box.bottom).toBeLessThanOrEqual(at.window.height);
    expect(at.box.height).toBeLessThan(420);
    expect(at.go.bottom).toBeLessThanOrEqual(at.box.bottom);
    expect(at.body!.whole).toBeGreaterThan(at.body!.shown);
  } finally {
    await page.close();
  }
}, 30_000);

test("on a phone the reply rises in the sheet; its button is in reach at half height and leads to the thread", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = trackPageErrors(page);
  try {
    await openAgent(page);
    await page.locator('[data-slot="notice-name"]').nth(2).tap();
    const sheet = page.locator('[data-slot="thread-reply"]');
    await sheet.waitFor();
    await sheet.locator('[data-slot="thread-reply-body"]').waitFor();
    await page.waitForFunction(() => {
      const top = document.querySelector('[data-slot="thread-reply"]')!.getBoundingClientRect().top;
      const last = (window as unknown as { __sheetTop?: number }).__sheetTop;
      (window as unknown as { __sheetTop?: number }).__sheetTop = top;
      return last === top && top < innerHeight - 100;
    }, undefined, { polling: 100 });
    const at = await layout(page, 2);
    // Half height: the lower half of the screen, the reply cut by its edge.
    expect(at.box.top).toBeGreaterThan(at.window.height * 0.4);
    expect(at.box.top).toBeLessThan(at.window.height * 0.6);
    expect(at.go.top).toBeGreaterThan(at.box.top);
    expect(at.go.bottom).toBeLessThan(at.window.height);
    expect(at.box.left).toBe(0);
    expect(at.box.right).toBe(at.window.width);
    await sheet.locator('[data-slot="thread-reply-go"]').tap();
    await page.waitForURL(new RegExp(`/threads/${threadIds[2]}$`));
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
