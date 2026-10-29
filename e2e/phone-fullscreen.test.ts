import { expect, test } from "bun:test";
import type { BrowserContextOptions, Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";

// The phone's drawer carries a full-screen toggle beside its close button:
// the browser's own full screen (a page may only ask for it from a tap), so
// the address bar goes without installing anything. It follows the real
// state, whichever way full screen ends (Android's back gesture, the page).
const browser = browserForFile();

const PHONE: BrowserContextOptions = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };
const inFullscreen = (page: Page) => page.evaluate(() => document.fullscreenElement !== null);
const drawerOpen = (page: Page) => page.getByRole("dialog").isVisible();
/** Notes the options each full-screen request carries, then makes it. */
const recordFullscreenRequests = async (page: Page) => { await page.addInitScript(() => {
  const asked: unknown[] = [];
  (window as unknown as { __fullscreenAsked: unknown[] }).__fullscreenAsked = asked;
  const request = Element.prototype.requestFullscreen;
  Element.prototype.requestFullscreen = function (this: Element, options?: FullscreenOptions) {
    asked.push(options ?? null);
    return request.call(this, options);
  };
}); };
const fullscreenAsked = (page: Page) => page.evaluate(() => (window as unknown as { __fullscreenAsked: unknown[] }).__fullscreenAsked);

async function open(setup?: (page: Page) => Promise<void>) {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await setup?.(page);
  await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
  await page.getByRole("button", { name: "Open navigation" }).waitFor();
  return { page, close: async () => { await context.close(); fixture.stop(); } };
}

test("the drawer's toggle enters full screen, closes the drawer, and offers the way out", async () => {
  const { page, close } = await open(recordFullscreenRequests);
  try {
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.getByRole("button", { name: "Full screen", exact: true }).tap();
    await page.waitForFunction(() => document.fullscreenElement !== null);
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    expect(await drawerOpen(page)).toBe(false);
    // The navigation bar stays: Android 12+ shows it with the keyboard, and
    // its coming and going redrew Chrome's whole screen (a flash).
    expect(await fullscreenAsked(page)).toEqual([{ navigationUI: "show" }]);
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.getByRole("button", { name: "Exit full screen" }).tap();
    await page.waitForFunction(() => document.fullscreenElement === null);
    expect(await inFullscreen(page)).toBe(false);
  } finally {
    await close();
  }
}, 30_000);

test("full screen ended elsewhere (a back gesture) turns the toggle off, even with the drawer open", async () => {
  const { page, close } = await open();
  try {
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.getByRole("button", { name: "Full screen", exact: true }).tap();
    await page.waitForFunction(() => document.fullscreenElement !== null);
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.getByRole("button", { name: "Exit full screen" }).waitFor();
    // Ended outside the toggle while the drawer shows it: no re-render of
    // ours happens, so only the fullscreenchange event can update it.
    await page.evaluate(() => document.exitFullscreen());
    await page.getByRole("button", { name: "Full screen", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Exit full screen" }).count()).toBe(0);
  } finally {
    await close();
  }
}, 30_000);

test("where full screen is unavailable the toggle is not offered", async () => {
  const { page, close } = await open(async (p) => {
    await p.addInitScript(() => { Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false }); });
  });
  try {
    await page.getByRole("button", { name: "Open navigation" }).tap();
    await page.getByRole("dialog").waitFor();
    expect(await page.getByRole("button", { name: /full screen/i }).count()).toBe(0);
  } finally {
    await close();
  }
}, 30_000);
