import { expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import type { FeatureChangedFileDto, FeatureChangesResponse } from "../src/shared/api-contracts";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

/**
 * The Changes toolbar and the file header in a narrow space. In the worker
 * panel of an 820 window (then a 268px tab) the toolbar squeezed each item
 * until it wrapped inside itself ("21 / files / vs / main", "+475 / −5",
 * "Since / base"), and the header broke a path mid-name ("cache/ex|piry.go").
 * Now each item keeps to one line and the row wraps between items, the
 * toggle and Refresh together; a path breaks after its slashes.
 *
 * The narrowest worker panel is 320px (SIDE_PANEL_WIDTH_MIN): a row wide
 * enough for both sides with the panel dragged to its minimum. A row too
 * narrow for both shows the panel whole.
 */

const browser = browserForFile();
const STREAM = "pkg/rendering/pagecaching/cache/expiry.go";
const files: FeatureChangedFileDto[] = [STREAM, "engine/planner.go", ...Array.from({ length: 19 }, (_, i) => `pkg/schema/v1/field_${i}.go`)]
  .map((file, i) => ({
    path: file, oldPath: null, status: "M", additions: i === 0 ? 400 : 4, deletions: i === 0 ? 5 : 0,
    binary: false, uncommitted: true, untracked: false
  }));
const LONG_REF = "origin/release/v0.62-maintenance-backports";
const NARROWEST = { width: 1024, height: 900 };

/** The panel's share of the row at 0: clamped to its 320px minimum. */
async function panelAtMinimum(page: Page) {
  await page.addInitScript(() => localStorage.setItem("mandate.ui", JSON.stringify({ state: { workerPanelRatio: 0 }, version: 0 })));
}

async function open(page: Page, url: string, baseRef = "main", hold?: Promise<void>) {
  const list: FeatureChangesResponse = {
    compare: "branch", baseRef, mergeBase: "same-head", head: "same-head",
    files, totalAdditions: 475, totalDeletions: 5
  };
  await page.route("**/api/features/zoom-worker/changes**", async (route) => {
    const isFile = new URL(route.request().url()).pathname.endsWith("/file");
    if (!isFile && hold) await hold;
    await route.fulfill({ json: isFile ? { path: STREAM, truncated: false, binary: false, patch: "@@ -1 +1 @@\n-old\n+new\n" } : list });
  });
  await page.goto(url);
}

async function openChanges(page: Page, baseUrl: string, where: "panel" | "page", baseRef?: string) {
  if (where === "panel") {
    await open(page, `${baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, baseRef);
    await page.locator('[data-slot="worker-panel"]').getByRole("tab", { name: "Changes", exact: true }).click();
  } else {
    await open(page, `${baseUrl}${WORKER_PATH}?tab=changes`, baseRef);
  }
  await page.locator(`[id="change-${STREAM}"]`).waitFor();
  await page.getByRole("button", { name: "Since base" }).click();
  await page.locator('[data-slot="changes-toolbar"]').getByText(baseRef ?? "main").waitFor();
}

/** Each toolbar item's box and how many lines its text takes. */
async function toolbar(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('[data-slot="changes-toolbar"]')!;
    const tab = bar.closest('[data-slot="changes-tab"]')!.getBoundingClientRect();
    const measure = (el: Element) => {
      const r = el.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.bottom))).size;
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), lines, lineHeight };
    };
    const [count, totals] = [...bar.children];
    return {
      tab: { left: Math.round(tab.left), right: Math.round(tab.right) },
      count: measure(count!),
      totals: measure(totals!),
      buttons: [...bar.querySelectorAll('[aria-label="Compare against"] button')].map(measure),
      refresh: measure(bar.querySelector('[aria-label="Refresh changes"]')!)
    };
  });
}

/** The file header's path, as the lines it is drawn on. */
async function headerLines(page: Page) {
  return page.evaluate(() => {
    const span = document.querySelector('[aria-label="File diff"] header span.font-mono')!;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    const lines: string[] = [];
    let line = "";
    let lastTop: number | null = null;
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      for (let i = 0; i < node.data.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const top = Math.round(range.getBoundingClientRect().top);
        if (lastTop !== null && top > lastTop) { lines.push(line); line = ""; }
        line += node.data[i];
        lastTop = top;
      }
    }
    lines.push(line);
    return lines;
  });
}

const cases = [
  { label: "worker panel at its narrowest", viewport: NARROWEST, where: "panel" as const, narrow: true, minimum: true },
  { label: "worker page on a phone", viewport: { width: 390, height: 844 }, where: "page" as const, narrow: true, phone: true },
  { label: "worker panel at a 1440 half split", viewport: { width: 1440, height: 900 }, where: "panel" as const, narrow: false }
];

for (const { label, viewport, where, narrow, phone, minimum } of cases) {
  test(`the Changes toolbar keeps each item on one line (${label})`, async () => {
    const fixture = startWorkspaceFixture();
    const page = await browser.newPage({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    try {
      if (minimum) await panelAtMinimum(page);
      await openChanges(page, fixture.baseUrl, where);
      const bar = await toolbar(page);
      await page.screenshot({ path: path.join(artifactDir("changes-toolbar"), `${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
      for (const item of [bar.count, bar.totals, ...bar.buttons]) expect(item.lines).toBe(1);
      expect(bar.buttons).toHaveLength(2);
      // Toggle and Refresh share a row, Refresh at the toolbar's far end.
      expect(Math.abs((bar.refresh.top + bar.refresh.bottom) / 2 - (bar.buttons[0]!.top + bar.buttons[0]!.bottom) / 2)).toBeLessThanOrEqual(2);
      expect(Math.abs(bar.tab.right - bar.refresh.right)).toBeLessThanOrEqual(2);
      for (const item of [bar.count, bar.totals, ...bar.buttons, bar.refresh]) {
        expect(item.left).toBeGreaterThanOrEqual(bar.tab.left);
        expect(item.right).toBeLessThanOrEqual(bar.tab.right);
      }
      if (narrow) {
        // The row wrapped between items: the toggle sits below the count.
        expect(bar.buttons[0]!.top).toBeGreaterThan(bar.count.bottom);
        expect(bar.totals.top).toBe(bar.count.top);
      } else {
        expect(bar.buttons[0]!.top).toBeLessThan(bar.count.bottom);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 20_000);
}

test("in the narrowest tab (a thread's worker panel at its minimum) nothing leaves the tab, loading or loaded", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: NARROWEST });
  page.setDefaultTimeout(8000);
  await panelAtMinimum(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    await open(page, `${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`, "main", hold);
    await page.locator('[data-slot="worker-panel"]').getByRole("tab", { name: "Changes", exact: true }).click();
    // Loading: the toggle stands alone above the loading line.
    await page.locator('[data-slot="changes-tab"] [data-slot="loading-line"]').waitFor();
    const loading = await page.evaluate(() => {
      const tab = document.querySelector('[data-slot="changes-tab"]')!.getBoundingClientRect();
      const buttons = [...document.querySelectorAll('[aria-label="Compare against"] button')].map((b) => b.getBoundingClientRect());
      return { tab: { left: tab.left, right: tab.right, width: tab.width }, buttons: buttons.map((b) => ({ left: b.left, right: b.right, height: b.height })) };
    });
    expect(loading.tab.width).toBeLessThanOrEqual(320);
    for (const button of loading.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(loading.tab.left);
      expect(button.right).toBeLessThanOrEqual(loading.tab.right);
    }
    release();
    await page.locator(`[id="change-${STREAM}"]`).waitFor();
    const bar = await toolbar(page);
    await page.screenshot({ path: path.join(artifactDir("changes-toolbar"), "narrowest-tab.png") });
    for (const item of [bar.count, bar.totals, ...bar.buttons]) expect(item.lines).toBe(1);
    for (const item of [bar.count, bar.totals, ...bar.buttons, bar.refresh]) {
      expect(item.left).toBeGreaterThanOrEqual(bar.tab.left);
      expect(item.right).toBeLessThanOrEqual(bar.tab.right);
    }
  } finally {
    release();
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("a long base ref stays on one line inside the tab; the file header breaks a path after its slashes, not inside a name", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: NARROWEST });
  page.setDefaultTimeout(8000);
  try {
    await panelAtMinimum(page);
    await openChanges(page, fixture.baseUrl, "panel", LONG_REF);
    const bar = await toolbar(page);
    expect(bar.count.lines).toBe(1);
    expect(bar.count.right).toBeLessThanOrEqual(bar.tab.right);

    await page.locator(`[id="change-${STREAM}"]`).click();
    await page.locator('[aria-label="File diff"]').waitFor();
    const lines = await headerLines(page);
    await page.screenshot({ path: path.join(artifactDir("changes-toolbar"), "file-header.png") });
    // Too long for one line here, so it wrapped; every break follows a slash.
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe(STREAM);
    for (const line of lines.slice(0, -1)) expect(line.endsWith("/")).toBe(true);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

// A worker made to work in the project's own directory has no branch of its
// own. It had no Changes tab at all. It has one now, showing what is
// uncommitted, with no choice of comparison: there is no base to choose.
for (const { label, viewport, phone, minimum } of [
  { label: "worker panel at its narrowest", viewport: NARROWEST, minimum: true },
  { label: "worker sheet on a phone", viewport: { width: 390, height: 844 }, phone: true }
]) {
  test(`a worker with no branch of its own has Changes, without a choice of comparison (${label})`, async () => {
    const fixture = startWorkspaceFixture();
    fixture.setFeature("zoom-worker", { branch: null, baseRef: null });
    const page = await browser.newPage({ viewport, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    const asked: string[] = [];
    try {
      if (minimum) await panelAtMinimum(page);
      const list: FeatureChangesResponse = { compare: "head", baseRef: "HEAD", mergeBase: "same-head", head: "same-head", files, totalAdditions: 475, totalDeletions: 5 };
      await page.route("**/api/features/zoom-worker/changes**", async (route) => {
        const url = new URL(route.request().url());
        asked.push(url.pathname + url.search);
        await route.fulfill({ json: url.pathname.endsWith("/file") ? { path: STREAM, truncated: false, binary: false, patch: "@@ -1 +1 @@\n-old\n+new\n" } : list });
      });
      await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
      const tabs = page.locator('[data-slot="worker-tabs"]');
      await tabs.waitFor();
      expect(await tabs.getByRole("tab").allTextContents()).toEqual(["Chat", "Plan", "Changes", "Canvases", "Terminal"]);
      const changes = tabs.getByRole("tab", { name: "Changes", exact: true });
      if (phone) await changes.tap(); else await changes.click();
      await page.locator(`[id="change-${STREAM}"]`).waitFor();
      const bar = await toolbar(page);
      await page.screenshot({ path: path.join(artifactDir("changes-toolbar"), `no-branch-${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
      expect(bar.buttons).toEqual([]);
      expect(await page.getByText("Since base").count()).toBe(0);
      // Count, totals and Refresh on one row, Refresh at its far end, all inside the tab.
      for (const item of [bar.count, bar.totals]) expect(item.lines).toBe(1);
      expect(bar.totals.top).toBe(bar.count.top);
      expect(Math.abs((bar.refresh.top + bar.refresh.bottom) / 2 - (bar.count.top + bar.count.bottom) / 2)).toBeLessThanOrEqual(2);
      expect(Math.abs(bar.tab.right - bar.refresh.right)).toBeLessThanOrEqual(2);
      for (const item of [bar.count, bar.totals, bar.refresh]) {
        expect(item.left).toBeGreaterThanOrEqual(bar.tab.left);
        expect(item.right).toBeLessThanOrEqual(bar.tab.right);
      }
      // Only what is uncommitted was ever asked for.
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.filter((url) => url.includes("compare=branch"))).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 20_000);
}
