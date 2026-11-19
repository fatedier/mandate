import { expect, test } from "bun:test";
import type { BrowserContextOptions, Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { settle } from "./helpers/settle";

// A thread's right panel, its tabs dragged into an order of the person's
// choosing, or moved a place at a time from a right-click: every tab after
// Workers moves among all the others, and the order is kept in this browser.
// On a phone a hold then a drag moves one in the sheet, whose row hides the
// canvas tabs; those keep their places.

const browser = browserForFile();
const THREAD = `/threads/${THREAD_ID}`;
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const CANVAS = "canvas:cnv_RelNotes001";

/** The thread panel saved with these tabs, once: a reload keeps what the page wrote since. */
const seed = ({ threadId, tabs }: { threadId: string; tabs: string[] }) => {
  if (window.top !== window) return;
  if (localStorage.getItem("mandate.worker-panel.v3")) return;
  localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({ state: { byThread: { [threadId]: { open: true, tabs, active: tabs[0], workerTab: {} } } }, version: 0 }));
};
const savedOrder = (page: Page) => page.evaluate((threadId) => {
  const saved = JSON.parse(localStorage.getItem("mandate.worker-panel.v3") ?? "{}") as { state?: { byThread?: Record<string, { order?: string[] }> } };
  return saved.state?.byThread?.[threadId]?.order ?? null;
}, THREAD_ID);

function fixture() {
  const f = startWorkspaceFixture();
  f.setWorker("other-worker", { ownerThreadId: THREAD_ID });
  f.addCanvas("cnv_RelNotes001", "Release notes");
  return f;
}

async function openThread(baseUrl: string, device: BrowserContextOptions, tabs: string[]) {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  await page.addInitScript(seed, { threadId: THREAD_ID, tabs });
  await page.goto(`${baseUrl}${THREAD}`);
  return { page, errors, close: () => context.close() };
}
const panelOf = (page: Page, phone = false) => page.locator(phone ? '[data-slot="worker-panel-sheet"]' : '[data-slot="worker-panel-side"]');
const tabIds = (page: Page, phone = false) => panelOf(page, phone).locator('[role="tablist"][aria-label="Worker tabs"] > [role="tab"]').evaluateAll((tabs) =>
  tabs.map((tab) => tab.getAttribute("data-worker-tab") ?? tab.getAttribute("data-canvas-tab") ?? "first"));
const tabOf = (page: Page, id: string, phone = false) => panelOf(page, phone).locator(id.startsWith("canvas:") ? `[data-canvas-tab="${id.slice(7)}"]` : `[data-worker-tab="${id}"]`).first();

