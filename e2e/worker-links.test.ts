import { expect, test } from "bun:test";
import type { BrowserContextOptions, Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { emptyPlan } from "../src/shared/api/plans";

// A worker opens in its owner thread's panel from everywhere that links to
// it: its row on its project's page, the terminal page's way back (desktop
// title, phone breadcrumb), a canvas's Open worker. Each lands on the thread
// with the worker's tab chosen, on the page the link names.

const browser = browserForFile();
const desktop: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function open(options: BrowserContextOptions, path: string) {
  const fixture = startWorkspaceFixture();
  fixture.setTerminalPane(true, "zsh");
  const context = await browser.newContext(options);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  await page.routeWebSocket("**/api/terminal?*", (socket) => { socket.send("user@mac zoom % "); });
  await page.goto(fixture.baseUrl + path);
  const close = async () => { try { await context.close(); } finally { fixture.stop(); } };
  return { page, errors, close };
}

/** The thread page with zoom-worker's tab chosen, on `tab`. */
async function landed(page: Page, tab: string) {
  await page.waitForURL((url) => url.pathname === `/threads/${THREAD_ID}` && url.search === "");
  await page.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
  await page.locator('[data-slot="worker-tabs"] [role="tab"][aria-selected="true"]', { hasText: tab }).waitFor();
}

test("desktop: a worker's row on its project's page opens it in the thread that owns it", async () => {
  const { page, errors, close } = await open(desktop, "/projects/zoom-project");
  try {
    // The row shows its item's title (the fixture's, apart from the worker's name).
    const row = page.locator('a[data-slot="worker-row"]', { hasText: "Worker pane zoom" });
    expect(await row.getAttribute("href")).toBe(`/threads/${THREAD_ID}?worker=zoom-worker`);
    await row.click();
    await page.waitForURL((url) => url.pathname === `/threads/${THREAD_ID}`);
    await page.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 20_000);

test("desktop: the terminal page's title leads back to the worker's Terminal tab in its thread", async () => {
  const { page, errors, close } = await open(desktop, `${WORKER_PATH}/pane/%250`);
  try {
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("user@mac"));
    const back = page.locator(`[data-slot="pane-header"] h1 a[href="/threads/${THREAD_ID}?worker=zoom-worker&tab=terminal"]`);
    await back.click();
    await landed(page, "Terminal");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 20_000);

test("phone: the terminal page's breadcrumb leads back to the worker's Terminal tab in its thread's sheet", async () => {
  const { page, errors, close } = await open(phone, `${WORKER_PATH}/pane/%250`);
  try {
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("user@mac"));
    await page.locator('nav[aria-label="Breadcrumb"] a', { hasText: "zoom-worker" }).click();
    await landed(page, "Terminal");
    expect(await page.locator('[data-slot="worker-panel-sheet"] [data-worker-tab="zoom-worker"]').count()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 20_000);

test("phone: the terminal page's breadcrumb names the project and opens its page", async () => {
  const { page, errors, close } = await open(phone, `${WORKER_PATH}/pane/%250`);
  try {
    await page.waitForFunction(() => (document.querySelector(".xterm-rows")?.textContent ?? "").includes("user@mac"));
    await page.locator('nav[aria-label="Breadcrumb"] a[href="/projects/zoom-project"]', { hasText: "Zoom project" }).click();
    await page.waitForURL((url) => url.pathname === "/projects/zoom-project");
    await page.locator('[data-slot="project-header"] h1', { hasText: "Zoom project" }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 20_000);

test("desktop: a canvas's Open worker opens the worker on its canvases in its thread", async () => {
  const { page, errors, close } = await open(desktop, "/canvas/zoom-canvas");
  try {
    await page.locator('[data-slot="pane-header"] button[aria-haspopup="menu"]').last().click();
    await page.getByRole("menuitem", { name: "Open worker" }).click();
    await landed(page, "Canvases");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 20_000);

// The worker has no page of its own: an old link to one lands on Home.
test("the old address of a worker's own page lands on Home", async () => {
  const { page, errors, close } = await open(desktop, `${WORKER_PATH}?tab=chat`);
  try {
    await page.waitForURL((url) => url.pathname === "/home");
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
}, 20_000);

// A worker's question on its row sits under the row's link: a canvas link
// in it opens the canvas, and the project's page stays behind it.
test("desktop: a canvas link in a worker row's question opens the canvas over the project's page", async () => {
  const fixture = startWorkspaceFixture();
  const at = "2026-09-27T10:00:00.000Z";
  fixture.setPlan({
    ...emptyPlan("zoom-worker"),
    openQuestions: ["Follow [the release notes](/canvas/zoom-canvas) first?"],
    steps: [{ id: 1, title: "Draft the notes", status: "in_progress", note: "", createdAt: at, startedAt: at, blockedAt: null, completedAt: null, updatedAt: at }],
    updatedAt: at
  });
  const context = await browser.newContext(desktop);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}/projects/zoom-project`);
    const link = page.locator('[data-slot="worker-question"] [data-slot="question-callout"] a', { hasText: "the release notes" });
    await link.click();
    await page.getByRole("dialog", { name: "Canvas", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/canvas/zoom-canvas");
    expect(await page.locator('[data-slot="worker-row"]').count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);
