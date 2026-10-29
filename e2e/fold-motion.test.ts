import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import type { RunningServer } from "./helpers/server.js";
import { startTouchHarness, stopTouchHarness } from "./helpers/touch-targets";
import { cssAnimations, recordCssAnimations } from "./helpers/animations";

// A fold grows open and shut on its height, fading as it goes, and clips
// only while it moves (open, a focus ring at its edge shows).
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

async function open(reduced = false): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await recordCssAnimations(page);
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${server.baseUrl}/threads/${threadId}`);
  await page.locator('[data-slot="tool-run-line"]').first().waitFor();
  return { page, close: () => context.close() };
}

const fold = (page: Page) => page.locator('[data-slot="tool-run"] [data-slot="fold"]').first();
/** The first run's fold shut (Radix keeps its box, hidden and empty) or open. */
const foldIs = (page: Page, open: boolean) => page.waitForFunction((want) => {
  const el = document.querySelector<HTMLElement>('[data-slot="tool-run"] [data-slot="fold"]');
  return el !== null && (want ? !el.hidden && el.childElementCount > 0 : el.hidden && el.childElementCount === 0);
}, open);
const still = (page: Page) => page.waitForFunction(() => Array.from(document.querySelectorAll('[data-slot="fold"]')).every((el) => el.getAnimations().length === 0));

test("a tool call's details grow open and shut, clipped only while they move", async () => {
  const { page, close } = await open();
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
  const { page, close } = await open();
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
  const { page, close } = await open(true);
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
