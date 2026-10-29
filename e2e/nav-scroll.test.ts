import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Locator, Page, ViewportSize } from "playwright";
import { startServer, type RunningServer } from "./helpers/server.js";
import { browserForFile } from "./helpers/browser.js";
import { trackPageErrors } from "./helpers/page-diagnostics.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";

/** The desktop sidebar and the phone navigation drawer with more threads than
 *  fit. The menu and the threads scroll as one, wherever a person wheels,
 *  and Settings stays pinned at the bottom. Earlier the menu stayed put and
 *  only the threads scrolled, in a box a short window squeezed; before
 *  that, a long list pushed Settings below the fold. Layout, so only a real browser can say what is in view. */

const THREAD_COUNT = 24;
const browser = browserForFile();
let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        for (let i = 1; i <= THREAD_COUNT; i += 1) agents.createManagerThread(`Thread ${String(i).padStart(2, "0")}`);
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => {
  server?.cleanup();
});

/** Whether a person sees the element: its centre is on screen and the topmost
 *  thing there is the element. A bounding box alone passes a row the drawer's
 *  scroller clips, or one under the pinned footer. With `waitMs`, waits up to
 *  that long for it to come into view (a scroll still settling). */
function shown(locator: Locator, waitMs = 0): Promise<boolean> {
  return locator.evaluate((el, waitMs) => new Promise<boolean>((resolve) => {
    const deadline = performance.now() + waitMs;
    const check = () => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const onScreen = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
      const hit = onScreen ? document.elementFromPoint(x, y) : null;
      const visible = hit !== null && el.contains(hit);
      if (visible || performance.now() >= deadline) resolve(visible);
      else requestAnimationFrame(check);
    };
    check();
  }), waitMs);
}

/** What the tests look at inside `root`, the desktop sidebar or the open
 *  drawer. */
function parts(root: Locator) {
  // Seeded in one millisecond, so their order is arbitrary: rows are picked by
  // position, never by title.
  const rows = root.locator('[role="group"][aria-label="Threads"] [data-thread-title]');
  // Through the landmark: Settings stays one of the navigation links.
  const nav = root.getByRole("navigation");
  const settings = nav.getByRole("link", { name: "Settings" });
  // The menu's first and last rows: the global agent's pinned row leads it.
  const menu = [root.locator('[data-slot="global-agent"]'), nav.getByRole("link", { name: "Memory" })] as const;
  return { rows, settings, menu };
}

/** Opens the drawer on a phone of this size and waits for it to finish sliding
 *  in, so positions are where they come to rest. */
async function openDrawer(viewport: ViewportSize) {
  const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
  const page: Page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  await page.goto(`${server.baseUrl}/home`);
  await page.getByRole("button", { name: "Open navigation" }).tap();
  const drawer = page.getByRole("dialog");
  const { rows, settings, menu } = parts(drawer);
  await rows.first().waitFor();
  await drawer.evaluate((el) => Promise.all(
    el.getAnimations({ subtree: true })
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished)
  ));
  return { context, page, rows, menu, settings, errors };
}

const allShown = async (locators: Locator[]) => (await Promise.all(locators.map((l) => shown(l)))).every(Boolean);

/** Wheels as a person does, over the part of `target` they can see, waiting
 *  up to 3s for some of it to come into view (a scroll still settling). A
 *  programmatic scrollIntoView would also move a box with overflow hidden, so
 *  it cannot say the list scrolls. */
async function wheelOver(page: Page, target: Locator) {
  const point = await target.evaluate((el) => new Promise<{ x: number; y: number } | null>((resolve) => {
    const deadline = performance.now() + 3000;
    const check = () => {
      const r = el.getBoundingClientRect();
      let [top, bottom, left, right] = [Math.max(r.top, 0), Math.min(r.bottom, window.innerHeight), Math.max(r.left, 0), Math.min(r.right, window.innerWidth)];
      for (let a = el.parentElement; a !== null; a = a.parentElement) {
        if (getComputedStyle(a).overflowY === "visible") continue;
        const b = a.getBoundingClientRect();
        [top, bottom, left, right] = [Math.max(top, b.top), Math.min(bottom, b.bottom), Math.max(left, b.left), Math.min(right, b.right)];
      }
      if (bottom - top >= 4 && right > left) resolve({ x: (left + right) / 2, y: (top + bottom) / 2 });
      else if (performance.now() >= deadline) resolve(null);
      else requestAnimationFrame(check);
    };
    check();
  }));
  if (point === null) throw new Error("expected part of the target in view to wheel over");
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, 5000);
}

test("on the desktop, wheeling over the menu scrolls it away with the threads, and Settings stays in view", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 700 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${server.baseUrl}/home`);
    const sidebar = page.locator("aside").filter({ has: page.locator('[data-slot="sidebar-header"]') });
    const { rows, menu, settings } = parts(sidebar);
    await rows.first().waitFor();
    expect(await rows.count()).toBe(THREAD_COUNT);
    // The list runs past the window, or nothing below says anything.
    expect(await shown(rows.last())).toBe(false);
    expect(await allShown([...menu, settings])).toBe(true);
    await wheelOver(page, menu[1]);
    expect(await shown(rows.last(), 3000)).toBe(true);
    expect(await shown(menu[0])).toBe(false);
    expect(await shown(settings)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 20_000);

test("in the phone drawer, wheeling over the menu scrolls it away with the threads, and Settings stays in view", async () => {
  const { context, page, rows, menu, settings, errors } = await openDrawer({ width: 390, height: 844 });
  try {
    expect(await rows.count()).toBe(THREAD_COUNT);
    expect(await shown(rows.first())).toBe(true);
    expect(await shown(rows.last())).toBe(false);
    expect(await allShown([...menu, settings])).toBe(true);
    // On a touch phone the drawer's rows are compact: 36px, not the 44px touch
    // rows elsewhere, so more of the list fits (space is precious there). They
    // sit 2px apart, so no two touch areas overlap.
    const newThread = page.getByRole("dialog").locator('[data-slot="new-thread"]');
    const heights = await Promise.all([...menu, newThread, rows.first(), settings].map(async (l) => (await l.boundingBox())!.height));
    expect(heights).toEqual([36, 36, 36, 36, 36]);
    await wheelOver(page, menu[1]);
    expect(await shown(rows.last(), 3000)).toBe(true);
    expect(await shown(menu[0])).toBe(false);
    expect(await shown(settings)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 20_000);

// The floor: a phone held sideways in a short window. The menu's first row and
// Settings show at rest. (Android windows go down to 220dp less the browser's
// toolbar, about 164px: there the first row shows in part, and the list still
// scrolls.)
test("on a short phone screen (640x190), Settings shows and every thread is a wheel away", async () => {
  const { context, page, rows, menu, settings, errors } = await openDrawer({ width: 640, height: 190 });
  try {
    expect(await shown(menu[0])).toBe(true);
    expect(await shown(settings)).toBe(true);
    await wheelOver(page, menu[0]);
    expect(await shown(rows.last(), 3000)).toBe(true);
    expect(await shown(settings)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 20_000);