test("at 1440 a worker tab dragged onto the canvas tab after it takes its place, and a reload keeps the order", async () => {
  const f = fixture();
  const { page, errors, close } = await openThread(f.baseUrl, DESKTOP, ["zoom-worker", "other-worker", CANVAS]);
  try {
    await tabOf(page, CANVAS).waitFor();
    expect(await tabIds(page)).toEqual(["first", "zoom-worker", "other-worker", "cnv_RelNotes001"]);
    const from = (await tabOf(page, "other-worker").boundingBox())!;
    const to = (await tabOf(page, CANVAS).boundingBox())!;
    const y = from.y + from.height / 2;
    await page.mouse.move(from.x + from.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, y, { steps: 3 });
    await page.mouse.move(to.x + to.width * 0.8, y, { steps: 12 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("[data-carried]") === null);
    expect(await tabIds(page)).toEqual(["first", "zoom-worker", "cnv_RelNotes001", "other-worker"]);
    expect(await savedOrder(page)).toEqual(["zoom-worker", CANVAS, "other-worker"]);
    // The drag opened nothing: the tab shown before stays shown.
    expect(await tabOf(page, "zoom-worker").getAttribute("aria-selected")).toBe("true");
    await page.reload();
    await tabOf(page, CANVAS).waitFor();
    expect(await tabIds(page)).toEqual(["first", "zoom-worker", "cnv_RelNotes001", "other-worker"]);
    expect(errors).toEqual([]);
  } finally {
    await close();
    f.stop();
  }
}, 60_000);

test("right-click Move left and Move right move a tab one place; at the row's ends they are disabled; light and dark", async () => {
  const f = fixture();
  for (const colorScheme of ["light", "dark"] as const) {
    const { page, errors, close } = await openThread(f.baseUrl, { ...DESKTOP, colorScheme }, ["zoom-worker", "other-worker", CANVAS]);
    try {
      await tabOf(page, CANVAS).waitFor();
      const menu = page.locator('[role="menu"][data-state="open"]');
      const item = (name: string) => menu.getByRole("menuitem", { name, exact: true });
      // The first after Workers cannot go left.
      await tabOf(page, "zoom-worker").click({ button: "right" });
      await menu.waitFor();
      expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Move left", "Move right"]);
      expect([await item("Move left").getAttribute("data-disabled"), await item("Move right").getAttribute("data-disabled")]).toEqual(["", null]);
      await look(page, `panel-tab-move-menu-${colorScheme}`, { animations: "disabled" });
      await item("Move right").click();
      await menu.waitFor({ state: "detached" });
      // Radix gives the focus back to the tab a moment after the menu goes;
      // a menu opened before then would lose it and close.
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "tab");
      expect(await tabIds(page)).toEqual(["first", "other-worker", "zoom-worker", "cnv_RelNotes001"]);
      // The last cannot go right; Move left takes it a place back.
      await tabOf(page, CANVAS).click({ button: "right" });
      await menu.waitFor();
      expect([await item("Move left").getAttribute("data-disabled"), await item("Move right").getAttribute("data-disabled")]).toEqual([null, ""]);
      await item("Move left").click();
      await menu.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "tab");
      expect(await tabIds(page)).toEqual(["first", "other-worker", "cnv_RelNotes001", "zoom-worker"]);
      // Workers has no menu: it does not move.
      await panelOf(page).locator('[role="tablist"][aria-label="Worker tabs"] > [role="tab"]').first().click({ button: "right" });
      await page.waitForTimeout(300);
      expect(await menu.count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }
  f.stop();
}, 60_000);

test("on a phone a hold then a drag moves a tab in the sheet; the canvas tab it hides keeps its place", async () => {
  const f = fixture();
  const { page, errors, close } = await openThread(f.baseUrl, PHONE, ["zoom-worker", CANVAS, "other-worker"]);
  try {
    await page.getByRole("button", { name: "Workers", exact: true }).tap();
    await page.locator('[data-slot="worker-sheet"]').waitFor();
    await tabOf(page, "other-worker", true).waitFor();
    // The sheet rises: its tabs are measured where it comes to rest.
    await settle(page);
    expect(await tabIds(page, true)).toEqual(["first", "zoom-worker", "other-worker"]);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    // At this width the second tab runs on under the row's All tabs and the
    // sheet's Close: the first is carried onto what shows of it.
    const from = (await tabOf(page, "zoom-worker", true).boundingBox())!;
    const over = (await tabOf(page, "other-worker", true).boundingBox())!;
    const row = (await panelOf(page, true).locator('[role="tablist"][aria-label="Worker tabs"]').boundingBox())!;
    const y = from.y + from.height / 2;
    const start = from.x + from.width / 2;
    const end = Math.min(over.x + over.width * 0.7, row.x + row.width - 8);
    await touch("touchStart", start, y);
    await page.waitForTimeout(450);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", start + (end - start) * i / 10, y); await page.waitForTimeout(25); }
    await page.waitForTimeout(300);
    await touch("touchEnd");
    await page.waitForFunction(() => document.querySelector("[data-carried]") === null);
    expect(await tabIds(page, true)).toEqual(["first", "other-worker", "zoom-worker"]);
    // The canvas, which the sheet hides, keeps its place before the tab it stood before.
    expect(await savedOrder(page)).toEqual([CANVAS, "other-worker", "zoom-worker"]);
    // No menu on a touch screen: the hold was the drag.
    expect(await page.locator('[role="menu"]').count()).toBe(0);
    expect(await page.evaluate(() => String(getSelection()))).toBe("");
    expect(errors).toEqual([]);
  } finally {
    await close();
    f.stop();
  }
}, 60_000);
