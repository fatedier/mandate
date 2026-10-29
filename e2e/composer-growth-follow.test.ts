import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { seedManagerThread, startServer, type RunningServer } from "./helpers/server.js";

/**
 * A reader at the end of a long conversation stays there while the draft
 * grows, and a send takes them to the end from anywhere.
 *
 * The box fits its text by dropping to one line and measuring. That drop
 * made the transcript taller for a moment, the browser pulled its scrollTop
 * back, and the box growing again left it there: from a draft's third line
 * the transcript read the reader as having scrolled up, stopped following
 * and showed Scroll to latest; a send from there stayed put. Only a real
 * engine clamps scrollTop, so this is a browser test.
 */

let server: RunningServer;
const browser = browserForFile();
let threadId = "";

beforeAll(async () => {
  server = await startServer({ configured: true, seed(dataDir) { threadId = seedManagerThread(dataDir, 60); } });
}, 60_000);

afterAll(() => server?.cleanup());

const place = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('[data-slot="transcript-column"]')!.parentElement!;
  return { fromEnd: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), toLatest: document.querySelectorAll('[aria-label="Scroll to latest message"]').length };
});

async function openAtEnd(page: Page) {
  await page.goto(`${server.baseUrl}/threads/${threadId}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-slot="transcript-column"]')?.parentElement;
    return !!el && el.scrollHeight > el.clientHeight + 40 && el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
  });
}

for (const [name, options] of [
  ["desktop", { viewport: { width: 1280, height: 900 } }],
  ["phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]
] as const) {
  test(`${name}: a draft growing line by line keeps the reader at the end, and its send lands there`, async () => {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    attachPageDiagnostics(page);
    try {
      await openAtEnd(page);
      await page.getByPlaceholder("Message the manager…").focus();
      for (let line = 1; line <= 6; line++) {
        await page.keyboard.type(`${name} line ${line} of a longer draft`);
        await page.keyboard.press("Shift+Enter");
        // Past any frame that would still be catching up.
        await page.waitForTimeout(250);
        expect({ line, ...(await place(page)) }).toEqual({ line, fromEnd: 0, toLatest: 0 });
      }
      // Enter sends on a desktop; on a phone it is a new line, and the button sends.
      if (name === "phone") await page.getByRole("button", { name: "Send message" }).tap();
      else await page.keyboard.press("Enter");
      await page.locator('[data-slot="bubble-text"]', { hasText: `${name} line 6 of a longer draft` }).waitFor();
      await page.waitForTimeout(600);
      expect(await place(page)).toEqual({ fromEnd: 0, toLatest: 0 });
    } finally {
      await context.close();
    }
  }, 90_000);
}

test("a send after scrolling up to read takes the reader to the end", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  attachPageDiagnostics(page);
  try {
    await openAtEnd(page);
    // Up by the wheel, as a reader goes back to read.
    await page.mouse.move(640, 300);
    await page.mouse.wheel(0, -1500);
    await page.getByRole("button", { name: "Scroll to latest message" }).waitFor();
    const box = page.getByPlaceholder("Message the manager…");
    await box.fill("About what I just read");
    await box.press("Enter");
    await page.locator('[data-slot="bubble-text"]', { hasText: "About what I just read" }).waitFor();
    await page.waitForTimeout(600);
    expect(await place(page)).toEqual({ fromEnd: 0, toLatest: 0 });
  } finally {
    await page.close();
  }
}, 90_000);
