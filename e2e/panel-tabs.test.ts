import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { settle } from "./helpers/settle";

// A thread's right panel is a row of tabs: Workers first, then the workers
// and the reports and canvases opened from the page. On a wide desktop row a
// canvas opens there, beside the chat, not over the window; the panel's Hide
// chat gives it the row. Layout and keys are the browser's, so this runs in
// one. Its pictures, for a look at 1440, 1280 and 960, are taken when
// MANDATE_E2E_CAPTURE_FRAMES=1.

const browser = browserForFile();
const THREAD = `/threads/${THREAD_ID}`;

test("a report from a worker's Canvases opens beside the chat, and its maximize gives it the row", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setWorker("other-worker", { ownerThreadId: THREAD_ID });
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
      await look(page, `thread-report-tab-${width}`);

      // Opened again from the same list: the same tab, not a second one.
      await panel.locator('[data-worker-tab="zoom-worker"]').click();
      await panel.locator('[data-slot="worker-tabs"]').getByText("Canvases", { exact: true }).first().click();
      await panel.getByRole("button", { name: "Open report: Workspace canvas", exact: true }).click();
      await panel.locator('[data-canvas-tab="zoom-canvas"][aria-selected="true"]').waitFor();
      expect(await panel.locator("[data-canvas-tab]").count()).toBe(1);

      if (width >= 1280) {
        // Maximized: the panel takes the row; the shortcut brings the chat back.
        const row = await panel.evaluate((el) => el.parentElement!.getBoundingClientRect().width);
        await panel.getByRole("button", { name: "Maximize panel", exact: true }).click();
        await page.waitForFunction(() => {
          const p = document.querySelector('[data-slot="worker-panel"]')!;
          return p.getBoundingClientRect().width >= p.parentElement!.getBoundingClientRect().width - 2;
        });
        expect(await panel.getByRole("button", { name: "Restore panel", exact: true }).count()).toBe(1);
        await look(page, `thread-report-tab-chat-hidden-${width}`);
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
  fixture.setWorker("other-worker", { ownerThreadId: THREAD_ID });
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
      localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({ state: { byThread: { [threadId]: {
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
    // The row has scrolled the open tab into sight.
    await page.waitForFunction(() => {
      const row = document.querySelector<HTMLElement>('[role="tablist"][aria-label="Worker tabs"]')!.getBoundingClientRect();
      const tab = document.querySelector<HTMLElement>('[data-canvas-tab="cnv_PlanDoc0003"]')!.getBoundingClientRect();
      return tab.left >= row.left - 0.5 && tab.right <= row.right + 0.5;
    });
    await settle(page);
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
    await look(page, "thread-many-tabs-960");
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
  fixture.setWorker("other-worker", { ownerThreadId: THREAD_ID });
  // A worker at work on a step of its goal; one done, with what it found.
  const at = new Date().toISOString();
  const step = (id: number, title: string, status: "done" | "in_progress" | "pending") => ({
    id, title, status, note: null, createdAt: at, startedAt: null, blockedAt: null, completedAt: status === "done" ? at : null, updatedAt: at
  });
  const plan = { conclusion: null, openQuestions: [] as string[], goalHistory: [], updatedAt: at };
  fixture.setPlan({ ...plan, workerId: "zoom-worker", goal: "Keep the zoomed pane's size when the window resizes", steps: [
    step(1, "Reproduce the lost zoom", "done"), step(2, "Keep the size across a resize", "in_progress"), step(3, "Report", "pending")
  ] });
  fixture.setPlan({ ...plan, workerId: "other-worker", goal: "Find why the pane list flickers", conclusion: "The list redrew on every size event. Coalesced now.", steps: [step(1, "Trace the redraws", "done")] });
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
        await look(page, `workers-overview-${viewport.phone ? "phone" : "1440"}`);
        // On a phone a report opens full screen, in front of the sheet, as
        // before; closing it returns to the sheet as it was.
        if (viewport.phone) {
          await reports.locator("[data-slot=thread-canvas]").first().click();
          const canvas = page.getByRole("dialog", { name: "Canvas", exact: true });
          await canvas.waitFor();
          await settle(page);
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
  fixture.setWorker("zoom-worker", { name: "Fix the cache expiry leak in pane zoom" });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}${THREAD}`);
    await page.getByRole("button", { name: "Workers", exact: true }).tap();
    const card = page.locator('[data-slot="worker-sheet"] [data-worker="Fix the cache expiry leak in pane zoom"]');
    await card.locator('[data-slot="worker-state"]').waitFor();
    await settle(page);
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
    await look(page, "workers-overview-phone-long-project");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 30_000);

// Reopen: a tab closed comes back from the row's button, where it stood.
// The button sits among the panel's tools while something closed can come
// back; its list is a menu over the panel. At 1440 the panel is about 600px
// (two panes side by side, 50/50); on a phone the sheet's row has it before Close.
// Pictures in both themes when MANDATE_E2E_CAPTURE_FRAMES=1.
test("a tab closed in a thread's panel comes back from Reopen where it stood, at 1440 and on a phone", async () => {
  const fixture = startWorkspaceFixture();
  fixture.setWorker("other-worker", { ownerThreadId: THREAD_ID });
  fixture.addCanvas("cnv_RelNotes001", "Release notes");
  const seed = (threadId: string) => {
    if (window.top !== window) return;
    // Seeded once: a reload in this test keeps what the page wrote since.
    if (localStorage.getItem("mandate.worker-panel.v3")) return;
    localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({ state: { byThread: { [threadId]: {
      open: true, tabs: ["zoom-worker", "other-worker", "canvas:cnv_RelNotes001"], active: "zoom-worker", workerTab: {}
    } } }, version: 0 }));
  };
  const tabIds = (panel: ReturnType<Page["locator"]>) => panel.locator('[role="tablist"][aria-label="Worker tabs"] > [role="tab"]').evaluateAll((tabs) =>
    tabs.map((tab) => tab.getAttribute("data-worker-tab") ?? tab.getAttribute("data-canvas-tab") ?? "first"));
  for (const scheme of ["light", "dark"] as const) {
    for (const phone of [false, true]) {
      const context = await browser.newContext(phone
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme }
        : { viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = trackPageErrors(page);
      try {
        await page.addInitScript(seed, THREAD_ID);
        await page.goto(`${fixture.baseUrl}${THREAD}`);
        if (phone) {
          await page.getByRole("button", { name: "Workers", exact: true }).tap();
          await page.locator('[data-slot="worker-sheet"]').waitFor();
        }
        const panel = page.locator(phone ? '[data-slot="worker-panel-sheet"]' : '[data-slot="worker-panel-side"]');
        await panel.locator('[data-worker-tab="other-worker"]').waitFor();
        const reopen = panel.getByRole("button", { name: "Reopen a closed tab", exact: true });
        expect(await reopen.count()).toBe(0);
        await panel.locator('[data-worker-tab="other-worker"] [aria-label="Close other-worker"]').click();
        await panel.locator('[data-worker-tab="other-worker"]').waitFor({ state: "detached" });
        // Before the panel's tool, its maximize, or the sheet's Close.
        await reopen.waitFor();
        const order = await panel.locator(":scope > div").first().locator("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label")).filter(Boolean));
        expect(order.slice(-2)).toEqual(phone ? ["Reopen a closed tab", "Close"] : ["Reopen a closed tab", "Maximize panel"]);
        const box = (await reopen.boundingBox())!;
        expect(box.x + box.width).toBeLessThanOrEqual((phone ? 390 : 1440) + 0.5);
        await reopen.click();
        const menu = page.locator('[data-slot="recently-closed-menu"]');
        await menu.waitFor();
        expect(await menu.locator('[data-slot="recently-closed-label"]').textContent()).toBe("Recently closed");
        expect(await menu.locator('[data-slot="recently-closed-name"]').allTextContents()).toEqual(["other-worker"]);
        expect(await menu.locator('[data-slot="recently-closed-age"]').allTextContents()).toEqual(["just now"]);
        // The menu stays on screen and inside the window.
        const shown = (await menu.boundingBox())!;
        expect(shown.x).toBeGreaterThanOrEqual(0);
        expect(shown.x + shown.width).toBeLessThanOrEqual((phone ? 390 : 1440) + 0.5);
        await look(page, `reopen-menu-${phone ? "phone" : "1440"}-${scheme}`, { animations: "disabled" });
        await menu.getByRole("menuitem").first().click();
        await panel.locator('[data-worker-tab="other-worker"][aria-selected="true"]').waitFor();
        // Back where it stood; the sheet's row has no canvas tab.
        expect(await tabIds(panel)).toEqual(phone ? ["first", "zoom-worker", "other-worker"] : ["first", "zoom-worker", "other-worker", "cnv_RelNotes001"]);
        await reopen.waitFor({ state: "detached" });
        // In memory only: a reload starts with nothing to reopen.
        await panel.locator('[data-worker-tab="other-worker"] [aria-label="Close other-worker"]').click();
        await reopen.waitFor();
        await page.reload();
        if (phone) {
          // The sheet is a step in the history: a reload may keep it open.
          const sheet = page.locator('[data-slot="worker-sheet"]');
          const workers = page.getByRole("button", { name: "Workers", exact: true });
          await sheet.or(workers).first().waitFor();
          if (await sheet.count() === 0) await workers.tap();
          await sheet.waitFor();
        }
        await panel.locator('[data-worker-tab="zoom-worker"]').waitFor();
        await settle(page);
        expect(await reopen.count()).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }
  fixture.stop();
}, 90_000);
