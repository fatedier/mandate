import { expect, test } from "bun:test";
import type { DesignBoard, DesignSnapshot } from "../src/shared/api-contracts";
import { startWorkspaceFixture } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";

const browser = browserForFile();

async function openDesign(design: DesignSnapshot, size: { width: number; height: number }, options: { colorScheme?: "light" | "dark"; hasTouch?: boolean } = {}) {
  const fixture = startWorkspaceFixture();
  fixture.setCanvasDesign(design);
  let context: import("playwright").BrowserContext | null = null;
  try {
    context = await browser.newContext({ viewport: size, colorScheme: options.colorScheme ?? "light", hasTouch: options.hasTouch ?? false });
    await context.route("https://evil.example.com/**", (route) => route.fulfill({ contentType: "text/javascript", body: 'document.getElementById("evil").textContent = "evil loaded";' }));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${fixture.baseUrl}/canvas/zoom-canvas`);
    const openContext = context;
    return {
      page,
      context: openContext,
      stage: page.locator('[data-slot="design-stage"]'),
      world: page.locator('[data-slot="design-world"]'),
      close: async () => { await openContext.close(); fixture.stop(); }
    };
  } catch (error) {
    // A failed setup must not leave the fixture server or the context behind.
    await context?.close().catch(() => {});
    fixture.stop();
    throw error;
  }
}

const board = (path: string, x: number, extra: Partial<DesignBoard> = {}): DesignBoard =>
  ({ path, x, y: 0, w: 390, h: 844, title: path.replace(".html", ""), page: "main", expand: null, interactive: false, radius: 0, ...extra });
const PAGE = (label: string, w: number, h: number, extra = "") =>
  `<style>body{margin:0;background:#f7f3ee;color:#231d18}main{width:${w}px;height:${h}px;padding:24px;box-sizing:border-box}</style><main><h1 id="h">${label}</h1>${extra}</main>`;
// Cart: a prototype link, a script the CSP must refuse, and body[data-ready]
// once it has loaded (the refused script would have run by then).
const CART_EXTRA =
  '<a id="go" href="Pay.html">Checkout</a><p id="evil">evil not loaded</p><script src="https://evil.example.com/bad.js"></script>' +
  '<script>window.addEventListener("load", () => { document.body.dataset.ready = "1"; });</script>';
const DESIGN: DesignSnapshot = {
  index: {
    title: "Checkout redesign",
    pages: [{ id: "main", name: "" }],
    boards: [board("Cart.html", 0, { interactive: true }), board("Pay.html", 470, { interactive: true, w: 1280, h: 800 })],
    notes: [],
    launch: { view: "canvas", page: "main" }
  },
  artboards: { "Cart.html": PAGE("Cart", 390, 844, CART_EXTRA), "Pay.html": PAGE("Pay", 1280, 800) }
};

const INK = "rgb(35, 29, 24)";

/** The world layer's camera, read from its transform. */
const camera = (env: { world: import("playwright").Locator }) => env.world.evaluate((el) => {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec((el as HTMLElement).style.transform)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
});
/** Fit all has been applied once the stage was measured: below 100% for this design. */
const fitted = (page: import("playwright").Page) => page.waitForFunction(() => {
  const el = document.querySelector<HTMLElement>('[data-slot="design-world"]');
  const m = el && /scale\(([\d.e-]+)\)/.exec(el.style.transform);
  return Boolean(m && Number(m[1]) < 1);
});

test("a design opens with its title, and each artboard in a frame at its own size", async () => {
  const env = await openDesign(DESIGN, { width: 1200, height: 800 });
  try {
    for (const [path, label, size] of [["Cart.html", "Cart", [390, 844]], ["Pay.html", "Pay", [1280, 800]]] as const) {
      expect(await env.page.frameLocator(`iframe[data-artboard="${path}"]`).locator("#h").textContent()).toBe(label);
      expect(await env.page.locator(`iframe[data-artboard="${path}"]`).evaluate((el) => [el.clientWidth, el.clientHeight])).toEqual([...size]);
    }
    expect(await env.page.locator('header:has(button[aria-label="Close canvas"]) h1').textContent()).toBe("Checkout redesign");
  } finally { await env.close(); }
}, 20000);

test("a drag pans by its distance; Ctrl+wheel zooms keeping the point under the pointer", async () => {
  const env = await openDesign(DESIGN, { width: 1200, height: 800 });
  try {
    await fitted(env.page);
    const box = (await env.stage.boundingBox())!;
    const start = await camera(env);
    await env.page.mouse.move(box.x + 20, box.y + 20);
    await env.page.mouse.down();
    await env.page.mouse.move(box.x + 120, box.y + 70, { steps: 5 });
    await env.page.mouse.up();
    // The first 3 px of each axis tell a drag from a tap; the rest pans. The
    // last move's pan may commit after the input is dispatched.
    await env.page.waitForFunction((from) => {
      const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(document.querySelector<HTMLElement>('[data-slot="design-world"]')!.style.transform);
      return Boolean(m && Math.abs(Number(m[1]) - from.x - 97) < 1 && Math.abs(Number(m[2]) - from.y - 47) < 1);
    }, start);
    const panned = await camera(env);
    expect(panned.z).toBe(start.z);
    expect(panned.x - start.x).toBeCloseTo(97, 0);
    expect(panned.y - start.y).toBeCloseTo(47, 0);
    // The world point under the pointer stays under it.
    const [px, py] = [600, 400];
    const wx = (px - panned.x) / panned.z;
    const wy = (py - panned.y) / panned.z;
    await env.page.mouse.move(box.x + px, box.y + py);
    await env.page.keyboard.down("Control");
    await env.page.mouse.wheel(0, -100);
    await env.page.keyboard.up("Control");
    await env.page.waitForFunction((z) => {
      const m = /scale\(([\d.e-]+)\)/.exec(document.querySelector<HTMLElement>('[data-slot="design-world"]')!.style.transform);
      return Boolean(m && Number(m[1]) > z);
    }, panned.z);
    const zoomed = await camera(env);
    expect(zoomed.x + wx * zoomed.z).toBeCloseTo(px, 0);
    expect(zoomed.y + wy * zoomed.z).toBeCloseTo(py, 0);
  } finally { await env.close(); }
}, 20000);

test("clicking an artboard focuses it, a prototype link moves the focused view, and Esc returns to the canvas", async () => {
  const env = await openDesign(DESIGN, { width: 1200, height: 800 });
  try {
    await fitted(env.page);
    await env.page.locator('[data-board="Cart.html"]').click();
    await env.page.waitForSelector('[data-slot="design-focus"] iframe[data-artboard="Cart.html"]');
    await env.page.frameLocator('[data-slot="design-focus"] iframe').locator("#go").click();
    await env.page.waitForSelector('[data-slot="design-focus"] iframe[data-artboard="Pay.html"]');
    expect(await env.page.frameLocator('[data-slot="design-focus"] iframe').locator("#h").textContent()).toBe("Pay");
    await env.page.keyboard.press("Escape");
    await env.page.locator('[data-slot="design-stage"]').waitFor();
    expect(await env.page.locator('[data-slot="design-focus"]').count()).toBe(0);
  } finally { await env.close(); }
}, 20000);

test("the report CSP holds inside an artboard, and an artboard in one look shows it under a dark OS and a dark app", async () => {
  const env = await openDesign(DESIGN, { width: 1200, height: 800 }, { colorScheme: "dark" });
  try {
    const cart = env.page.frameLocator('iframe[data-artboard="Cart.html"]');
    await cart.locator("body[data-ready]").waitFor();
    expect(await cart.locator('script[src^="https://evil.example.com"]').count()).toBe(1);
    expect(await cart.locator("#evil").textContent()).toBe("evil not loaded");
    // No theme reaches it: no stamp, and its explicit colours hold.
    expect(await cart.locator("html").getAttribute("data-theme")).toBeNull();
    expect(await cart.locator("#h").evaluate((el) => [getComputedStyle(el).color, getComputedStyle(document.body).backgroundColor]))
      .toEqual([INK, "rgb(247, 243, 238)"]);
  } finally { await env.close(); }
}, 20000);

test("at 100%, an artboard larger than the stage can be scrolled to its top-left corner", async () => {
  const env = await openDesign(DESIGN, { width: 390, height: 844 });
  try {
    await fitted(env.page);
    await env.page.locator('[data-board="Pay.html"]').click();
    await env.page.waitForSelector('[data-slot="design-focus"] iframe[data-artboard="Pay.html"]');
    await env.page.locator('button[aria-label="Zoom, Fit"]').click();
    await env.page.getByRole("menuitemradio", { name: "100%" }).click();
    await env.page.waitForSelector('button[aria-label="Zoom, 100%"]');
    const edges = await env.page.evaluate(() => {
      const focus = document.querySelector<HTMLElement>('[data-slot="design-focus"]')!;
      focus.scrollTo(0, 0);
      const box = focus.getBoundingClientRect();
      const frame = focus.querySelector("iframe")!.getBoundingClientRect();
      return { width: Math.round(frame.width), leftReachable: frame.left >= box.left - 1, topReachable: frame.top >= box.top - 1 };
    });
    expect(edges).toEqual({ width: 1280, leftReachable: true, topReachable: true });
  } finally { await env.close(); }
}, 20000);

test("the header keeps its title and Close in view on a phone and in a half-screen pane, on the canvas and in the focused view", async () => {
  const paged: DesignSnapshot = {
    ...DESIGN,
    index: {
      ...DESIGN.index,
      pages: [{ id: "flows", name: "Checkout flows" }, { id: "empty", name: "Empty states" }],
      boards: DESIGN.index.boards.map((b) => ({ ...b, page: "flows" })),
      launch: { view: "canvas", page: "flows" }
    }
  };
  for (const size of [{ width: 390, height: 844 }, { width: 600, height: 900 }]) {
    const env = await openDesign(paged, size);
    try {
      await fitted(env.page);
      const layout = (view: string) => env.page.evaluate((where) => {
        const header = document.querySelector<HTMLElement>('header:has(button[aria-label="Close canvas"])')!;
        const close = header.querySelector('button[aria-label="Close canvas"]')!.getBoundingClientRect();
        const bars = [header, document.querySelector<HTMLElement>('[data-slot="design-focus-bar"]')].filter((bar): bar is HTMLElement => bar !== null);
        return {
          where,
          closeInView: close.left >= 0 && close.right <= window.innerWidth,
          titleShown: header.querySelector("h1")!.getBoundingClientRect().width >= 48,
          fits: bars.every((bar) => bar.scrollWidth <= bar.clientWidth)
        };
      }, `${size.width}px ${view}`);
      expect(await layout("canvas")).toEqual({ where: `${size.width}px canvas`, closeInView: true, titleShown: true, fits: true });
      await env.page.locator('[data-board="Cart.html"]').click();
      await env.page.waitForSelector('[data-slot="design-focus"] iframe[data-artboard="Cart.html"]');
      expect(await layout("focused")).toEqual({ where: `${size.width}px focused`, closeInView: true, titleShown: true, fits: true });
    } finally { await env.close(); }
  }
}, 40000);

test("on a touch screen, two fingers zoom around their midpoint and carry the canvas with them", async () => {
  const env = await openDesign(DESIGN, { width: 1200, height: 800 }, { hasTouch: true });
  try {
    await fitted(env.page);
    const box = (await env.stage.boundingBox())!;
    const start = await camera(env);
    const cdp = await env.context.newCDPSession(env.page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: Array<[number, number]>) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x: box.x + x, y: box.y + y, id })) });
    // The world point under the fingers' first midpoint (600, 400).
    const wx = (600 - start.x) / start.z;
    const wy = (400 - start.y) / start.z;
    // They spread from 200 px apart to 400, and their midpoint moves to (650, 450).
    await touch("touchStart", [[500, 400], [700, 400]]);
    for (let step = 1; step <= 5; step++) {
      const t = step / 5;
      const [mx, my, half] = [600 + 50 * t, 400 + 50 * t, 100 + 100 * t];
      await touch("touchMove", [[mx - half, my], [mx + half, my]]);
    }
    await touch("touchEnd", []);
    await env.page.waitForFunction((z) => {
      const m = /scale\(([\d.e-]+)\)/.exec(document.querySelector<HTMLElement>('[data-slot="design-world"]')!.style.transform);
      return Boolean(m && Math.abs(Number(m[1]) - z * 2) < 0.01);
    }, start.z);
    const pinched = await camera(env);
    expect(pinched.z).toBeCloseTo(start.z * 2, 2);
    expect(Math.abs(pinched.x + wx * pinched.z - 650)).toBeLessThan(2);
    expect(Math.abs(pinched.y + wy * pinched.z - 450)).toBeLessThan(2);
    // A touch pinch is no tap: nothing was focused.
    expect(await env.page.locator('[data-slot="design-focus"]').count()).toBe(0);
  } finally { await env.close(); }
}, 20000);

