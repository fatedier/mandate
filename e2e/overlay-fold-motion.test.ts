import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import type { RunningServer } from "./helpers/server.js";
import { startTouchHarness, stopTouchHarness } from "./helpers/touch-targets";
import { cssAnimations, recordCssAnimations } from "./helpers/animations";

// Dialogs and menus fade in and out (their components always asked for it;
// the animation library was never there, so they appeared and vanished in one
// frame). A fold grows open and shut on its height, fading as it goes, and
// clips only while it moves (open, a focus ring at its edge shows). Asked for
// less motion, each still opens and closes, at once.
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

/** The seeded thread, its tool runs drawn. */
async function openRuns(reduced = false): Promise<{ page: Page; close: () => Promise<void> }> {
  const opened = await open(`/threads/${threadId}`, reduced);
  await opened.page.locator('[data-slot="tool-run-line"]').first().waitFor();
  return opened;
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

const fold = (page: Page) => page.locator('[data-slot="tool-run"] [data-slot="fold"]').first();
/** The first run's fold shut (Radix keeps its box, hidden and empty) or open. */
const foldIs = (page: Page, open: boolean) => page.waitForFunction((want) => {
  const el = document.querySelector<HTMLElement>('[data-slot="tool-run"] [data-slot="fold"]');
  return el !== null && (want ? !el.hidden && el.childElementCount > 0 : el.hidden && el.childElementCount === 0);
}, open);
const still = (page: Page) => page.waitForFunction(() => Array.from(document.querySelectorAll('[data-slot="fold"]')).every((el) => el.getAnimations().length === 0));

test("a tool call's details grow open and shut, clipped only while they move", async () => {
  const { page, close } = await openRuns();
  try {
    await page.locator('[data-slot="tool-run-line"]').first().click();
    // While it opens it clips; once open, it does not.
    const during = await fold(page).evaluate((el) => getComputedStyle(el).overflow);
    await still(page);
    const after = await fold(page).evaluate((el) => getComputedStyle(el).overflow);
    expect([during, after]).toEqual(["hidden", "visible"]);
    expect(await cssAnimations(page, "fold")).toEqual(["fold-open"]);
    await page.locator('[data-slot="tool-run-line"]').first().click();
    await foldIs(page, false);
    expect(await cssAnimations(page, "fold")).toEqual(["fold-open", "fold-close"]);
  } finally {
    await close();
  }
}, 30_000);

test("content that arrives while a fold opens is what it grows to, with no jump at its end", async () => {
  const { page, close } = await openRuns();
  try {
    // As its open animation starts, more arrives (as steps read on open do);
    // its height is noted each frame while it moves.
    await page.evaluate(() => {
      const seen = window as unknown as { heights?: number[] };
      document.addEventListener("animationstart", (event) => {
        const el = event.target as HTMLElement;
        if (seen.heights || event.animationName !== "fold-open" || !el.matches('[data-slot="tool-run"] [data-slot="fold"]')) return;
        const heights: number[] = [];
        seen.heights = heights;
        const more = document.createElement("div");
        more.style.height = "400px";
        el.appendChild(more);
        const sample = () => {
          if (el.getAnimations().length === 0) return;
          heights.push(el.getBoundingClientRect().height);
          requestAnimationFrame(sample);
        };
        sample();
      }, true);
    });
    await page.locator('[data-slot="tool-run-line"]').first().click();
    await page.waitForFunction(() => (window as unknown as { heights?: number[] }).heights !== undefined);
    await still(page);
    const end = await fold(page).evaluate((el) => el.getBoundingClientRect().height);
    const heights = await page.evaluate(() => (window as unknown as { heights: number[] }).heights);
    // It grew toward all of it, not to what it held as it started.
    expect(Math.max(...heights)).toBeGreaterThan(end * 0.8);
  } finally {
    await close();
  }
}, 30_000);

test("asked for less motion, a tool call's details open and shut at once", async () => {
  const { page, close } = await openRuns(true);
  try {
    await page.locator('[data-slot="tool-run-line"]').first().click();
    await foldIs(page, true);
    await page.locator('[data-slot="tool-run-line"]').first().click();
    await foldIs(page, false);
    expect(await cssAnimations(page, "fold")).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);
