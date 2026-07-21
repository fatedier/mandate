import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { seedProject, startServer, type RunningServer } from "./helpers/server.js";

/**
 * The client tier renders into happy-dom, which parses and never lays out:
 * every box is zero by zero, nothing overflows, nothing is covered, and a
 * stylesheet that never loaded looks the same as one that did. So the failures
 * it cannot see are exactly the ones that get noticed by looking at the
 * screen — an element pushed off-canvas, a row that wraps into a scrollbar, a
 * bundle that throws on mount.
 *
 * These run against the built client the binary serves, in a real engine.
 * Assertions stay behavioural — does it render, does it fit, does it route —
 * rather than pinning pixels, so the suite reports layout that broke instead
 * of layout that changed.
 */

let server: RunningServer;
let browser: Browser;

beforeAll(async () => {
  server = await startServer({ configured: true });
  await seedProject(server, "Alpha Project");
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.cleanup();
});

interface Opened {
  page: Page;
  errors: string[];
  close: () => Promise<void>;
}

/** Opens a page with console errors and failed requests collected, so a test
 *  can assert the app booted clean rather than merely painted something. */
async function open(pathname: string, viewport = { width: 1280, height: 900 }): Promise<Opened> {
  const page = await browser.newPage({ viewport });
  attachPageDiagnostics(page);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`uncaught: ${error.message}`));
  page.on("requestfailed", (request) => {
    // Aborts are the app's own doing — a cancelled poll on navigation.
    const failure = request.failure()?.errorText ?? "";
    if (!failure.includes("ABORTED")) errors.push(`request failed: ${request.url()} ${failure}`);
  });
  await page.goto(`${server.baseUrl}${pathname}`, { waitUntil: "networkidle" });
  return { page, errors, close: () => page.close() };
}

/**
 * Measured on `body`, and it has to be.
 *
 * The app sets overflow-x: hidden on both html and body, so
 * documentElement.scrollWidth is pinned to the viewport no matter what is
 * inside — appending a 3000px element moves it not at all. An assertion
 * written against it passes on every page forever and reads exactly like one
 * that works. body.scrollWidth still grows, which is what makes this able to
 * fail; "the overflow check can still fail" below is what keeps it that way.
 */
const horizontalOverflow = (page: Page) =>
  page.evaluate(() => ({
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.body.clientWidth
  }));

describe("the built client boots", () => {
  test("the app mounts and paints something", async () => {
    const { page, errors, close } = await open("/");
    try {
      // An empty #root is what a bundle that threw on mount leaves behind, and
      // it still returns 200 with the right title.
      const rendered = await page.locator("body").innerText();
      expect(rendered.trim().length).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    } finally { await close(); }
  });

  test("the seeded project reaches the screen", async () => {
    // Proves the whole path in one assertion: API wrote it, the client
    // fetched it over a real socket, and React put it in the document.
    const { page, close } = await open("/projects");
    try {
      // Playwright's own expect ships its retrying matchers; this suite runs on
      // bun's, so wait with the locator and assert with bun's.
      const project = page.getByText("Alpha Project").first();
      await project.waitFor({ state: "visible", timeout: 10_000 });
      expect(await project.isVisible()).toBe(true);
    } finally { await close(); }
  });

  test("routing happens in the client, not by asking the server again", async () => {
    const { page, errors, close } = await open("/");
    try {
      const before = page.url();
      await page.goto(`${server.baseUrl}/settings`, { waitUntil: "networkidle" });
      expect(page.url()).not.toBe(before);
      expect(await page.locator("body").innerText()).not.toBe("");
      expect(errors).toEqual([]);
    } finally { await close(); }
  });
});

describe("the page fits its viewport", () => {
  // Sideways scroll on the document is the one layout failure that is always
  // a bug: something is wider than the screen and the reader has to drag to
  // find it. Wide content is supposed to scroll inside its own container.
  const ROUTES = ["/", "/projects", "/memory", "/settings", "/activity"];

  // Each of these opens a page, navigates and measures — about a second when
  // the machine is quiet, and past bun's five-second default when it is not.
  // The whole group then reports as a layout regression, which is the one
  // thing it is not. Same figure the activity suite already uses.
  const TEST_TIMEOUT_MS = 20_000;

  test("the overflow check can still fail", async () => {
    // Guards the twelve assertions below against becoming decoration. Measured
    // on documentElement they all pass unconditionally, and nothing about
    // reading the suite would tell you: green is green either way. So put
    // something too wide on the page and require the measurement to notice.
    const { page, close } = await open("/", { width: 375, height: 812 });
    try {
      const clean = await horizontalOverflow(page);
      expect(clean.scrollWidth).toBeLessThanOrEqual(clean.clientWidth);

      await page.evaluate(() => {
        const wide = document.createElement("div");
        wide.style.cssText = "width:3000px;height:10px";
        document.body.appendChild(wide);
      });

      const dirty = await horizontalOverflow(page);
      expect(dirty.scrollWidth).toBeGreaterThan(dirty.clientWidth);
    } finally { await close(); }
  }, TEST_TIMEOUT_MS);

  for (const route of ROUTES) {
    test(`${route} does not scroll sideways at 1280px`, async () => {
      const { page, close } = await open(route);
      try {
        const { scrollWidth, clientWidth } = await horizontalOverflow(page);
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      } finally { await close(); }
    }, TEST_TIMEOUT_MS);
  }

  for (const route of ROUTES) {
    test(`${route} does not scroll sideways at 375px`, async () => {
      const { page, close } = await open(route, { width: 375, height: 812 });
      try {
        const { scrollWidth, clientWidth } = await horizontalOverflow(page);
        expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
      } finally { await close(); }
    }, TEST_TIMEOUT_MS);
  }
});
