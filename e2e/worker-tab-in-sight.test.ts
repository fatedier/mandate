import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// The row of worker tabs. Each tab kept its name's full width, so beside a
// thread the row showed one worker's tab and a piece of the next, over the
// browser's own scroll bar; and a worker opened from the chat
// landed past the row's edge, its Close out of reach. Now a worker's
// tab is as wide as its name while the row has room; when it has not, the
// worker tabs share the row, a name keeping 102px; under that the row
// scrolls with no bar, fades on the side that has more, and keeps the open
// tab clear of the fade. Layout and scrolling are the browser's, so this
// runs in one.

const browser = browserForFile();
const THREAD = `/threads/${THREAD_ID}`;
const LONG = ["Fix Issue 72: the cache leaks when pages switch too quickly", "Research PR 61: clipboard paste timeouts and the retry policy"] as const;
/** The least a worker's name keeps of its tab, and the edge fade's width. */
const NAME_FLOOR = 102;
const FADE = 24;

function start(names: readonly [string, string] = LONG) {
  const fixture = startWorkspaceFixture();
  fixture.setFeature("zoom-worker", { name: names[0] });
  fixture.setFeature("other-worker", { name: names[1], ownerThreadId: THREAD_ID });
  return fixture;
}

/** The row of tabs as drawn: whether it scrolls, which side fades, and each
 *  worker's tab by id: how far inside the row's edges it and its Close sit
 *  (negative: cut off), how wide the tab, its name and its Close are, and
 *  whether the name is cut short. */
const rowOf = (page: Page) => page.evaluate(() => {
  const row = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Worker tabs"]')!;
  const r = row.getBoundingClientRect();
  const tabs: Record<string, {
    selected: boolean; left: number; right: number; closeRight: number;
    width: number; nameWidth: number; closeWidth: number; cut: boolean; title: string | null;
  }> = {};
  for (const tab of row.querySelectorAll<HTMLElement>("[data-worker-tab]")) {
    const t = tab.getBoundingClientRect();
    const name = tab.querySelector<HTMLElement>("span[title]")!;
    const close = tab.querySelector('[aria-label^="Close "]')!.getBoundingClientRect();
    tabs[tab.getAttribute("data-worker-tab")!] = {
      selected: tab.getAttribute("aria-selected") === "true",
      left: Math.round(t.left - r.left), right: Math.round(r.right - t.right), closeRight: Math.round(r.right - close.right),
      width: Math.round(t.width), nameWidth: Math.round(name.getBoundingClientRect().width), closeWidth: Math.round(close.width),
      cut: name.scrollWidth > name.clientWidth, title: name.getAttribute("title")
    };
  }
  return {
    scrolls: row.scrollWidth > row.clientWidth + 1, more: row.getAttribute("data-more"),
    bar: getComputedStyle(row).scrollbarWidth, tabs, page: [window.scrollX, window.scrollY]
  };
});

/** Opens both workers beside the thread: the first from the URL, the second
 *  from the Workers list, so its tab is the row's last and the open one. */
async function openBoth(page: Page, baseUrl: string, second: string) {
  await page.goto(`${baseUrl}${THREAD}?worker=zoom-worker`);
  const panel = page.locator('[data-slot="worker-panel"]');
  await panel.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
  await panel.getByRole("tab", { name: /^Workers/ }).click();
  await panel.locator(`[data-worker="${second}"]`).click();
  await panel.locator('[data-worker-tab="other-worker"][aria-selected="true"]').waitFor();
  await page.waitForTimeout(300);
  return panel;
}

