import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

// A thread's right panel is a row of tabs: Workers first, then the workers
// and the reports and canvases opened from the page. On a wide desktop row a
// canvas opens there, beside the chat, not over the window; the panel's Hide
// chat gives it the row. Layout and keys are the browser's, so this runs in
// one. Its shots, for a look at 1440, 1280 and 960, are kept under a fixed
// path (the run's own folder goes when it passes).

const browser = browserForFile();
const THREAD = `/threads/${THREAD_ID}`;
const SHOTS = path.join(import.meta.dir, ".artifacts", "preview-panel-tabs");

function shot(name: string): string {
  fs.mkdirSync(SHOTS, { recursive: true });
  return path.join(SHOTS, name);
}

test("a report from a worker's Canvases opens beside the chat, and Hide chat gives it the row", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setFeature("other-worker", { ownerThreadId: THREAD_ID });
  for (const width of [1440, 1280, 960]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    try {
      await page.goto(`${fixture.baseUrl}${THREAD}?worker=zoom-worker`);
      const panel = page.locator('[data-slot="worker-panel"]');
      await panel.locator('[data-worker-tab="zoom-worker"][aria-selected="true"]').waitFor();
      await panel.locator('[data-slot="worker-tabs"]').getByText("Canvases", { exact: true }).first().click();
      await panel.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).click();
      const tab = panel.locator('[data-canvas-tab="zoom-canvas"]');
      await panel.locator('[data-canvas-tab="zoom-canvas"][aria-selected="true"]').waitFor();
      await panel.locator('[data-slot="canvas-tab-view"]:not(.hidden) iframe').waitFor();
      // Beside the chat, not over the window; the address stays the thread's.
      expect(await page.getByRole("dialog", { name: "Canvas", exact: true }).count()).toBe(0);
      expect(new URL(page.url()).pathname).toBe(THREAD);
      // Named by its title once read: this fixture's id is not shaped as a
      // canvas's, so its title is not asked for (the next test's are).
      expect(await tab.count()).toBe(1);
      expect(await panel.locator('[data-slot="canvas-tab-bar"]').first().textContent()).toContain("Report · updated");
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot(`thread-report-tab-${width}.png`) });

      // Opened again from the same list: the same tab, not a second one.
      await panel.locator('[data-worker-tab="zoom-worker"]').click();
      await panel.locator('[data-slot="worker-tabs"]').getByText("Canvases", { exact: true }).first().click();
      await panel.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).click();
      await panel.locator('[data-canvas-tab="zoom-canvas"][aria-selected="true"]').waitFor();
      expect(await panel.locator("[data-canvas-tab]").count()).toBe(1);

      if (width >= 1280) {
        // Hide chat: the panel takes the row; the shortcut brings the chat back.
        const row = await panel.evaluate((el) => el.parentElement!.getBoundingClientRect().width);
        await panel.getByRole("button", { name: "Hide chat", exact: true }).click();
        await page.waitForFunction(() => {
          const p = document.querySelector('[data-slot="worker-panel"]')!;
          return p.getBoundingClientRect().width >= p.parentElement!.getBoundingClientRect().width - 2;
        });
        expect(await panel.getByRole("button", { name: "Show chat", exact: true }).count()).toBe(1);
        await page.screenshot({ path: shot(`thread-report-tab-chat-hidden-${width}.png`) });
        await page.keyboard.press("Control+Shift+Enter");
        await page.waitForFunction((full) => document.querySelector('[data-slot="worker-panel"]')!.getBoundingClientRect().width < full * 0.75, row);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }
  fixture.stop();
}, 90_000);