test("a pinch whose first finger stays still does not open the board under it", async () => {
  const env = await openDesign(DESIGN, { width: 1200, height: 800 }, { hasTouch: true });
  try {
    await fitted(env.page);
    const cart = (await env.page.locator('[data-board="Cart.html"]').boundingBox())!;
    const start = await camera(env);
    const cdp = await env.context.newCDPSession(env.page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", points: Array<[number, number]>) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const [x, y] = [cart.x + cart.width / 2, cart.y + cart.height / 2];
    await touch("touchStart", [[x, y], [x + 100, y]]);
    for (let step = 1; step <= 5; step++) await touch("touchMove", [[x, y], [x + 100 + 20 * step, y]]);
    // Both fingers lift (CDP lifts touch points only all at once: a touchMove
    // that leaves one out keeps it down).
    await touch("touchEnd", []);
    await env.page.waitForFunction((z) => {
      const m = /scale\(([\d.e-]+)\)/.exec(document.querySelector<HTMLElement>('[data-slot="design-world"]')!.style.transform);
      return Boolean(m && Number(m[1]) > z * 1.5);
    }, start.z);
    await env.page.waitForTimeout(300);
    expect(await env.page.locator('[data-slot="design-focus"]').count()).toBe(0);
    // The next plain tap is a tap again: it opens the board.
    const board = (await env.page.locator('[data-board="Cart.html"]').boundingBox())!;
    await touch("touchStart", [[board.x + board.width / 2, board.y + board.height / 2]]);
    await touch("touchEnd", []);
    await env.page.waitForSelector('[data-slot="design-focus"] iframe[data-artboard="Cart.html"]');
  } finally { await env.close(); }
}, 20000);
