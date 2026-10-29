import { expect, test } from "bun:test";
import type { BrowserContextOptions } from "playwright";
import { startWorkspaceFixture, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// The terminal's key bar (Esc, Tab, Ctrl, arrows) sits above the phone's
// keyboard however the keyboard resizes the page. When it shrinks only the
// visible area — an iPhone always — the page keeps its height, and a bar at
// the page's bottom was behind the keyboard.
const browser = browserForFile();

const PHONE: BrowserContextOptions = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const KEYBOARD = 320;

test("with a keyboard that shrinks only the visible area, the terminal's keys sit just above it", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true);
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    // A visual viewport the test moves: a headless browser opens no keyboard.
    await page.addInitScript(() => {
      const viewport = new EventTarget() as EventTarget & Record<string, number>;
      Object.assign(viewport, { width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", { configurable: true, get: () => viewport });
      (window as unknown as { __keyboard: (height: number) => void }).__keyboard = (height) => {
        viewport.height = innerHeight - height;
        viewport.dispatchEvent(new Event("resize"));
      };
    });
    await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send("user@mac zoom % "); });
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}/pane/%250`);
    await page.getByRole("button", { name: "Terminal actions" }).tap();
    await page.getByRole("menuitem", { name: "Show keys" }).tap();
    const escape = page.getByRole("button", { name: "Escape" });
    await escape.waitFor();
    // Positive control: no keyboard, the keys at the bottom of the screen.
    const before = (await escape.boundingBox())!;
    expect(before.y + before.height).toBeGreaterThan(915 - 80);

    await page.evaluate((height) => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(height), KEYBOARD);
    await page.waitForFunction((top) => {
      const key = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Escape");
      return key ? key.getBoundingClientRect().bottom <= top : false;
    }, 915 - KEYBOARD);
    const after = (await escape.boundingBox())!;
    expect(after.y + after.height).toBeLessThanOrEqual(915 - KEYBOARD);
    expect(after.y + after.height).toBeGreaterThan(915 - KEYBOARD - 80);

    // The keyboard goes: the keys go back down.
    await page.evaluate(() => (window as unknown as { __keyboard: (h: number) => void }).__keyboard(0));
    await page.waitForFunction(() => {
      const key = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Escape");
      return key ? key.getBoundingClientRect().bottom > 915 - 80 : false;
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);
