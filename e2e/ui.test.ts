import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { seedProject, startServer, type RunningServer } from "./helpers/server.js";
import { trackRequests } from "./helpers/settle.js";

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
const browser = browserForFile();

beforeAll(async () => {
  server = await startServer({ configured: true });
  await seedProject(server, "Alpha Project");
});

afterAll(async () => {
  server?.cleanup();
});

interface Opened {
  page: Page;
  errors: string[];
  /** Until the route's own page is drawn (its code can come after the load)
   *  and what it loads is in. */
  drawn: () => Promise<void>;
  close: () => Promise<void>;
}

/** What each route draws once its own page is in. */
const DRAWN: Record<string, (page: Page) => Locator> = {
  "/": (page) => page.getByText("What should we work on?", { exact: true }),
  "/projects": (page) => page.getByText("Alpha Project").first(),
  "/memory": (page) => page.getByRole("navigation", { name: "Memory views" }),
  "/settings": (page) => page.locator('[data-slot="settings-section"]').first(),
  "/activity": (page) => page.getByRole("tablist", { name: "Activity views" })
};

/** Opens a page with console errors and failed requests collected, so a test
 *  can assert the app booted clean rather than merely painted something;
 *  it returns once what the page loads is in. */
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
  const requests = await trackRequests(page);
  await page.goto(`${server.baseUrl}${pathname}`);
  await requests.idle();
  const drawn = async () => {
    await DRAWN[pathname]!(page).waitFor({ timeout: 10_000 });
    await requests.idle();
  };
  return { page, errors, drawn, close: () => page.close() };
}

/**
 * Measured on the page's scrollers and on body: see pageOverflow. body alone,
 * as this once was, grew only for something outside #root — an overflowing
 * page left it at the viewport's width. "the overflow check can still fail"
 * below keeps every kind of scroller it counts able to fail it.
 */

describe("the built client boots", () => {
  test("the app mounts and paints something, and routes in the client, not by asking the server again", async () => {
    const { page, errors, close } = await open("/");
    try {
      // An empty #root is what a bundle that threw on mount leaves behind, and
      // it still returns 200 with the right title.
      const rendered = await page.locator("body").innerText();
      expect(rendered.trim().length).toBeGreaterThan(0);
      // The landing page is Home: its composer starts a thread.
      await page.getByText("What should we work on?", { exact: true }).waitFor({ timeout: 10_000 });
      expect(new URL(page.url()).pathname).toBe("/home");
      // At 1280px it does not scroll sideways (the page fits its viewport, below).
      expect(await pageOverflow(page)).toEqual([]);
      // A nav link changes the page without loading a document: page.goto
      // would be a full load, so follow a link the reader would click.
      const documents: string[] = [];
      page.on("request", (request) => { if (request.resourceType() === "document") documents.push(request.url()); });
      await page.getByRole("link", { name: "Settings" }).first().click();
      await page.waitForURL("**/settings**");
      await page.getByRole("navigation", { name: "Settings sections" }).waitFor();
      expect(documents).toEqual([]);
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
      // At 1280px it does not scroll sideways (the page fits its viewport, below).
      expect(await pageOverflow(page)).toEqual([]);
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
    // Guards the overflow assertions in this file against becoming decoration. Measured
    // on documentElement they all pass unconditionally, and nothing about
    // reading the suite would tell you: green is green either way. So put
    // something too wide on the page and require the measurement to notice.
    const { page, drawn, close } = await open("/", { width: 375, height: 812 });
    try {
      await drawn();
      expect(await pageOverflow(page)).toEqual([]);
      // Each probe is named, so an assertion is met by its own probe and not
      // by one an earlier step left on the page.
      const widen = (where: string, className = "") => page.evaluate(({ where, className }) => {
        const host = document.createElement("div");
        host.className = className;
        host.dataset.slot = `probe-${where}`;
        host.style.cssText = className ? "width:100%;height:20px" : "";
        const wide = document.createElement("div");
        wide.style.cssText = "width:3000px;height:10px;flex-shrink:0";
        host.appendChild(wide);
        if (where === "dialog") {
          // A sheet's content: portaled to body, fixed, outside main.
          const dialog = document.createElement("div");
          dialog.setAttribute("role", "dialog");
          dialog.style.cssText = "position:fixed;left:0;right:0;bottom:0";
          dialog.appendChild(host);
          document.body.appendChild(dialog);
          return;
        }
        (where === "body" ? document.body : document.querySelector("main")!).appendChild(className ? host : wide);
      }, { where, className });
      const flagged = async (prefix: string) => (await pageOverflow(page)).some((entry) => entry.startsWith(prefix));
      // A scroller meant to scroll sideways does not count.
      await widen("main", "overflow-x-auto");
      expect(await pageOverflow(page)).toEqual([]);
      // A vertical scroller inside the page (as Settings' pane) does, and one
      // inside a portaled sheet (as the phone worker sheet's body).
      await widen("main", "overflow-y-auto");
      expect(await flagged("div[data-slot=probe-main] ")).toBe(true);
      await widen("dialog", "overflow-y-auto");
      expect(await flagged("div[data-slot=probe-dialog] ")).toBe(true);
      // The page's scroller itself, and body outside #root.
      await widen("main");
      expect(await flagged("main ")).toBe(true);
      await widen("body");
      expect(await flagged("body ")).toBe(true);
    } finally { await close(); }
  }, TEST_TIMEOUT_MS);

  // "/" and "/projects" at 1280 are measured where they are opened above.
  for (const route of ROUTES.filter((r) => r !== "/" && r !== "/projects")) {
    test(`${route} does not scroll sideways at 1280px`, async () => {
      const { page, drawn, close } = await open(route);
      try {
        await drawn();
        expect(await pageOverflow(page)).toEqual([]);
      } finally { await close(); }
    }, TEST_TIMEOUT_MS);
  }

  // "/" at 375 is where the guard above starts, and it asserts that first.
  for (const route of ROUTES.filter((r) => r !== "/")) {
    test(`${route} does not scroll sideways at 375px`, async () => {
      const { page, drawn, close } = await open(route, { width: 375, height: 812 });
      try {
        await drawn();
        expect(await pageOverflow(page)).toEqual([]);
      } finally { await close(); }
    }, TEST_TIMEOUT_MS);
  }
});
