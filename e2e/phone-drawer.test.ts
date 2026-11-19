import { expect, test } from "bun:test";
import type { BrowserContextOptions, Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { settle } from "./helpers/settle";
import { browserForFile } from "./helpers/browser";

// The phone's drawer: how it slides out, its full-screen toggle, and where it
// and the top bar keep their controls under a camera cutout.
const browser = browserForFile();

const PHONE: BrowserContextOptions = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true };

// ── Sliding out ───────────────────────────────────────────────────────────
// A tap on a row of the phone's drawer closes it and opens a page. The slide
// out runs off the page's thread; when it ends, the drawer leaves the page
// only once the page's script hears of it, and a heavy page (a long chat)
// keeps that script busy for a while. Meanwhile the screen shows the drawer
// as it stands when its slide ends: it must stand where the slide left it,
// out of view with its shade gone, not back where it was open.

test("the phone drawer and its shade stay out of view once their slide out ends", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    await page.getByRole("button", { name: "Open navigation" }).tap();
    const drawer = page.locator('[data-slot="sheet-content"]');
    await drawer.and(page.locator('[data-state="open"]')).waitFor();
    // How each stands the moment its slide out ends, before the page's own
    // handler (the drawer's, on the element itself) runs.
    await page.evaluate(() => {
      const w = window as unknown as { ends: Array<{ slot: string | null; left: number; opacity: string }> };
      w.ends = [];
      window.addEventListener("animationend", (event) => {
        const el = event.target as HTMLElement;
        const slot = el.getAttribute("data-slot");
        if (event.animationName !== "exit" || (slot !== "sheet-content" && slot !== "sheet-overlay")) return;
        w.ends.push({ slot, left: Math.round(el.getBoundingClientRect().left), opacity: getComputedStyle(el).opacity });
      }, true);
    });
    const width = Math.round((await drawer.boundingBox())!.width);
    await drawer.locator('a[href="/activity"]').first().tap();
    await page.waitForURL(`${fixture.baseUrl}/activity`);
    await drawer.waitFor({ state: "detached" });
    const ends = await page.evaluate(() => (window as unknown as { ends: Array<{ slot: string | null; left: number; opacity: string }> }).ends);
    expect(ends.sort((a, b) => String(a.slot).localeCompare(String(b.slot)))).toEqual([
      { slot: "sheet-content", left: -width, opacity: "1" },
      { slot: "sheet-overlay", left: 0, opacity: "0" }
    ]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20000);

// ── Full screen ───────────────────────────────────────────────────────────
// The phone's drawer carries a full-screen toggle beside its close button:
// the browser's own full screen (a page may only ask for it from a tap), so
// the address bar goes without installing anything. It follows the real
// state, whichever way full screen ends (Android's back gesture, the page).

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

async function openThread(setup?: (page: Page) => Promise<void>) {
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
  const { page, close } = await openThread(recordFullscreenRequests);
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
  const { page, close } = await openThread();
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
  const { page, close } = await openThread(async (p) => {
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

// ── Under a camera cutout ─────────────────────────────────────────────────
// In full screen on a phone with a camera cutout the page reaches under it,
// and env(safe-area-inset-top) says how far. The top bar and the drawer keep
// their controls below it; with no inset (Chrome's normal mode, where the
// address bar holds the top) nothing changes.

const INSET = 40;

async function openWithInset(inset: number) {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: inset, topMax: inset } });
  await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
  await page.getByRole("button", { name: "Open navigation" }).waitFor();
  return { page, close: async () => { await context.close(); fixture.stop(); } };
}

/** The top bar's box, its controls' boxes, and where the content starts. */
const topBar = (page: Page) => page.evaluate(() => {
  const header = document.querySelector("header")!;
  const box = header.getBoundingClientRect();
  const controls = [...header.querySelectorAll("button, a[href]")]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => { const r = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") ?? el.textContent?.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
  return { top: Math.round(box.top), height: Math.round(box.height), bottom: Math.round(box.bottom), controls, main: Math.round(document.querySelector("main")!.getBoundingClientRect().top) };
});

test("without a safe area the top bar is 48px, its controls centred, as before", async () => {
  const { page, close } = await openWithInset(0);
  try {
    const bar = await topBar(page);
    expect({ top: bar.top, height: bar.height }).toEqual({ top: 0, height: 48 });
    expect(bar.controls.length).toBeGreaterThan(0);
    for (const c of bar.controls) expect({ name: c.name, centre: (c.top + c.bottom) / 2 }).toEqual({ name: c.name, centre: 24 });
    expect(bar.main).toBeGreaterThanOrEqual(bar.bottom);
  } finally {
    await close();
  }
}, 30_000);

test("under a 40px cutout the top bar grows by it and keeps its controls inside it, below the cutout", async () => {
  const { page, close } = await openWithInset(INSET);
  try {
    const bar = await topBar(page);
    expect({ top: bar.top, height: bar.height }).toEqual({ top: 0, height: 48 + INSET });
    for (const c of bar.controls) {
      expect({ name: c.name, belowCutout: c.top >= INSET, inside: c.bottom <= bar.bottom, centre: (c.top + c.bottom) / 2 })
        .toEqual({ name: c.name, belowCutout: true, inside: true, centre: INSET + 24 });
    }
    expect(bar.main).toBeGreaterThanOrEqual(bar.bottom);
  } finally {
    await close();
  }
}, 30_000);

test("under a 40px cutout the drawer's title, full-screen toggle and close sit below it", async () => {
  const { page, close } = await openWithInset(INSET);
  try {
    await page.getByRole("button", { name: "Open navigation" }).tap();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await settle(page);
    const tops = await dialog.evaluate((el) => {
      const top = (selector: string) => Math.round(el.querySelector(selector)!.getBoundingClientRect().top);
      return { title: top("h2"), toggle: top('[aria-label="Full screen"]'), close: top("button:has(> .sr-only)") };
    });
    for (const [name, y] of Object.entries(tops)) expect({ name, belowCutout: y >= INSET }).toEqual({ name, belowCutout: true });
  } finally {
    await close();
  }
}, 30_000);
