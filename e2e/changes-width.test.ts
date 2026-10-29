import { expect, test } from "bun:test";
import path from "node:path";
import { chromium, type Page } from "playwright";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "../src/shared/api-contracts";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";

// The Changes tab lays out by its own width, not by "is this a phone". In the
// thread page's worker panel at a 1440 half split (603px) the desktop layout
// kept its 240px list and split the diff into two 120px columns: 16
// characters a side, 43 of 45 lines wrapped mid-word.
const browser = browserForFile();

const STREAM = "pkg/rendering/pagecaching/cache/expiry.go";
const files: FeatureChangedFileDto[] = [STREAM, "engine/planner.go"].map((file) => ({
  path: file, oldPath: null, status: "M", additions: 3, deletions: 1,
  binary: false, uncommitted: true, untracked: false
}));
const list: FeatureChangesResponse = {
  compare: "head", baseRef: "HEAD", mergeBase: "same-head", head: "same-head",
  files, totalAdditions: 6, totalDeletions: 2
};
const LONG = '\t\tc.storage.logger.Printf("[WARN] cache: entry %d expired with %d bytes pending", c.id, c.pending.Len())';
const patch = {
  path: STREAM, truncated: false, binary: false,
  patch: [
    "@@ -118,5 +118,6 @@ func (c *Cache) Evict() error {",
    " \tc.stateLock.Lock()",
    " \tswitch c.state {",
    "-\t\tclose(c.doneCh)",
    "+\t\tc.sweepOnce.Do(func() { close(c.doneCh) })",
    `+${LONG}`,
    " \t}",
    ""
  ].join("\n")
};

async function open(page: Page, url: string, answer: { list: FeatureChangesResponse; patch: typeof patch } = { list, patch }) {
  await page.route("**/api/features/zoom-worker/changes**", async (route) => {
    const isFile = new URL(route.request().url()).pathname.endsWith("/file");
    await route.fulfill({ json: isFile ? answer.patch : answer.list });
  });
  await page.goto(url);
}

/** What the tab chose, and whether the code reads one line per line. */
async function shape(page: Page) {
  return page.evaluate(() => {
    const tab = document.querySelector('[data-slot="changes-tab"]')!;
    const diff = tab.querySelector('[aria-label="File diff"]');
    const lines = [...tab.querySelectorAll<HTMLElement>('[data-slot="diff-line"]')];
    const scroller = lines[0]?.closest<HTMLElement>(".overflow-x-auto") ?? null;
    const codeCells = [...(diff?.querySelectorAll<HTMLElement>("table td:nth-child(2)") ?? [])];
    return {
      tabWidth: Math.round(tab.getBoundingClientRect().width),
      listBeside: tab.querySelector('aside[aria-label="Changed files"]') !== null,
      fileBar: tab.querySelector('[aria-label="Back to changed files"]') !== null,
      split: diff?.querySelector("table") !== null && diff !== null,
      lineHeights: [...new Set(lines.map((line) => Math.round(line.getBoundingClientRect().height)))],
      lineCount: lines.length,
      scrollerWidth: scroller?.clientWidth ?? 0,
      scrolls: scroller ? scroller.scrollWidth > scroller.clientWidth : false,
      codeCellWidth: codeCells.length ? Math.round(codeCells[0]!.getBoundingClientRect().width) : 0
    };
  });
}

