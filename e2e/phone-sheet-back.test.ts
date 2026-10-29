import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// On a phone the worker sheet is a step in the history: the
// phone's Back closes it before it leaves the thread. Before, the sheet was
// not a step: Back from it went to whatever page came before the thread.
// The browser's own history is the thing under test, so this runs in one.

const browser = browserForFile();
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const THREAD = `/threads/${THREAD_ID}`;

async function setup() {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const sheet = page.locator('[data-slot="worker-sheet"]');
  const where = () => { const u = new URL(page.url()); return u.pathname + u.search; };
  const back = async () => { await page.goBack(); await page.waitForTimeout(500); };
  /** Home first, so Back from the thread has somewhere to go. */
  const arrive = async (path: string) => {
    await page.goto(`${fixture.baseUrl}/home`);
    await page.getByPlaceholder("Start a new thread").waitFor();
    await page.goto(fixture.baseUrl + path);
    await page.getByPlaceholder("Message the manager…").waitFor();
  };
  return { fixture, context, page, errors, sheet, where, back, arrive, close: async () => { await context.close(); fixture.stop(); } };
}
const openWorkers = async (page: Page) => {
  await page.getByRole("button", { name: "Workers", exact: true }).tap();
  await page.locator('[data-slot="worker-sheet"]').waitFor();
  await page.waitForTimeout(400);
};

test("Back closes the sheet and stays on the thread; from a canvas it goes canvas, sheet, thread, Home", async () => {
  const env = await setup();
  const { page, sheet, where, back } = env;
  const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
  try {
    await env.arrive(THREAD);
    await openWorkers(page);
    await back();
    await sheet.waitFor({ state: "detached" });
    expect(where()).toBe(THREAD);
    await page.getByPlaceholder("Message the manager…").waitFor();

    // Down the whole way: the worker, its Canvases, the report.
    await openWorkers(page);
    await sheet.locator('[data-worker="zoom-worker"]').tap();
    await page.locator('[data-slot="worker-tabs"]').getByText("Canvases", { exact: true }).first().tap();
    await page.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).tap();
    await canvas.waitFor();
    expect(where()).toBe("/canvas/zoom-canvas");

    await back();
    await canvas.waitFor({ state: "detached" });
    expect(where()).toBe(THREAD);
    // The sheet is as it was, on Canvases.
    await sheet.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).waitFor();

    await back();
    await sheet.waitFor({ state: "detached" });
    expect(where()).toBe(THREAD);

    await back();
    expect(where()).toBe("/home");
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 60000);

test("a sheet closed by its Close leaves no step behind: one Back then leaves the thread", async () => {
  const env = await setup();
  const { page, sheet, where, back } = env;
  try {
    await env.arrive(THREAD);
    await openWorkers(page);
    await sheet.getByRole("button", { name: "Close", exact: true }).tap();
    await sheet.waitFor({ state: "detached" });
    await page.waitForTimeout(400);
    expect(where()).toBe(THREAD);
    await back();
    expect(where()).toBe("/home");
    // Forward comes back to the thread, with no sheet.
    await page.goForward();
    await page.getByPlaceholder("Message the manager…").waitFor();
    await page.waitForTimeout(500);
    expect(await sheet.count()).toBe(0);
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 60000);

test("a worker opened by ?worker= is a step for the address without it: Back shows the thread, not the worker again", async () => {
  const env = await setup();
  const { page, sheet, where, back } = env;
  try {
    await env.arrive(`${THREAD}?worker=zoom-worker`);
    await sheet.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    // The address lets go of ?worker=.
    await page.waitForURL((url) => url.pathname + url.search === THREAD);
    expect(where()).toBe(THREAD);
    await back();
    await sheet.waitFor({ state: "detached" });
    expect(where()).toBe(THREAD);
    await page.waitForTimeout(600);
    expect(await sheet.count()).toBe(0);
    await back();
    expect(where()).toBe("/home");
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 60000);

// Turned on its side a phone is wide enough for the desktop layout, which has
// no sheet: the sheet closes. Under an open canvas its step must wait: the
// history's top entry is the canvas's, and taking a step back there would
// close the canvas being read.
test("turning the phone while a canvas is open keeps the canvas; the sheet's step goes when the canvas does", async () => {
  const env = await setup();
  const { page, sheet, where, back } = env;
  const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
  try {
    await env.arrive(`${THREAD}?worker=zoom-worker`);
    await sheet.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    await page.locator('[data-slot="worker-tabs"]').getByText("Canvases", { exact: true }).first().tap();
    await page.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).tap();
    await canvas.waitFor();

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(800);
    await canvas.waitFor();
    expect(where()).toBe("/canvas/zoom-canvas");

    await back();
    await canvas.waitFor({ state: "detached" });
    await page.waitForTimeout(600);
    // The wide layout: no sheet, and its step is gone with it.
    expect(where()).toBe(THREAD);
    expect(await sheet.count()).toBe(0);
    await back();
    expect(where()).toBe("/home");
    expect(env.errors).toEqual([]);
  } finally {
    await env.close();
  }
}, 60000);
