import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import type { RunningServer } from "./helpers/server.js";
import { startTouchHarness, stopTouchHarness } from "./helpers/touch-targets";

// A dialog taller than the screen used to spill past both edges: centred with
// no height limit, over a page that cannot scroll, so its title and × sat
// above the top and its last rows below the bottom (Add provider at 375×667:
// 797px tall, × 48px above the screen). Every dialog now stops 16px short of
// each edge and scrolls inside; Add provider keeps its title and × in place
// and scrolls only its list.
let server: RunningServer;
let browser: Browser;
beforeAll(async () => {
  const harness = await startTouchHarness({ server: true });
  server = harness.server!;
  browser = harness.browser;
}, 60_000);
afterAll(stopTouchHarness);

// A locator waits up to 8s, past bun's 5s default for a test.
const TEST_MS = 30_000;
const touch = (width: number, height: number): BrowserContextOptions => ({ viewport: { width, height }, isMobile: true, hasTouch: true });

async function open(device: BrowserContextOptions, path: string, trigger: string): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(`${server.baseUrl}${path}`);
  await page.getByRole("button", { name: trigger }).first().click();
  await page.locator('[data-slot="dialog-content"]').waitFor();
  // The open animation scales from 95%: measure the settled box.
  await page.waitForFunction(() => document.querySelector('[data-slot="dialog-content"]')?.getAnimations().length === 0);
  return { page, close: () => context.close() };
}

/** Where the dialog, its title and its × are, against the screen. */
const measure = (page: Page) => page.evaluate(() => {
  const box = (el: Element | null) => {
    const r = el!.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
  };
  const dialog = document.querySelector('[data-slot="dialog-content"]')!;
  return {
    screen: innerHeight,
    dialog: box(dialog),
    title: box(dialog.querySelector('[data-slot="dialog-title"]')),
    close: box(dialog.querySelector('[data-slot="dialog-close"]'))
  };
});

for (const [name, w, h] of [["375×667", 375, 667], ["landscape 844×390", 844, 390]] as const) {
  test(`Add provider at ${name}: the dialog stays on screen, its title and × stay put, and the list scrolls to its last card`, async () => {
    const { page, close } = await open(touch(w, h), "/settings?tab=providers", "Add provider");
    try {
      const at = await measure(page);
      expect({ name, top: at.dialog.top, bottom: at.dialog.bottom }).toEqual({ name, top: 16, bottom: h - 16 });
      expect({ name, titleOnScreen: at.title.top >= at.dialog.top && at.title.bottom <= h, closeOnScreen: at.close.top >= 0 && at.close.bottom <= h })
        .toEqual({ name, titleOnScreen: true, closeOnScreen: true });
      // Scrolled to its end, the list shows its last card whole, and the
      // title and × have not moved.
      const list = page.locator('[data-slot="provider-templates"]');
      await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      const last = page.getByRole("button", { name: /OpenAI compatible/ });
      const lastBox = (await last.boundingBox())!;
      expect({ name, lastBottom: Math.round(lastBox.y + lastBox.height) <= h - 16 }).toEqual({ name, lastBottom: true });
      const after = await measure(page);
      expect({ name, title: after.title.top, close: after.close.top }).toEqual({ name, title: at.title.top, close: at.close.top });
      await last.tap();
      await page.locator('[data-slot="dialog-content"]').waitFor({ state: "detached" });
    } finally {
      await close();
    }
  }, TEST_MS);
}

for (const [name, device, height] of [
  ["390×844", touch(390, 844), 797],
  ["1440×900", { viewport: { width: 1440, height: 900 } } as BrowserContextOptions, 439]
] as const) {
  test(`Add provider at ${name}, where it fits: unchanged, nothing to scroll`, async () => {
    const { page, close } = await open(device, "/settings?tab=providers", "Add provider");
    try {
      const at = await measure(page);
      expect({ name, height: Math.abs(at.dialog.height - height) <= 2 }).toEqual({ name, height: true });
      const scrolls = await page.locator('[data-slot="provider-templates"]').evaluate((el) => el.scrollHeight > el.clientHeight + 1);
      expect({ name, scrolls }).toEqual({ name, scrolls: false });
    } finally {
      await close();
    }
  }, TEST_MS);
}

