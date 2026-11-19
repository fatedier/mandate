import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { emptyPlan, type WorkerPlanDto } from "../src/shared/api/plans";
import type { WorkerChangedFileDto, WorkerChangesResponse } from "../src/shared/api-contracts";
import { startWorkspaceFixture, THREAD_ID, workerPath } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { settle } from "./helpers/settle";

// A worker's tabs stay at the top on every tab. Only Chat had
// its own scroller; on Plan and the rest the whole view scrolled, the tabs
// with it. Now they are pinned and what scrolls passes under a 16px fade.
// On a phone's sheet the panel's own header (the worker tabs) stays too.

const browser = browserForFile();
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const at = "2026-10-08T10:00:00.000Z";
const plan: WorkerPlanDto = {
  ...emptyPlan("zoom-worker"),
  conclusion: "Spacing pass delivered, every check green.",
  // Steps not done are all shown (done ones fold into a count), one row
  // each without a note: sixty are enough to scroll on any screen.
  steps: Array.from({ length: 60 }, (_, i) => ({
    id: i + 1, title: `Step ${i + 1}: verify the final tree`, status: i < 2 ? "done" as const : i === 2 ? "in_progress" as const : "pending" as const,
    note: "Every check passed: the unit tests, the format check, the build and the lint.",
    createdAt: at, startedAt: i <= 2 ? at : null, blockedAt: null, completedAt: i < 2 ? at : null, updatedAt: at
  })),
  updatedAt: at
};

/** Where the worker's tab row sits against its scroller, before and after
 *  the scroller moves down, and what the Chat tab's centre hits then. */
async function pinned(page: Page, scope: string) {
  return page.evaluate(async (scope) => {
    const root = document.querySelector(scope)!;
    const tab = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Plan")!;
    const row = tab.closest('[role="tablist"]')!.parentElement!;
    let scroller: HTMLElement | null = row.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    const header = root.querySelector('[aria-label="Worker tabs"]');
    const measure = () => ({
      rowTop: Math.round(row.getBoundingClientRect().top - scroller!.getBoundingClientRect().top),
      headerTop: header ? Math.round(header.getBoundingClientRect().top - scroller!.getBoundingClientRect().top) : null,
      headerBottom: header ? Math.round(header.getBoundingClientRect().bottom - scroller!.getBoundingClientRect().top) : null
    });
    const before = measure();
    // To the end: further than a screen, where a box held to the pane's
    // height lets its pinned bars go.
    scroller!.scrollTop = scroller!.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const after = measure();
    const chat = [...row.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Chat")!;
    const box = chat.getBoundingClientRect();
    const hits = (y: number) => {
      const hit = document.elementFromPoint(box.left + box.width / 2, y);
      return Boolean(hit && chat.contains(hit));
    };
    const middle = box.top + box.height / 2;
    return {
      scrolled: scroller!.scrollTop,
      screen: scroller!.clientHeight,
      before, after,
      chatHit: hits(middle),
      // A touch screen's 44px around the tab's centre, its edges included.
      touchEdgesHit: [hits(middle - 21), hits(middle + 21)],
      fade: getComputedStyle(row, "::after").backgroundImage
    };
  }, scope);
}

/** Focus moved by the keyboard is scrolled into view below the pinned tabs,
 *  not behind them: shift-tabs up a long plan from its last control, and
 *  returns each control focus landed on under the tabs. */
async function coveredShiftTabbingUp(page: Page, scope: string) {
  // From the plan's last control, up.
  await page.evaluate((scope) => {
    const root = document.querySelector(scope)!;
    const controls = [...root.querySelectorAll<HTMLElement>("button, a[href], [tabindex]")]
      .filter((el) => !el.closest('[role="tablist"]') && el.getClientRects().length > 0);
    controls.at(-1)!.focus();
  }, scope);
  const covered: string[] = [];
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Shift+Tab");
    const seen = await page.evaluate((scope) => {
      const root = document.querySelector(scope)!;
      const active = document.activeElement as HTMLElement | null;
      const row = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Plan")!.closest('[role="tablist"]')!;
      const bar = row.closest('[data-slot="worker-tabs"]') ?? row;
      if (!active || !root.contains(active) || bar.contains(active)) return null;
      const box = active.getBoundingClientRect();
      return { top: Math.round(box.top), barBottom: Math.round(bar.getBoundingClientRect().bottom), label: (active.textContent ?? "").trim().slice(0, 40) };
    }, scope);
    if (!seen) break;
    if (seen.top < seen.barBottom) covered.push(`${seen.label} at ${seen.top} under ${seen.barBottom}`);
  }
  return covered;
}

