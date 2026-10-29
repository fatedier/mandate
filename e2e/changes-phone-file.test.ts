import { expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "../src/shared/api-contracts";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

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
const STREAM = "pkg/rendering/pagecaching/cache/expiry.go";
const CONTROL = "engine/planner.go";
const files: FeatureChangedFileDto[] = [STREAM, CONTROL, "README.md"].map((file) => ({
  path: file, oldPath: null, status: "M", additions: 27, deletions: 0, binary: false, uncommitted: true, untracked: false
}));
const list: FeatureChangesResponse = { compare: "head", baseRef: "HEAD", mergeBase: "x", head: "x", files, totalAdditions: 81, totalDeletions: 0 };
const patchFor = (file: string) => ({
  path: file, truncated: false, binary: false,
  patch: ["@@ -100,40 +100,80 @@", ...Array.from({ length: 80 }, (_, i) => (i % 3 === 0 ? "+" : " ") + `\t${file.replace(/\W/g, "_")}.line${i}()`)].join("\n")
});

async function open(page: Page, url: string) {
  await page.route("**/api/features/zoom-worker/changes**", async (route) => {
    const requested = new URL(route.request().url());
    await route.fulfill({ json: requested.pathname.endsWith("/file") ? patchFor(requested.searchParams.get("path") ?? STREAM) : list });
  });
  await page.goto(url);
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

for (const where of ["page", "sheet"] as const) {
  test(`on a phone an opened file starts at the top, its bar pinned and the diff after it (worker ${where})`, async () => {
    const fixture = startWorkspaceFixture();
    const context = await browser.newContext(PHONE);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    const scope = where === "page" ? "main" : '[data-slot="worker-sheet"]';
    try {
      await open(page, where === "page" ? `${fixture.baseUrl}${WORKER_PATH}?tab=changes` : `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
      if (where === "sheet") await page.locator(scope).getByRole("tab", { name: "Changes", exact: true }).click();
      await page.locator(`[id="change-${STREAM}"]`).click();
      await page.locator(scope).locator('[data-slot="diff-line"]').first().waitFor();
      await page.waitForTimeout(300);
      const seen = await fileView(page, scope);
      await page.screenshot({ path: path.join(artifactDir("changes-phone-file"), `${where}.png`) });
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
}

test("on a phone the next file opens at its top, not where the last one was scrolled to (both already loaded)", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  try {
    await open(page, `${fixture.baseUrl}${WORKER_PATH}?tab=changes`);
    await page.locator(`[id="change-${STREAM}"]`).click();
    await page.locator('[data-slot="diff-line"]').first().waitFor();
    // Both patches loaded, so the next file draws at full height at once
    // (one still loading is short for a moment, and the page's own clamp
    // happened to bring it up).
    await page.getByRole("button", { name: "Next file" }).click();
    await page.locator('[aria-label="File diff"] header').getByText(CONTROL).waitFor();
    await page.locator('[data-slot="diff-line"]').first().waitFor();
    await page.getByRole("button", { name: "Previous file" }).click();
    await page.locator('[aria-label="File diff"] header').getByText(STREAM).waitFor();
    // Far down the first file's diff.
    await page.locator('[data-slot="diff-line"]').nth(60).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const scrolled = await fileView(page, "main");
    expect(scrolled.cardTop!).toBeLessThan(0);
    await page.getByRole("button", { name: "Next file" }).click();
    await page.locator('[aria-label="File diff"] header').getByText(CONTROL).waitFor();
    await page.locator('[data-slot="diff-line"]').first().waitFor();
    await page.waitForTimeout(300);
    const next = await fileView(page, "main");
    // The new file's card sits right under the pinned bar.
    expect(next.cardTop! - next.barBottom!).toBeGreaterThanOrEqual(0);
    expect(next.cardTop! - next.barBottom!).toBeLessThanOrEqual(20);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

test("with the list beside the diff, choosing a file does not scroll the page", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    await open(page, `${fixture.baseUrl}${WORKER_PATH}?tab=changes`);
    await page.locator('aside[aria-label="Changed files"]').waitFor();
    await page.locator(`[id="change-${CONTROL}"]`).click();
    await page.locator('[aria-label="File diff"] header').getByText(CONTROL).waitFor();
    await page.waitForTimeout(300);
    const scrollTops = await page.evaluate(() => [document.scrollingElement!.scrollTop, document.querySelector("main")!.scrollTop]);
    expect(scrollTops).toEqual([0, 0]);
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
    await open(page, `${fixture.baseUrl}${WORKER_PATH}?tab=changes`);
    await page.locator('aside[aria-label="Changed files"]').waitFor();
    // Chosen, not the first file shown by default: drill-in keeps a choice.
    await page.locator(`[id="change-${CONTROL}"]`).click();
    await page.locator('[aria-label="File diff"] header').getByText(CONTROL).waitFor();
    await page.locator('[data-slot="diff-line"]').first().waitFor();
    await page.locator('[data-slot="diff-line"]').nth(60).scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 900, height: 900 });
    await page.locator('[aria-label="Back to changed files"]').waitFor();
    await page.waitForTimeout(400);
    const seen = await fileView(page, "main");
    expect(await page.locator('[data-slot="changes-tab"]').getAttribute("data-layout")).toBe("drill-in");
    // Still deep in the diff: its card's top is far above the pinned bar.
    expect(seen.cardTop!).toBeLessThan(seen.barTop! - 300);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);