test("any dialog taller than the screen stops short of its edges and scrolls inside: New project on a landscape phone with the keyboard up (640×240)", async () => {
  // 274px tall here, it ran 17px past both edges.
  const { page, close } = await open(touch(640, 240), "/projects", "New project");
  try {
    const at = await measure(page);
    expect({ top: at.dialog.top, bottom: at.dialog.bottom }).toEqual({ top: 16, bottom: 240 - 16 });
    const dialog = page.locator('[data-slot="dialog-content"]');
    // Taller than its box: the screen is what cut it.
    expect(await dialog.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
    await dialog.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const cancel = (await page.getByRole("button", { name: "Cancel" }).boundingBox())!;
    expect(Math.round(cancel.y + cancel.height) <= 240 - 16).toBe(true);
  } finally {
    await close();
  }
}, TEST_MS);

test("Add provider at 320×700: every card holds its own text, however it wraps", async () => {
  const { page, close } = await open(touch(320, 700), "/settings?tab=providers", "Add provider");
  try {
    const spills = await page.locator('[data-slot="provider-templates"] button').evaluateAll((cards) => cards.flatMap((card) => {
      const box = card.getBoundingClientRect();
      return [...card.children].filter((child) => child.getBoundingClientRect().bottom > box.bottom + 0.5).map((child) => `${card.textContent?.slice(0, 20)}: ${child.textContent}`);
    }));
    expect(spills).toEqual([]);
  } finally {
    await close();
  }
}, TEST_MS);

/** Whether the focused element is inside the box its dialog shows. */
const focusedOnScreen = (page: Page) => page.evaluate(() => {
  const focused = document.activeElement!;
  const dialog = document.querySelector('[data-slot="dialog-content"]')!;
  let shown = dialog.getBoundingClientRect();
  for (let el = focused.parentElement; el && el !== dialog.parentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowY !== "visible") {
      const r = el.getBoundingClientRect();
      shown = new DOMRect(shown.x, Math.max(shown.top, r.top), shown.width, Math.min(shown.bottom, r.bottom) - Math.max(shown.top, r.top));
    }
  }
  const f = focused.getBoundingClientRect();
  return { name: (focused.textContent || focused.getAttribute("aria-label") || focused.tagName).slice(0, 24).trim(), onScreen: f.top >= shown.top - 0.5 && f.bottom <= shown.bottom + 0.5 };
});

test("Add provider at 844×350: Tab wrapping from × back to the first card brings that card into view", async () => {
  const { page, close } = await open(touch(844, 350), "/settings?tab=providers", "Add provider");
  try {
    await page.getByRole("button", { name: /OpenAI compatible/ }).focus();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-slot"))).toBe("dialog-close");
    await page.keyboard.press("Tab");
    expect(await focusedOnScreen(page)).toEqual({ name: "OpenAI CodexUse browser", onScreen: true });
  } finally {
    await close();
  }
}, TEST_MS);

test("any scrolling dialog: Tab onto × keeps its ring and touch area inside the dialog (New project, 375×310)", async () => {
  const { page, close } = await open(touch(375, 310), "/projects", "New project");
  try {
    const dialog = page.locator('[data-slot="dialog-content"]');
    expect(await dialog.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
    await page.getByRole("button", { name: "Cancel" }).focus();
    for (let i = 0; i < 4 && (await page.evaluate(() => document.activeElement?.getAttribute("data-slot"))) !== "dialog-close"; i++) await page.keyboard.press("Tab");
    const at = await page.evaluate(() => {
      const d = document.querySelector('[data-slot="dialog-content"]')!.getBoundingClientRect();
      const c = document.activeElement!.getBoundingClientRect();
      return { focused: document.activeElement!.getAttribute("data-slot"), reachAbove: Math.round(c.top - d.top) };
    });
    // Its touch area reaches 14px above its 16px box (44px in all).
    expect({ focused: at.focused, roomAbove: at.reachAbove >= 14 }).toEqual({ focused: "dialog-close", roomAbove: true });
  } finally {
    await close();
  }
}, TEST_MS);