test("at 960 many tabs scroll and the open canvas tab stays in sight", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setFeature("other-worker", { ownerThreadId: THREAD_ID });
  for (const id of ["cnv_RelNotes001", "cnv_DrillRep002", "cnv_PlanDoc0003"]) fixture.addCanvas(id, `Report ${id.slice(4, 11)}`);
  const page = await browser.newPage({ viewport: { width: 960, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  // Which canvases' documents the page reads (/api/canvas/<id>, and below it).
  const reads = new Set<string>();
  page.on("request", (request) => {
    const parts = new URL(request.url()).pathname.split("/");
    if (parts[1] === "api" && parts[2] === "canvas" && parts[3]) reads.add(decodeURIComponent(parts[3]));
  });
  try {
    await page.addInitScript((threadId) => {
      // The page only: a report's sandboxed frame has no storage to write.
      if (window.top !== window) return;
      localStorage.setItem("mandate.worker-panel.v1", JSON.stringify({ state: { byThread: { [threadId]: {
        open: true,
        tabs: ["zoom-worker", "other-worker", "canvas:zoom-canvas", "canvas:cnv_RelNotes001", "canvas:cnv_DrillRep002", "canvas:cnv_PlanDoc0003"],
        active: "canvas:cnv_PlanDoc0003",
        workerTab: {}
      } } }, version: 0 }));
    }, THREAD_ID);
    await page.goto(`${fixture.baseUrl}${THREAD}`);
    const panel = page.locator('[data-slot="worker-panel"]');
    await panel.locator('[data-canvas-tab="cnv_PlanDoc0003"][aria-selected="true"]').waitFor();
    await panel.locator('[data-canvas-tab="cnv_PlanDoc0003"]').getByText("Report PlanDoc").waitFor();
    // The open canvas has been read and drawn (its title comes from another read).
    await panel.locator('[data-slot="canvas-tab-view"]:not(.hidden) iframe').waitFor();
    await page.waitForTimeout(400);
    const placed = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Worker tabs"]')!;
      const r = row.getBoundingClientRect();
      const tab = row.querySelector<HTMLElement>('[data-canvas-tab="cnv_PlanDoc0003"]')!.getBoundingClientRect();
      return { scrolls: row.scrollWidth > row.clientWidth + 1, left: Math.round(tab.left - r.left), right: Math.round(r.right - tab.right), page: [window.scrollX, window.scrollY] };
    });
    expect(placed.scrolls).toBe(true);
    expect(placed.left).toBeGreaterThanOrEqual(0);
    expect(placed.right).toBeGreaterThanOrEqual(0);
    expect(placed.page).toEqual([0, 0]);
    // Only the canvas on screen was read; the others wait until shown.
    expect([...reads]).toEqual(["cnv_PlanDoc0003"]);
    await page.screenshot({ path: shot("thread-many-tabs-960.png") });
    // Shown once, a canvas is read; the one left keeps its place unread.
    await panel.locator('[data-canvas-tab="cnv_DrillRep002"]').evaluate((el) => (el as HTMLElement).click());
    await panel.locator('[data-canvas-tab="cnv_DrillRep002"][aria-selected="true"]').waitFor();
    await panel.locator('[data-slot="canvas-tab-view"]:not(.hidden) iframe').waitFor();
    expect([...reads].sort()).toEqual(["cnv_DrillRep002", "cnv_PlanDoc0003"]);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 40_000);

test("the Workers tab at 1440 and on a phone: cards, then the thread's reports", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setFeature("other-worker", { ownerThreadId: THREAD_ID });
  // A worker at work on a step of its goal; one done, with what it found.
  const at = new Date().toISOString();
  const step = (id: number, title: string, status: "done" | "in_progress" | "pending") => ({
    id, title, status, note: null, createdAt: at, startedAt: null, blockedAt: null, completedAt: status === "done" ? at : null, updatedAt: at
  });
  const plan = { conclusion: null, openQuestions: [] as string[], goalHistory: [], updatedAt: at };
  fixture.setPlan({ ...plan, featureId: "zoom-worker", goal: "Keep the zoomed pane's size when the window resizes", steps: [
    step(1, "Reproduce the lost zoom", "done"), step(2, "Keep the size across a resize", "in_progress"), step(3, "Report", "pending")
  ] });
  fixture.setPlan({ ...plan, featureId: "other-worker", goal: "Find why the pane list flickers", conclusion: "The list redrew on every size event. Coalesced now.", steps: [step(1, "Trace the redraws", "done")] });
  try {
    for (const viewport of [{ width: 1440, height: 900, phone: false }, { width: 390, height: 844, phone: true }]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, ...(viewport.phone ? { isMobile: true, hasTouch: true } : {}) });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = trackPageErrors(page);
      try {
        await page.goto(`${fixture.baseUrl}${THREAD}`);
        if (viewport.phone) await page.getByRole("button", { name: "Workers" }).first().click();
        const reports = page.locator('section[aria-label="Reports and canvases"]');
        await reports.waitFor();
        expect(await reports.locator("[data-slot=thread-canvas]").count()).toBeGreaterThan(0);
        const card = page.locator('[data-worker="zoom-worker"]').first();
        expect(await card.locator("[data-slot=worker-progress]").textContent()).toBe("Step 2 of 3 · Keep the size across a resize");
        expect(await card.locator("[data-slot=worker-goal]").textContent()).toBe("Goal: Keep the zoomed pane's size when the window resizes");
        expect(await page.locator("[data-slot=done-worker]").first().textContent()).toContain("The list redrew on every size event.");
        await page.waitForTimeout(400);
        await page.screenshot({ path: shot(`workers-overview-${viewport.phone ? "phone" : "1440"}.png`) });
        // On a phone a report opens full screen, in front of the sheet, as
        // before; closing it returns to the sheet as it was.
        if (viewport.phone) {
          await reports.locator("[data-slot=thread-canvas]").first().click();
          const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
          await canvas.waitFor();
          await page.waitForTimeout(300);
          const inFront = () => page.evaluate(() => {
            const at = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
            return { canvas: !!at?.closest('[role="dialog"][aria-label="Canvas"]'), sheet: !!at?.closest('[data-slot="worker-sheet"]') };
          });
          expect(await inFront()).toEqual({ canvas: true, sheet: false });
          await canvas.getByRole("button", { name: "Close canvas" }).click();
          await canvas.waitFor({ state: "detached" });
          await reports.waitFor();
          expect(await page.locator('[data-slot="worker-sheet"]').isVisible()).toBe(true);
        }
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  } finally {
    fixture.stop();
  }
}, 60_000);

// A card's first line on a phone: the worker's name and its state stay whole,
// and a long project name takes what they leave, cut short.
test("on a phone a card's long project name gives way to the worker's name and state", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setProjectName("Mandate development platform, release tooling and the documentation site");
  fixture.setFeature("zoom-worker", { name: "Fix the cache expiry leak in pane zoom" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}${THREAD}`);
    await page.getByRole("button", { name: "Workers", exact: true }).tap();
    const card = page.locator('[data-slot="worker-sheet"] [data-worker="Fix the cache expiry leak in pane zoom"]');
    await card.locator('[data-slot="worker-state"]').waitFor();
    await page.waitForTimeout(400);
    const line = await card.evaluate((el) => {
      const cut = (node: HTMLElement) => node.scrollWidth > node.clientWidth;
      const name = el.querySelector<HTMLElement>('[data-slot="worker-name"]')!;
      const project = el.querySelector<HTMLElement>('[data-slot="worker-project"]')!;
      const state = el.querySelector<HTMLElement>('[data-slot="worker-state-label"]')!;
      const row = name.parentElement!.getBoundingClientRect();
      return {
        nameCut: cut(name), stateCut: cut(state), projectCut: cut(project),
        project: Math.round(project.getBoundingClientRect().width),
        inside: Math.round(row.right - el.querySelector<HTMLElement>('[data-slot="worker-state"]')!.getBoundingClientRect().right) >= 0,
        title: project.getAttribute("title")
      };
    });
    expect([line.nameCut, line.stateCut, line.inside]).toEqual([false, false, true]);
    // Some of the project shows, cut, and whole on hover.
    expect(line.project).toBeGreaterThan(20);
    expect([line.projectCut, line.title]).toEqual([true, "Mandate development platform, release tooling and the documentation site"]);
    await page.screenshot({ path: shot("workers-overview-phone-long-project.png") });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);