test("beside a thread, two workers' tabs share the row: both whole, their names cut short, no bar", async () => {
  const fixture = start();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await openBoth(page, fixture.baseUrl, LONG[1]);
    const row = await rowOf(page);
    const { "zoom-worker": first, "other-worker": second } = row.tabs;
    // Nothing to scroll, nothing fading, and no bar of the browser's either way.
    expect([row.scrolls, row.more, row.bar]).toEqual([false, null, "none"]);
    for (const tab of [first!, second!]) {
      expect(tab.left).toBeGreaterThanOrEqual(0);
      expect(tab.right).toBeGreaterThanOrEqual(8);
      expect(tab.closeRight).toBeGreaterThanOrEqual(0);
      // Two names of 224px do not fit the panel: each gives way, well above the floor.
      expect(tab.cut).toBe(true);
      expect(tab.nameWidth).toBeGreaterThan(NAME_FLOOR + 20);
      expect(tab.nameWidth).toBeLessThan(224);
    }
    // Equal shares, whichever is open; and the whole name on hover.
    expect(Math.abs(first!.width - second!.width)).toBeLessThanOrEqual(1);
    expect([first!.title, second!.title]).toEqual([...LONG]);
    expect(row.page).toEqual([0, 0]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 40_000);

test("a worker with a short name keeps its own width, and the other the whole of its own", async () => {
  const fixture = start(["Release notes", "x"]);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await openBoth(page, fixture.baseUrl, "x");
    const row = await rowOf(page);
    const { "zoom-worker": first, "other-worker": second } = row.tabs;
    expect([row.scrolls, row.more]).toEqual([false, null]);
    // Neither is stretched to the floor or to a share of the row.
    expect([first!.cut, second!.cut]).toEqual([false, false]);
    expect(second!.nameWidth).toBeLessThan(20);
    expect(second!.width).toBeLessThan(70);
    expect(first!.nameWidth).toBeLessThan(NAME_FLOOR);
    expect(first!.width).toBe(first!.nameWidth + (second!.width - second!.nameWidth));
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 40_000);

test("in a panel too narrow for its tabs the names keep their floor and the row scrolls, the open tab clear of the fade, and again after a reload", async () => {
  const fixture = start();
  // The narrowest row that still shows the panel beside its thread.
  const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    const panel = await openBoth(page, fixture.baseUrl, LONG[1]);
    const opened = await rowOf(page);
    const last = opened.tabs["other-worker"]!;
    // The row is at its end: more to the left only, and no bar.
    expect([opened.scrolls, opened.more, opened.bar]).toEqual([true, "left", "none"]);
    expect(last.selected).toBe(true);
    for (const tab of Object.values(opened.tabs)) expect(Math.abs(tab.nameWidth - NAME_FLOOR)).toBeLessThanOrEqual(1);
    // The whole tab clear of the fade, the row's own 8px after it, Close inside the row.
    expect(last.left).toBeGreaterThanOrEqual(FADE);
    expect(last.right).toBeGreaterThanOrEqual(8);
    expect(last.closeRight).toBeGreaterThanOrEqual(0);
    expect(opened.page).toEqual([0, 0]);

    // Back to the first worker's tab: it comes clear of the fade on its side,
    // and only that far, so the row now has more both ways. Chosen by the
    // page's own click: the tab may lie wholly past the row's edge (a tab's
    // icon widened it), and Playwright's click would scroll it in first.
    await panel.locator('[data-worker-tab="zoom-worker"]').evaluate((el) => (el as HTMLElement).click());
    await panel.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    await page.waitForTimeout(300);
    const back = await rowOf(page);
    expect(back.tabs["zoom-worker"]!.left).toBe(FADE);
    expect(back.tabs["zoom-worker"]!.right).toBeGreaterThanOrEqual(FADE);
    expect(back.more).toBe("both");

    // A reload draws the tabs from what the browser remembered, before the
    // projects that name them; the open one is still in sight once they have.
    await panel.locator('[data-worker-tab="other-worker"]').evaluate((el) => (el as HTMLElement).click());
    await panel.locator('[data-worker-tab="other-worker"][aria-selected="true"]').waitFor();
    await page.reload();
    await panel.locator('[data-worker-tab="other-worker"][aria-selected="true"]').getByText(LONG[1]).waitFor();
    await page.waitForTimeout(300);
    const reloaded = await rowOf(page);
    expect([reloaded.scrolls, reloaded.more]).toEqual([true, "left"]);
    expect(reloaded.tabs["other-worker"]!.left).toBeGreaterThanOrEqual(FADE);
    expect(reloaded.tabs["other-worker"]!.right).toBeGreaterThanOrEqual(8);
    expect(reloaded.tabs["other-worker"]!.closeRight).toBeGreaterThanOrEqual(0);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 40_000);

test("on a phone, one worker's tab fits the sheet's row; a second makes it scroll, each Close still 44px and in reach", async () => {
  const fixture = start();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(fixture.baseUrl + THREAD);
    await page.getByPlaceholder("Message the manager…").waitFor();
    await page.getByRole("button", { name: "Workers", exact: true }).tap();
    const sheet = page.locator('[data-slot="worker-sheet"]');
    await sheet.waitFor();
    await sheet.locator(`[data-worker="${LONG[0]}"]`).tap();
    await sheet.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
    // The sheet has grown to full height and come to rest.
    await page.waitForTimeout(700);

    // One worker: its name gives way to the row, and nothing scrolls.
    const one = await rowOf(page);
    const only = one.tabs["zoom-worker"]!;
    expect([one.scrolls, one.more, one.bar]).toEqual([false, null, "none"]);
    expect(only.cut).toBe(true);
    expect(only.nameWidth).toBeGreaterThan(NAME_FLOOR);
    expect(only.left).toBeGreaterThanOrEqual(0);
    expect(only.right).toBeGreaterThanOrEqual(8);
    expect([only.closeRight >= 0, only.closeWidth]).toEqual([true, 44]);
    expect(one.page).toEqual([0, 0]);

    // A second: both names at their floor, the row scrolled to the open tab.
    await sheet.getByRole("tab", { name: /^Workers/ }).tap();
    await sheet.locator(`[data-worker="${LONG[1]}"]`).tap();
    await sheet.locator('[data-worker-tab="other-worker"][aria-selected="true"]').waitFor();
    await page.waitForTimeout(300);
    const two = await rowOf(page);
    const open = two.tabs["other-worker"]!;
    expect([two.scrolls, two.more]).toEqual([true, "left"]);
    for (const tab of Object.values(two.tabs)) {
      expect(Math.abs(tab.nameWidth - NAME_FLOOR)).toBeLessThanOrEqual(1);
      expect(tab.closeWidth).toBe(44);
    }
    expect(open.left).toBeGreaterThanOrEqual(FADE);
    expect(open.right).toBeGreaterThanOrEqual(8);
    expect(open.closeRight).toBeGreaterThanOrEqual(0);
    expect(two.page).toEqual([0, 0]);
    // Close answers a tap where it is drawn: the tab goes.
    await sheet.getByRole("button", { name: `Close ${LONG[1]}`, exact: true }).tap();
    await sheet.locator('[data-worker-tab="other-worker"]').waitFor({ state: "detached" });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);
