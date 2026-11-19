import { expect, test } from "bun:test";
import type { Page } from "playwright";
import type { WorkerChangedFileDto, WorkerChangesResponse } from "../src/shared/api-contracts";
import { startWorkspaceFixture, workerPath } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { settle } from "./helpers/settle";

/**
 * A file opened in the drill-in Changes view starts at the top of its
 * scroller: its pinned bar right under the worker's pinned tabs,
 * the diff after it. On a phone the diff used to begin 44% down the screen
 * (y=369 of 844, 23 lines), below the worker's header and the list's
 * toolbar, which stay a scroll up away. Prev/next open each file at its top
 * too.
 */

const browser = browserForFile();
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
/** A phone shows the worker in its thread's sheet; a desktop in its panel. */
const SHEET = '[data-slot="worker-sheet"]';
const PANEL = '[data-slot="worker-panel"]';
const STREAM = "pkg/rendering/pagecaching/cache/expiry.go";
const CONTROL = "engine/planner.go";
const files: WorkerChangedFileDto[] = [STREAM, CONTROL, "README.md"].map((file) => ({
  path: file, oldPath: null, status: "M", additions: 27, deletions: 0, binary: false, uncommitted: true, untracked: false
}));
const list: WorkerChangesResponse = { compare: "head", baseRef: "HEAD", mergeBase: "x", head: "x", files, totalAdditions: 81, totalDeletions: 0 };
const patchFor = (file: string) => ({
  path: file, truncated: false, binary: false,
  patch: ["@@ -100,40 +100,80 @@", ...Array.from({ length: 80 }, (_, i) => (i % 3 === 0 ? "+" : " ") + `\t${file.replace(/\W/g, "_")}.line${i}()`)].join("\n")
});

async function open(page: Page, url: string) {
  await page.route("**/api/workers/zoom-worker/changes**", async (route) => {
    const requested = new URL(route.request().url());
    await route.fulfill({ json: requested.pathname.endsWith("/file") ? patchFor(requested.searchParams.get("path") ?? STREAM) : list });
  });
  await page.goto(url);
}

/** How far each of the page's scrollers has moved: the document, main, and
 *  the panel's own scroller around the Changes tab. */
async function scrollTops(page: Page) {
  return page.evaluate(() => {
    let scroller = document.querySelector('[data-slot="changes-tab"]')!.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    return [document.scrollingElement!.scrollTop, document.querySelector("main")!.scrollTop, scroller?.scrollTop ?? null];
  });
}

/** The panel given the whole row (its maximize): the list beside the diff. */
async function panelWhole(page: Page) {
  await page.locator(PANEL).getByRole("button", { name: "Maximize panel" }).click();
  await page.locator('aside[aria-label="Changed files"]').waitFor();
}

/** Where the file view's parts sit, and how far its scroller has moved. */
async function fileView(page: Page, scope: string) {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope)!;
    const top = (el: Element | null) => el ? Math.round(el.getBoundingClientRect().top) : null;
    const bottom = (el: Element | null) => el ? Math.round(el.getBoundingClientRect().bottom) : null;
    const bar = root.querySelector('[aria-label="Back to changed files"]')!.parentElement!;
    return {
      tabsBottom: bottom(root.querySelector('[data-slot="worker-tabs"]')),
      barTop: top(bar),
      barBottom: bottom(bar),
      cardTop: top(root.querySelector('[aria-label="File diff"]')),
      firstLine: top(root.querySelector('[data-slot="diff-line"]')),
      header: root.querySelector('[aria-label="File diff"] header')?.textContent ?? ""
    };
  }, scope);
}