for (const where of ["panel", "phone sheet"] as const) {
  // With a keyboard (a desktop): focus moving up the plan stays below them too.
  const keyboard = where === "panel";
  test(`a worker's tabs stay at the top while its plan scrolls under them${keyboard ? ", and focus moved up it stays below them" : ""} (${where})`, async () => {
    const fixture = startWorkspaceFixture();
    fixture.setPlan(plan);
    const phone = where.startsWith("phone");
    const context = await browser.newContext(phone ? PHONE : { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    const scope = where === "panel" ? '[data-slot="worker-panel"]' : '[data-slot="worker-sheet"]';
    try {
      await page.goto(`${fixture.baseUrl}${workerPath("plan")}`);
      await page.locator(scope).getByText("Step 60: verify the final tree").waitFor();
      await settle(page);
      const seen = await pinned(page, scope);
      await look(page, where.replace(" ", "-"));
      expect(seen.scrolled).toBeGreaterThan(seen.screen);
      if (where === "phone sheet") {
        // The sheet's body scrolls: the panel's header stays at its top and
        // the worker's tabs right under it.
        expect(seen.after.headerTop).toBe(seen.before.headerTop);
        expect(seen.after.headerTop).toBe(0);
        expect(seen.after.rowTop).toBe(seen.after.headerBottom!);
      } else {
        expect(seen.after.rowTop).toBe(0);
      }
      expect(seen.chatHit).toBe(true);
      // Pinned, a tab keeps its whole touch area: nothing above or below
      // covers or clips it.
      if (phone) expect(seen.touchEdgesHit).toEqual([true, true]);
      expect(seen.fade).toContain("linear-gradient");
      if (keyboard) expect(await coveredShiftTabbingUp(page, scope)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      fixture.stop();
    }
  }, 30_000);
}

// The Changes tab's own pinned parts sit under the tabs, not behind them.
const STREAM = "pkg/rendering/pagecaching/cache/expiry.go";
const files: WorkerChangedFileDto[] = Array.from({ length: 30 }, (_, i) => ({
  path: i === 0 ? STREAM : `pkg/file_${i}.go`, oldPath: null, status: "M", additions: 27, deletions: 0, binary: false, uncommitted: true, untracked: false
}));
const list: WorkerChangesResponse = { compare: "head", baseRef: "HEAD", mergeBase: "x", head: "x", files, totalAdditions: 810, totalDeletions: 0 };
const patchFor = (file: string) => ({
  path: file, truncated: false, binary: false,
  patch: ["@@ -100,40 +100,200 @@", ...Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? "+" : " ") + `\t${file.replace(/\W/g, "_")}.line${i}()`)].join("\n")
});

test("with the file list beside the diff, the list stays under the worker's tabs as the diff scrolls", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.route("**/api/workers/zoom-worker/changes**", async (route) => {
      const requested = new URL(route.request().url());
      await route.fulfill({ json: requested.pathname.endsWith("/file") ? patchFor(requested.searchParams.get("path") ?? STREAM) : list });
    });
    // The panel given the whole row (its maximize): the list beside the diff.
    await page.goto(`${fixture.baseUrl}${workerPath("changes")}`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.getByRole("button", { name: "Maximize panel" }).click();
    await panel.locator('aside[aria-label="Changed files"]').waitFor();
    await panel.locator('[data-slot="diff-line"]').nth(150).waitFor();
    const seen = await page.evaluate(async () => {
      const root = document.querySelector('[data-slot="worker-panel"]')!;
      // The panel's own scroller, around the Changes tab.
      let scroller = root.querySelector('[data-slot="changes-tab"]')!.parentElement!;
      while (!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement!;
      scroller.scrollTop = 1200;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const tab = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Changes")!;
      const row = tab.closest('[role="tablist"]')!.parentElement!;
      const aside = root.querySelector('aside[aria-label="Changed files"]')!;
      return {
        scrolled: scroller.scrollTop,
        rowBottom: Math.round(row.getBoundingClientRect().bottom),
        asideTop: Math.round(aside.getBoundingClientRect().top),
        asideBottom: Math.round(aside.getBoundingClientRect().bottom),
        viewport: window.innerHeight
      };
    });
    await look(page, "changes-wide");
    expect(seen.scrolled).toBeGreaterThan(1000);
    // 16px under the tabs, as it sat 16px under the top before, and still
    // inside the window.
    expect(seen.asideTop - seen.rowBottom).toBe(16);
    expect(seen.asideBottom).toBeLessThanOrEqual(seen.viewport);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("on a phone, deep in an opened file's diff, its bar stays under the worker's tabs (worker sheet)", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  const scope = '[data-slot="worker-sheet"]';
  try {
    await page.route("**/api/workers/zoom-worker/changes**", async (route) => {
      const requested = new URL(route.request().url());
      await route.fulfill({ json: requested.pathname.endsWith("/file") ? patchFor(requested.searchParams.get("path") ?? STREAM) : list });
    });
    await page.goto(`${fixture.baseUrl}${workerPath()}`);
    await page.locator(scope).getByRole("tab", { name: "Changes", exact: true }).click();
    await page.locator(`[id="change-${STREAM}"]`).click();
    await page.locator(scope).locator('[data-slot="diff-line"]').nth(150).waitFor();
    await settle(page);
    const seen = await page.evaluate(async (scope) => {
      const root = document.querySelector(scope)!;
      const row = root.querySelector('[data-slot="worker-tabs"]')!;
      const bar = root.querySelector('[aria-label="Back to changed files"]')!.parentElement!;
      let scroller: HTMLElement | null = bar.parentElement;
      while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
      scroller!.scrollTop += 1500;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const chat = [...row.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Chat")!;
      const box = chat.getBoundingClientRect();
      const hits = (y: number) => {
        const hit = document.elementFromPoint(box.left + box.width / 2, y);
        return Boolean(hit && chat.contains(hit));
      };
      const middle = box.top + box.height / 2;
      return {
        rowBottom: Math.round(row.getBoundingClientRect().bottom),
        barTop: Math.round(bar.getBoundingClientRect().top),
        chatHit: hits(middle),
        touchEdgesHit: [hits(middle - 21), hits(middle + 21)]
      };
    }, scope);
    await look(page, "changes-deep-sheet");
    expect(seen.barTop).toBe(seen.rowBottom);
    expect(seen.chatHit).toBe(true);
    // The bar under the tabs leaves the tab's touch area whole.
    expect(seen.touchEdgesHit).toEqual([true, true]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);


test("an archived worker's tabs in the thread's panel stay at the top too, and focus moved up its plan stays below them", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setPlan({ ...plan, workerId: "x" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.addInitScript((threadId) => {
      const x = { workerId: "x", name: "x", projectId: "zoom-project", projectName: "Zoom project", workerThreadId: null, archivedAt: new Date().toISOString() };
      const panel = { open: true, tabs: ["archived:x"], active: "archived:x", workerTab: { "archived:x": "plan" }, archived: { "archived:x": x } };
      localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({ state: { byThread: { [threadId]: panel } }, version: 0 }));
    }, THREAD_ID);
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.getByText("Step 60: verify the final tree").waitFor();
    await settle(page);
    const seen = await page.evaluate(async () => {
      const root = document.querySelector('[data-slot="worker-panel"]')!;
      const tab = [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent?.trim() === "Plan")!;
      const row = tab.closest('[role="tablist"]')!;
      let scroller: HTMLElement | null = row.parentElement;
      while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
      scroller!.scrollTop = scroller!.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        scrolled: scroller!.scrollTop,
        screen: scroller!.clientHeight,
        rowTop: Math.round(row.getBoundingClientRect().top - scroller!.getBoundingClientRect().top),
        fade: getComputedStyle(row, "::after").backgroundImage
      };
    });
    await look(page, "archived-panel");
    expect(seen.scrolled).toBeGreaterThan(seen.screen);
    expect(seen.rowTop).toBe(0);
    expect(seen.fade).toContain("linear-gradient");
    expect(await coveredShiftTabbingUp(page, '[data-slot="worker-panel"]')).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

test("on a phone, back from deep in a file, the file's row is revealed below the pinned tabs, clear of their fade", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  // Near the list's top: back from deep in its diff the list is scrolled
  // past it, so revealing it brings it down from above the tabs.
  const target = "pkg/file_3.go";
  try {
    await page.route("**/api/workers/zoom-worker/changes**", async (route) => {
      const requested = new URL(route.request().url());
      await route.fulfill({ json: requested.pathname.endsWith("/file") ? patchFor(requested.searchParams.get("path") ?? STREAM) : list });
    });
    // The worker in its thread's sheet, whose body scrolls.
    await page.goto(`${fixture.baseUrl}${workerPath("changes")}`);
    const sheet = page.locator('[data-slot="worker-sheet"]');
    await page.locator(`[id="change-${target}"]`).click();
    await sheet.locator('[data-slot="diff-line"]').nth(150).waitFor();
    await page.evaluate(() => { document.querySelector('[data-slot="worker-sheet"] [data-slot="bottom-sheet-body"]')!.scrollTop += 2000; });
    await settle(page);
    await sheet.getByRole("button", { name: "Back to changed files" }).click();
    await page.locator(`[id="change-${target}"]`).waitFor();
    await settle(page);
    const seen = await page.evaluate((target) => ({
      rowTop: Math.round(document.getElementById(`change-${target}`)!.getBoundingClientRect().top),
      tabsBottom: Math.round(document.querySelector('[data-slot="worker-sheet"] [data-slot="worker-tabs"]')!.getBoundingClientRect().bottom)
    }), target);
    expect(seen.rowTop).toBeGreaterThanOrEqual(seen.tabsBottom + 16);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

// An archived worker's Plan tab, in its thread's panel: its record is there too.
test("an archived worker's Plan tab shows its record", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setPlan({ ...plan, workerId: "x" });
  fixture.setRecord("x", { id: "mem_recx", content: "Verify the final tree\n\nDone: every step checked", updatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.addInitScript((threadId) => {
      const x = { workerId: "x", name: "x", projectId: "zoom-project", projectName: "Zoom project", workerThreadId: null, archivedAt: new Date().toISOString() };
      const panel = { open: true, tabs: ["archived:x"], active: "archived:x", workerTab: { "archived:x": "plan" }, archived: { "archived:x": x } };
      localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({ state: { byThread: { [threadId]: panel } }, version: 0 }));
    }, THREAD_ID);
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
    const panel = page.locator('[data-slot="worker-panel"]');
    const row = panel.locator('[data-slot="plan-work-record"]');
    await row.waitFor();
    expect(await row.textContent()).toBe("Work record · Updated 3d ago");
    expect(await panel.locator('[data-slot="plan-work-record-first-line"]').textContent()).toBe("Verify the final tree");
    await row.click();
    await panel.locator('[data-slot="plan-work-record-body"]').getByText("every step checked").waitFor();
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 30_000);

