import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";
import { pressBack, recordCloseWatchers } from "./helpers/close-requests";
import { settle } from "./helpers/settle";

// On a phone a worker opens in a sheet over its thread, and a canvas opens
// full screen. The canvas used to be drawn in the page, under the sheet: a
// tap on a canvas changed the address and nothing on screen. It
// is the top layer now, wherever it is opened from, and closing it returns to
// the sheet as it was. Which layer is on top, and whether it takes a tap, is
// layout and hit-testing that happy-dom does not do.

const browser = browserForFile();
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

/** What is in front at the middle of the screen, and where the page is. */
const front = (page: Page) => page.evaluate(() => {
  const at = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  return {
    path: location.pathname,
    canvas: at?.closest('[role="dialog"][aria-label="Canvas"]') !== null && at !== null,
    sheet: at?.closest('[data-slot="worker-sheet"]') !== null && at !== null
  };
});

async function openWorkerCanvases(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
  await page.locator('[data-slot="worker-tabs"]').getByText("Canvases", { exact: true }).first().click();
  await page.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).waitFor();
  await settle(page);
}

test("on a phone a canvas opened from the worker's sheet is in front, and closing it returns to the sheet", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
  try {
    await openWorkerCanvases(page, fixture.baseUrl);
    expect(await front(page)).toEqual({ path: `/threads/${THREAD_ID}`, canvas: false, sheet: true });

    await page.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).tap();
    await canvas.waitFor();
    await settle(page);
    expect(await front(page)).toEqual({ path: "/canvas/zoom-canvas", canvas: true, sheet: false });
    // Its own controls take a tap: the menu opens and closes over it.
    await canvas.getByRole("button", { name: "Canvas menu", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Refresh", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    await canvas.waitFor();

    await canvas.getByRole("button", { name: "Close canvas", exact: true }).tap();
    await canvas.waitFor({ state: "detached" });
    await settle(page);
    // The sheet is as it was: still open, on Canvases, and it takes taps again.
    expect(await front(page)).toEqual({ path: `/threads/${THREAD_ID}`, canvas: false, sheet: true });
    await page.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).waitFor();
    await page.locator('[data-slot="worker-tabs"]').getByText("Plan", { exact: true }).first().tap();
    await page.locator('[data-slot="plan-card"]').first().waitFor();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);

// The phone's Back closes the top layer, as Esc does on a desktop: the
// canvas's menu, then the canvas (onto the thread), then the worker's sheet,
// and the thread stays. A real Esc in the menu is taken by the menu alone:
// were the key left uncancelled, the browser would also send the close
// request on to the canvas.
test("on a phone Back closes the top layer: the canvas's menu, the canvas, then the worker's sheet", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
  const sheet = page.locator('[data-slot="worker-sheet"]');
  const menu = page.getByRole("menu");
  const openMenu = async () => {
    await canvas.getByRole("button", { name: "Canvas menu", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Refresh", exact: true }).waitFor();
  };
  try {
    await recordCloseWatchers(page);
    await openWorkerCanvases(page, fixture.baseUrl);
    await page.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).tap();
    await canvas.waitFor();
    await settle(page);

    await openMenu();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    expect(await canvas.count()).toBe(1);
    expect(new URL(page.url()).pathname).toBe("/canvas/zoom-canvas");

    await openMenu();
    expect(await pressBack(page)).toBe(true);
    await menu.waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    expect(await canvas.count()).toBe(1);

    expect(await pressBack(page)).toBe(true);
    await canvas.waitFor({ state: "detached" });
    await settle(page);
    expect(await front(page)).toEqual({ path: `/threads/${THREAD_ID}`, canvas: false, sheet: true });

    expect(await pressBack(page)).toBe(true);
    await sheet.waitFor({ state: "detached" });
    expect(new URL(page.url()).pathname).toBe(`/threads/${THREAD_ID}`);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);

// The same layer on a desktop, where a page has no panel to open a canvas
// in (a worker's own page; a thread's opens it as a tab): what closed the
// hand-drawn modal still does.
test("on a desktop a press beside the canvas closes it, and so does Esc; focus goes back to what opened it", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
  const row = page.getByRole("button", { name: "Open report: Workspace canvas", exact: true });
  // Focus is handed back a tick after the dialog is gone.
  const rowHasFocus = () => page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Open report: Workspace canvas", undefined, { timeout: 3000 })
    .then(() => true, () => page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.getAttribute("data-slot") ?? ""}`));
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await page.locator('[data-slot="worker-tabs"]').getByText("Canvases", { exact: true }).first().click();
    await row.click();
    await canvas.waitFor();
    // Focus is on the dialog, so Esc and a screen reader are in it.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Canvas");
    // The 16px of backdrop around the dialog.
    await page.mouse.click(6, 450);
    await canvas.waitFor({ state: "detached" });
    expect(await rowHasFocus()).toBe(true);

    await row.click();
    await canvas.waitFor();
    await page.keyboard.press("Escape");
    await canvas.waitFor({ state: "detached" });
    expect(await rowHasFocus()).toBe(true);
    expect(new URL(page.url()).pathname).toBe(WORKER_PATH);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 60000);
