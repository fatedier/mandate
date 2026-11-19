import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import type { RunningServer } from "./helpers/server.js";
import { startTouchHarness, stopTouchHarness } from "./helpers/touch-targets";

// A row of tabs has one fill under the chosen tab, which slides to the tab
// chosen next; what that tab shows fades in. Asked for less motion, both are
// just there.
let server: RunningServer;
let browser: Browser;
beforeAll(async () => {
  const harness = await startTouchHarness({ server: true });
  server = harness.server!;
  browser = harness.browser;
}, 60_000);
afterAll(stopTouchHarness);

async function open(reduced = false): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    const faded: string[] = [];
    (window as unknown as { __faded: string[] }).__faded = faded;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
      if (Array.isArray(keyframes) && keyframes[0]?.opacity === 0 && keyframes.length === 2 && !("transform" in keyframes[0])) faded.push(this.getAttribute("role") ?? this.tagName.toLowerCase());
      return animate.call(this, keyframes, options);
    };
  });
  if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`${server.baseUrl}/activity`);
  await page.locator('[data-slot="tab-mark"]').waitFor({ state: "attached" });
  return { page, close: () => context.close() };
}
const markOverChosen = (page: Page) => page.evaluate(() => {
  const mark = document.querySelector<HTMLElement>('[data-slot="tab-mark"]')!.getBoundingClientRect();
  const tab = document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')!.getBoundingClientRect();
  return Math.abs(mark.left - tab.left) < 1 && Math.abs(mark.width - tab.width) < 1;
});
const moving = (page: Page) => page.evaluate(() => document.querySelector('[data-slot="tab-mark"]')!.getAnimations().map((a) => (a as CSSTransition).transitionProperty));
const settled = (page: Page) => page.waitForFunction(() => document.querySelector('[data-slot="tab-mark"]')!.getAnimations().length === 0);
const faded = (page: Page) => page.evaluate(() => (window as unknown as { __faded: string[] }).__faded.slice());

test("the chosen tab's fill slides to the next tab chosen, and what it shows fades in", async () => {
  const { page, close } = await open();
  try {
    expect(await markOverChosen(page)).toBe(true);
    expect([await moving(page), await faded(page)]).toEqual([[], []]);
    await page.getByRole("tab", { name: "Logs" }).click();
    // The tab is in the address: it is chosen a moment after the click.
    await page.locator('[role="tab"][aria-selected="true"]', { hasText: "Logs" }).waitFor();
    expect(await moving(page)).toContain("transform");
    await settled(page);
    expect(await markOverChosen(page)).toBe(true);
    expect(await faded(page)).toEqual(["tabpanel"]);
  } finally {
    await close();
  }
}, 30_000);

test("asked for less motion, the fill and what the tab shows are just there", async () => {
  const { page, close } = await open(true);
  try {
    await page.getByRole("tab", { name: "Logs" }).click();
    await page.locator('[role="tab"][aria-selected="true"]', { hasText: "Logs" }).waitFor();
    expect(await moving(page)).toEqual([]);
    expect(await markOverChosen(page)).toBe(true);
    expect(await faded(page)).toEqual([]);
  } finally {
    await close();
  }
}, 30_000);