test("the worker panel at a half split drills in: the list, then one file across the panel, unified", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  try {
    await open(page, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.getByRole("tab", { name: "Changes", exact: true }).click();
    await panel.locator(`[id="change-${STREAM}"]`).waitFor();
    const list = await shape(page);
    expect(list.tabWidth).toBeLessThan(816);
    expect(list.listBeside).toBe(false);
    await page.screenshot({ path: path.join(artifactDir("changes-width"), "panel-list.png") });

    await panel.locator(`[id="change-${STREAM}"]`).click();
    await panel.getByText("c.sweepOnce.Do", { exact: false }).waitFor();
    const file = await shape(page);
    expect(file.fileBar).toBe(true);
    expect(file.split).toBe(false);
    // Every line one row tall: nothing wraps; the long one scrolls instead.
    expect(file.lineCount).toBe(6);
    expect(file.lineHeights).toEqual([20]);
    expect(file.scrolls).toBe(true);
    // And the diff has the panel's width, not what a list beside it leaves.
    expect(file.scrollerWidth).toBeGreaterThan(file.tabWidth - 40);
    await page.screenshot({ path: path.join(artifactDir("changes-width"), "panel-file.png") });
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("the worker page at 1440 keeps the list beside a unified diff", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  try {
    await open(page, `${fixture.baseUrl}${WORKER_PATH}?tab=changes&file=${encodeURIComponent(STREAM)}`);
    await page.getByText("c.sweepOnce.Do", { exact: false }).waitFor();
    const seen = await shape(page);
    expect(seen.listBeside).toBe(true);
    expect(seen.fileBar).toBe(false);
    expect(seen.split).toBe(false);
    expect(seen.lineCount).toBe(6);
    expect(seen.lineHeights).toEqual([20]);
    await page.screenshot({ path: path.join(artifactDir("changes-width"), "page-1440.png") });
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("a wide screen splits the diff, 80 columns a side", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 2560, height: 1200 } });
  page.setDefaultTimeout(5000);
  try {
    await open(page, `${fixture.baseUrl}${WORKER_PATH}?tab=changes&file=${encodeURIComponent(STREAM)}`);
    await page.getByText("c.sweepOnce.Do", { exact: false }).first().waitFor();
    const seen = await shape(page);
    expect(seen.listBeside).toBe(true);
    expect(seen.split).toBe(true);
    // 80 monospace columns at the diff's 13px, plus the cell's 16px padding.
    expect(seen.codeCellWidth).toBeGreaterThanOrEqual(Math.floor(80 * 7.83) + 16);
    await page.screenshot({ path: path.join(artifactDir("changes-width"), "page-2560.png") });
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

/** The layout, sampled every frame for `frames` frames: how often it flipped. */
async function flipsOver(page: Page, frames: number) {
  return page.evaluate((count) => new Promise<{ flips: number; beside: boolean }>((resolve) => {
    let last: boolean | null = null;
    let flips = 0;
    let seen = 0;
    const tick = () => {
      const beside = document.querySelector('[data-slot="changes-tab"] aside') !== null;
      if (last !== null && beside !== last) flips++;
      last = beside;
      if (++seen < count) requestAnimationFrame(tick);
      else resolve({ flips, beside });
    };
    requestAnimationFrame(tick);
  }), frames);
}

test("with scrollbars that take width, a tab near a threshold settles instead of switching every frame", async () => {
  // The layout changes the tab's height, and a scrollbar that comes and goes
  // with it changes its width by ~15px: just past the threshold, beside the
  // list → taller → scrollbar → narrower → drilled in → no scrollbar → wider…
  const withScrollbars = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
  const fixture = startWorkspaceFixture();
  const page = await withScrollbars.newPage({ viewport: { width: 1880, height: 900 } });
  page.setDefaultTimeout(5000);
  const tall = { ...patch, patch: ["@@ -1,120 +1,120 @@", ...Array.from({ length: 120 }, (_, i) => ` line ${i + 1}`), ""].join("\n") };
  try {
    await open(page, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, { list, patch: tall });
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.getByRole("tab", { name: "Changes", exact: true }).click();
    await panel.locator(`[id="change-${STREAM}"]`).waitFor();
    const layouts = new Set<boolean>();
    // An 8px step always lands inside the ~15px band a scrollbar opens up, and
    // a layout that flips every frame shows it within 12.
    for (let width = 1880; width <= 2000; width += 8) {
      await page.setViewportSize({ width, height: 900 });
      const seen = await flipsOver(page, 12);
      layouts.add(seen.beside);
      // One switch as the width crosses a threshold; never back and forth.
      expect({ width, flips: seen.flips }).toEqual({ width, flips: Math.min(seen.flips, 1) });
    }
    // The sweep crossed the threshold: both layouts were on screen.
    expect([...layouts].sort()).toEqual([false, true]);
  } finally {
    await page.close();
    await withScrollbars.close();
    fixture.stop();
  }
}, 60_000);

test("a deep link opened drilled in shows its row when the list comes back beside the diff", async () => {
  const many: FeatureChangedFileDto[] = Array.from({ length: 70 }, (_, i) => ({
    path: `pkg/file_${String(i).padStart(2, "0")}.go`, oldPath: null, status: "M", additions: 1, deletions: 1,
    binary: false, uncommitted: true, untracked: false
  }));
  const target = many[64]!.path;
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.setDefaultTimeout(5000);
  try {
    await open(page, `${fixture.baseUrl}${WORKER_PATH}?tab=changes&file=${encodeURIComponent(target)}`,
      { list: { ...list, files: many, totalAdditions: 70, totalDeletions: 70 }, patch });
    // Narrow: the file itself, no list.
    await page.getByRole("button", { name: "Back to changed files", exact: true }).waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-slot="changes-tab"] aside').waitFor();
    await page.waitForFunction(() => {
      const aside = document.querySelector('[data-slot="changes-tab"] aside')!;
      const row = aside.querySelector('[aria-current="true"]');
      if (!row) return false;
      const a = aside.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      // "nearest" can leave it flush with an edge: allow the subpixel.
      return r.top >= a.top - 1 && r.bottom <= Math.min(a.bottom, window.innerHeight) + 1;
    }, undefined, { timeout: 2000 });
    expect(await page.locator('[data-slot="changes-tab"] aside [aria-current="true"]').getAttribute("id")).toBe(`change-${target}`);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("the row still comes into view when the list is reloading as the tab widens", async () => {
  const many: FeatureChangedFileDto[] = Array.from({ length: 70 }, (_, i) => ({
    path: `pkg/file_${String(i).padStart(2, "0")}.go`, oldPath: null, status: "M", additions: 1, deletions: 1,
    binary: false, uncommitted: true, untracked: false
  }));
  const target = many[64]!.path;
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.setDefaultTimeout(5000);
  // The branch comparison's list is held until released.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/features/zoom-worker/changes**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/file")) return route.fulfill({ json: patch });
    const branch = url.searchParams.get("compare") === "branch";
    if (branch) await held;
    await route.fulfill({ json: { ...list, compare: branch ? "branch" : "head", files: many, totalAdditions: 70, totalDeletions: 70 } });
  });
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=changes&file=${encodeURIComponent(target)}`);
    await page.getByRole("button", { name: "Back to changed files", exact: true }).waitFor();
    await page.getByRole("button", { name: "Since base", exact: true }).click();
    await page.locator('[data-slot="changes-tab"] [data-slot="loading-line"]').waitFor();
    await page.setViewportSize({ width: 1440, height: 900 });
    // The layout has left drill-in while the list is still loading; only then
    // does the list arrive.
    await page.locator('[data-slot="changes-tab"][data-layout="unified"]').waitFor();
    expect(await page.locator('[data-slot="changes-tab"] [data-slot="loading-line"]').isVisible()).toBe(true);
    release();
    await page.locator('[data-slot="changes-tab"] aside').waitFor();
    await page.waitForFunction(() => {
      const aside = document.querySelector('[data-slot="changes-tab"] aside')!;
      const row = aside.querySelector('[aria-current="true"]');
      if (!row) return false;
      const a = aside.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return r.top >= a.top - 1 && r.bottom <= Math.min(a.bottom, window.innerHeight) + 1;
    }, undefined, { timeout: 2000 });
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("a refresh beside the list leaves the list where it was scrolled", async () => {
  const many: FeatureChangedFileDto[] = Array.from({ length: 70 }, (_, i) => ({
    path: `pkg/file_${String(i).padStart(2, "0")}.go`, oldPath: null, status: "M", additions: 1, deletions: 1,
    binary: false, uncommitted: true, untracked: false
  }));
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  let lists = 0;
  await page.route("**/api/features/zoom-worker/changes**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/file")) return route.fulfill({ json: patch });
    lists++;
    await route.fulfill({ json: { ...list, files: many, totalAdditions: 69 + lists, totalDeletions: 70 } });
  });
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=changes&file=${encodeURIComponent(many[64]!.path)}`);
    const aside = page.locator('[data-slot="changes-tab"] aside');
    await aside.waitFor();
    // The deep link scrolled the list once; the reader scrolls back to the top.
    await page.waitForFunction(() => document.querySelector('[data-slot="changes-tab"] aside')!.scrollTop > 0);
    await aside.evaluate((element) => { element.scrollTop = 0; });
    await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
    await page.getByText("+71", { exact: true }).waitFor();
    await page.waitForTimeout(100);
    expect(await aside.evaluate((element) => element.scrollTop)).toBe(0);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("the row comes into view when a retry brings the list back after an error", async () => {
  const many: FeatureChangedFileDto[] = Array.from({ length: 70 }, (_, i) => ({
    path: `pkg/file_${String(i).padStart(2, "0")}.go`, oldPath: null, status: "M", additions: 1, deletions: 1,
    binary: false, uncommitted: true, untracked: false
  }));
  const target = many[64]!.path;
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  page.setDefaultTimeout(5000);
  let lists = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/features/zoom-worker/changes**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/file")) return route.fulfill({ json: patch });
    lists++;
    if (lists === 2) return route.fulfill({ status: 500, json: { error: "git failed" } });
    if (lists === 3) await held;
    await route.fulfill({ json: { ...list, files: many, totalAdditions: 70, totalDeletions: 70 } });
  });
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}?tab=changes&file=${encodeURIComponent(target)}`);
    await page.getByRole("button", { name: "Back to changed files", exact: true }).waitFor();
    await page.getByRole("button", { name: "Refresh changes", exact: true }).click();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    // Widened on the error screen, then Retry: the list it kept comes back
    // while the retried request is still out.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-slot="changes-tab"][data-layout="unified"]').waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator('[data-slot="changes-tab"] aside').waitFor();
    await page.waitForFunction(() => {
      const aside = document.querySelector('[data-slot="changes-tab"] aside')!;
      const row = aside.querySelector('[aria-current="true"]');
      if (!row) return false;
      const a = aside.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return r.top >= a.top - 1 && r.bottom <= Math.min(a.bottom, window.innerHeight) + 1;
    }, undefined, { timeout: 2000 });
  } finally {
    release();
    await page.close();
    fixture.stop();
  }
}, 20_000);
