import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import type { RunningServer } from "./helpers/server.js";
import { startTouchHarness, stopTouchHarness } from "./helpers/touch-targets";
import { cssAnimations, recordCssAnimations } from "./helpers/animations";

// Dialogs and menus fade in and out (their components always asked for it;
// the animation library was never there, so they appeared and vanished in one
// frame). Asked for less motion, they still open and close, at once.
let server: RunningServer;
let browser: Browser;
let threadId = "";
beforeAll(async () => {
  const harness = await startTouchHarness({ server: true });
  server = harness.server!;
  browser = harness.browser;
  threadId = harness.threadId;
}, 60_000);
afterAll(stopTouchHarness);

async function open(path: string, reduced = false): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await recordCssAnimations(page);
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${server.baseUrl}${path}`);
  return { page, close: () => context.close() };
}

test("a dialog fades in and out, its backdrop too", async () => {
  const { page, close } = await open("/settings?tab=providers");
  try {
    await page.getByRole("button", { name: "Add provider" }).first().click();
    const dialog = page.locator('[data-slot="dialog-content"]');
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-slot="dialog-content"]')?.getAnimations().length === 0);
    expect(await cssAnimations(page, "dialog-content")).toEqual(["enter"]);
    expect(await cssAnimations(page, "dialog-overlay")).toEqual(["enter"]);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    expect(await cssAnimations(page, "dialog-content")).toEqual(["enter", "exit"]);
  } finally {
    await close();
  }
}, 30_000);

test("a menu fades in and out", async () => {
  const { page, close } = await open(`/threads/${threadId}`);
  try {
    await page.getByRole("button", { name: "Thread actions", exact: true }).click();
    const menu = page.locator('[data-slot="dropdown-menu-content"]');
    await menu.waitFor();
    // Placed first, then it moves in: let it open before closing it.
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-slot="dropdown-menu-content"]');
      return el !== null && el.getAnimations().length === 0;
    });
    expect(await cssAnimations(page, "dropdown-menu-content")).toEqual(["enter"]);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    expect(await cssAnimations(page, "dropdown-menu-content")).toEqual(["enter", "exit"]);
  } finally {
    await close();
  }
}, 30_000);

test("asked for less motion, a dialog and a menu open and close at once", async () => {
  const { page, close } = await open("/settings?tab=providers", true);
  try {
    await page.getByRole("button", { name: "Add provider" }).first().click();
    await page.locator('[data-slot="dialog-content"]').waitFor();
    await page.keyboard.press("Escape");
    await page.locator('[data-slot="dialog-content"]').waitFor({ state: "detached" });
    await page.goto(`${server.baseUrl}/threads/${threadId}`);
    await page.getByRole("button", { name: "Thread actions", exact: true }).click();
    await page.locator('[data-slot="dropdown-menu-content"]').waitFor();
    await page.keyboard.press("Escape");
    await page.locator('[data-slot="dropdown-menu-content"]').waitFor({ state: "detached" });
    expect(await page.evaluate(() => (window as unknown as { __cssAnimations: unknown[] }).__cssAnimations)).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);