test("on a phone an opened file starts at the top, its bar pinned and the diff after it (worker sheet)", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await open(page, `${fixture.baseUrl}${workerPath()}`);
    await page.locator(SHEET).getByRole("tab", { name: "Changes", exact: true }).click();
    await page.locator(`[id="change-${STREAM}"]`).click();
    await page.locator(SHEET).locator('[data-slot="diff-line"]').first().waitFor();
    await settle(page);
    const seen = await fileView(page, SHEET);
    await look(page, "sheet");
    // The bar pinned right under the worker's tabs and the file's card
    // right under the bar: the view scrolled to its top. The pinned tabs
    // (and a sheet's header) push the diff's first line to 27-30% of the
    // screen; it began at 44% when the view did not scroll.
    expect(seen.barTop!).toBe(seen.tabsBottom!);
    expect(seen.cardTop! - seen.barBottom!).toBeGreaterThanOrEqual(0);
    expect(seen.cardTop! - seen.barBottom!).toBeLessThanOrEqual(20);
    expect(seen.firstLine!).toBeLessThan(844 / 3);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

test("on a phone the next file opens at its top, not where the last one was scrolled to (both already loaded)", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    await open(page, `${fixture.baseUrl}${workerPath("changes")}`);
    const sheet = page.locator(SHEET);
    await page.locator(`[id="change-${STREAM}"]`).click();
    await sheet.locator('[data-slot="diff-line"]').first().waitFor();
    // Both patches loaded, so the next file draws at full height at once
    // (one still loading is short for a moment, and the page's own clamp
    // happened to bring it up).
    await sheet.getByRole("button", { name: "Next file" }).click();
    await sheet.locator('[aria-label="File diff"] header').getByText(CONTROL).waitFor();
    await sheet.locator('[data-slot="diff-line"]').first().waitFor();
    await sheet.getByRole("button", { name: "Previous file" }).click();
    await sheet.locator('[aria-label="File diff"] header').getByText(STREAM).waitFor();
    // Far down the first file's diff.
    await sheet.locator('[data-slot="diff-line"]').nth(60).scrollIntoViewIfNeeded();
    await settle(page);
    const scrolled = await fileView(page, SHEET);
    expect(scrolled.cardTop!).toBeLessThan(0);
    await sheet.getByRole("button", { name: "Next file" }).click();
    await sheet.locator('[aria-label="File diff"] header').getByText(CONTROL).waitFor();
    await sheet.locator('[data-slot="diff-line"]').first().waitFor();
    await settle(page);
    const next = await fileView(page, SHEET);
    // The new file's card sits right under the pinned bar.
    expect(next.cardTop! - next.barBottom!).toBeGreaterThanOrEqual(0);
    expect(next.cardTop! - next.barBottom!).toBeLessThanOrEqual(20);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

test("with the list beside the diff, choosing a file scrolls neither the page nor the panel", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    await open(page, `${fixture.baseUrl}${workerPath("changes")}`);
    await panelWhole(page);
    await page.locator(`[id="change-${CONTROL}"]`).click();
    await page.locator('[aria-label="File diff"] header').getByText(CONTROL).waitFor();
    // Its patch drawn too: a scroll could come with it.
    await page.locator('[data-slot="diff-line"]', { hasText: "engine_planner_go.line" }).first().waitFor();
    await settle(page);
    expect(await scrollTops(page)).toEqual([0, 0, 0]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("narrowing into drill-in while reading a file keeps the reader where they were", async () => {
  // The file was already open beside the list: nothing was opened, so
  // nothing scrolls back to its start.
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    await open(page, `${fixture.baseUrl}${workerPath("changes")}`);
    await panelWhole(page);
    // Chosen, not the first file shown by default: drill-in keeps a choice.
    await page.locator(`[id="change-${CONTROL}"]`).click();
    await page.locator('[aria-label="File diff"] header').getByText(CONTROL).waitFor();
    await page.locator('[data-slot="diff-line"]').first().waitFor();
    await page.locator('[data-slot="diff-line"]').nth(60).scrollIntoViewIfNeeded();
    await settle(page);
    // Restored: the panel back to its share of the row, too narrow for both.
    await page.locator(PANEL).getByRole("button", { name: "Restore panel" }).click();
    await page.locator('[aria-label="Back to changed files"]').waitFor();
    await settle(page);
    const seen = await fileView(page, PANEL);
    expect(await page.locator('[data-slot="changes-tab"]').getAttribute("data-layout")).toBe("drill-in");
    // Still deep in the diff: its card's top is far above the pinned bar.
    expect(seen.cardTop!).toBeLessThan(seen.barTop! - 300);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);
