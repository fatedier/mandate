import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { seedProject, seedWorker } from "../tests/helpers/fixtures.js";
import { waitUntil } from "../tests/helpers/wait.js";

/**
 * The task board through the compiled server: the Tasks page on a
 * desktop, the Tasks tab in the agent's panel, and a phone.
 */

const browser = browserForFile();
let server: RunningServer;
const ids: Record<string, string> = {};

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

beforeAll(async () => {
  server = await startServer({
    configured: true,
    label: "task-board",
    seed(dataDir) {
      const configFile = path.join(dataDir, "config.json");
      const config = flatFromFile(JSON.parse(fs.readFileSync(configFile, "utf8"))) as Record<string, any>;
      config.agent = { ...config.agent, personalAgentName: "Juno" };
      fs.writeFileSync(configFile, JSON.stringify(fileFromFlat(config), null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const board = new TaskBoardService({ db: store.db, agentStore: agents, sse: { emit: () => {} } as never, threadDots: () => new Map() });
        const thread = agents.createManagerThread("Menu page data source");
        ids.thread = thread.id;
        const prices = board.create({ title: "Cake prices from one list for the menu page", description: "Use one list for prices.\n\n- The bakery's sheet\n- The mill's catalogue", dueDate: day(0), dueTime: "14:00" }, "owner");
        ids.prices = prices.id;
        board.setStatus(prices.id, "progress", "agent", "Started a thread for it.");
        board.link(prices.id, thread.id, { newThread: true });
        // The brief the agent sent for it, and the thread's reply.
        agents.appendMessage({
          threadId: thread.id, role: "user", source: "user",
          content: { type: "text", text: "Build the price table from one list.", relay: { by: "personal", spoken: false, handoffId: "hof_seed", name: "Juno", taskId: prices.id } }
        });
        agents.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The bakery's sheet covers 92% of the cakes.\nThe rest come from the mill's catalogue." } });
        // Overdue from another year, with a time: the longest due label a card shows.
        const sourdough = board.create({ title: "Sell sourdough by the half loaf", description: "By the half loaf, not the whole one.", dueDate: day(-400), dueTime: "09:30" }, "owner");
        ids.sourdough = sourdough.id;
        board.comment(sourdough.id, "Start with rye; spelt can wait a week.", "owner");
        const docs = board.create({ title: "Docs overhaul for the 3.21 release", dueDate: day(3) }, "owner");
        board.setStatus(docs.id, "review", "agent", "The guide is rewritten.");
        board.writeResult(docs.id, "**Rewrote** the install guide and the FAQ.");
        board.create({ title: "Try a smaller oven for the morning bake" }, "owner");
        // Labels: by hand, the agent's, and where the linked thread's worker ran.
        board.addLabel(prices.id, "pricing", "owner");
        board.addLabel(sourdough.id, "pricing", "owner");
        board.addLabel(docs.id, "3.21", "agent");
        const projectId = seedProject(new ProjectsStore(store.db), { name: "northwind-server", tmuxSessionName: "md-task-board-labels" });
        seedWorker(new WorkersStore(store.db), projectId, { name: "prices", tmuxWindowName: "prices", ownerThreadId: thread.id });
        const done = board.create({ title: "Rotate the staging certificates" }, "owner");
        board.setStatus(done.id, "done", "owner");
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => { server?.cleanup(); });

async function open(viewport: { width: number; height: number }, route: string): Promise<Page> {
  const phone = viewport.width < 768;
  const page = await browser.newPage({ viewport, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}${route}`);
  return page;
}

/** A picture in each theme, for a person to look at (MANDATE_E2E_CAPTURE_FRAMES=1). */
async function lookBoth(page: Page, name: string): Promise<void> {
  // Two frames after a theme is set: its colour transitions have begun, and
  // the picture is taken with them run to their end.
  const drawn = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.emulateMedia({ colorScheme: "light" });
  await drawn();
  await look(page, `${name}-light`, { animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await drawn();
  await look(page, `${name}-dark`, { animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
}

const card = (page: Page, title: string) => page.locator('[data-slot="task-card"]', { hasText: title }).first();
const column = (page: Page, status: string) => page.locator(`[data-slot="task-column"][data-status="${status}"]`);

test("the Tasks page: board, a card opens the detail, a comment, a drag to In review", async () => {
  const page = await open({ width: 1440, height: 900 }, "/tasks");
  try {
    await card(page, "Sell sourdough by the half loaf").waitFor({ timeout: 15_000 });
    // Backlog, folded until opened, is a heading above the four columns.
    expect(await page.locator('[data-slot="task-column"]').evaluateAll((cols) => cols.map((c) => c.getAttribute("data-status")))).toEqual(["backlog", "todo", "progress", "review", "done"]);
    // The card: the latest comment, its overdue date in red; the linked thread on another.
    expect(await card(page, "Sell sourdough by the half loaf").locator('[data-slot="task-note"]').textContent()).toBe("You · Start with rye; spelt can wait a week.");
    expect(await card(page, "Cake prices from one list").locator('[data-slot="task-thread"]').textContent()).toBe("Menu page data source");
    expect(await card(page, "Docs overhaul").locator('[data-slot="task-note"]').textContent()).toBe("Result · Rewrote the install guide and the FAQ.");
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "board-1440");

    // The detail beside the board, its thread's reply, its stream.
    await card(page, "Cake prices from one list").click();
    await page.waitForURL(new RegExp(`/tasks/${ids.prices}$`));
    const detail = page.locator('[data-slot="task-detail"]');
    await detail.locator('[data-slot="task-stream"]').waitFor({ timeout: 10_000 });
    expect(await detail.locator('[data-slot="task-thread-row"]').textContent()).toContain("The bakery's sheet covers 92% of the cakes.");
    expect(await detail.locator('[data-slot="task-line"]').first().textContent()).toContain("Juno linked Menu page data source (a new thread)");
    // A comment, sent with Enter: a new line with Shift+Enter first.
    const box = detail.locator('[data-slot="task-comments"] textarea');
    await box.click();
    await box.type("Looks right.");
    await box.press("Shift+Enter");
    await box.type("Ship it next.");
    await box.press("Enter");
    await detail.locator('[data-slot="task-comment"]', { hasText: "Ship it next." }).waitFor({ timeout: 10_000 });
    // Newest first: the comment just sent is the stream's first.
    expect(await detail.locator('[data-slot="task-comment"]').first().textContent()).toContain("Looks right.");
    // Rename from the menu: the field keeps the cursor.
    await detail.getByRole("button", { name: "Task actions" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const field = detail.locator('[data-slot="task-title-input"]');
    await field.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-slot") === "task-title-input");
    await field.fill("Cake prices from one list");
    await field.press("Enter");
    await detail.locator('[data-slot="task-title"]', { hasText: /^Cake prices from one list$/ }).waitFor({ timeout: 10_000 });
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "detail-1440");
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/tasks$/);

    // A card dragged to In review moves there.
    await card(page, "Try a smaller oven").dragTo(column(page, "review"));
    await column(page, "review").locator('[data-slot="task-card"]', { hasText: "Try a smaller oven" }).waitFor({ timeout: 10_000 });
  } finally {
    await page.close();
  }
}, 90_000);

test("on a wide window a task takes half the page; a click on the board's empty space closes it, a drag of that space does not", async () => {
  const page = await open({ width: 2000, height: 1000 }, "/tasks");
  try {
    await card(page, "Cake prices from one list").click();
    const detail = page.locator('[data-slot="task-detail"]');
    await detail.waitFor({ timeout: 15_000 });
    // Half the row it sits in, as laid out: wider than the 680 it starts at
    // on a narrower window, and never past 960.
    const [width, row] = await detail.evaluate((el) => [el.getBoundingClientRect().width, el.parentElement!.getBoundingClientRect().width]);
    expect(Math.abs(width! - Math.min(Math.max(Math.round(row! / 2), 680), 960))).toBeLessThanOrEqual(1);
    expect(width!).toBeGreaterThan(700);
    // A point of the board that is no card and no control, left of the task.
    const point = await page.evaluate(() => {
      const home = document.querySelector('[data-slot="task-board-home"]')!;
      const left = document.querySelector('[data-slot="task-detail"]')!.getBoundingClientRect().left;
      const y = window.innerHeight - 120;
      for (let x = 40; x < left - 40; x += 40) {
        const at = document.elementFromPoint(x, y);
        if (at && home.contains(at) && !at.closest('a, button, input, [role="button"], [data-slot="task-detail"]')) return { x, y };
      }
      return null;
    });
    expect(point === null).toBe(false);
    // A drag of the board's ground from there ends in a click of its own: the task stays open.
    await page.mouse.move(point!.x, point!.y);
    await page.mouse.down();
    await page.mouse.move(point!.x + 60, point!.y - 30, { steps: 5 });
    await page.mouse.up();
    // Whatever the click would have done has been done by now.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect([await detail.count(), new URL(page.url()).pathname]).toEqual([1, `/tasks/${ids.prices}`]);
    await page.mouse.click(point!.x, point!.y);
    await detail.waitFor({ state: "detached" });
    expect(new URL(page.url()).pathname).toBe("/tasks");
    // Another card still opens its task while one is open.
    await card(page, "Cake prices from one list").click();
    await detail.waitFor();
    await card(page, "Sell sourdough by the half loaf").click();
    await page.waitForURL(new RegExp(`/tasks/${ids.sourdough}$`));
    await page.locator(`[data-slot="task-detail"][data-task-id="${ids.sourdough}"]`).waitFor();
  } finally {
    await page.close();
  }
}, 60_000);

test("the agent's page: + Tasks, each task in a tab of its own, a thread tab from one", async () => {
  const page = await open({ width: 1440, height: 900 }, "/agent");
  try {
    await page.getByRole("button", { name: "Open a thread beside Juno" }).waitFor({ timeout: 15_000 });
    // Beside the open panel the header holds its buttons and the agent's name whole.
    const name = page.getByRole("heading", { level: 1 }).locator("span").first();
    expect([await name.textContent(), await name.evaluate((el) => el.scrollWidth <= el.clientWidth)]).toEqual(["Juno", true]);
    expect(await page.locator('[data-slot="panel-toggle"]').getAttribute("aria-label")).toBe("Hide panel");
    await page.getByRole("button", { name: "Open a thread beside Juno" }).click();
    await page.getByRole("menuitem", { name: /^Tasks/ }).click();
    const panel = page.locator('[data-slot="tasks-panel"]');
    await panel.locator('[data-slot="task-card"]').first().waitFor({ timeout: 10_000 });
    // The panel's half of the row: the board scrolls inside it, the page does not.
    const width = await panel.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(500);
    expect(width).toBeLessThan(800);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "panel-board");
    // A task opens in a tab of its own, named by it: the task alone, no board.
    await panel.locator('[data-slot="task-card"]', { hasText: "Cake prices from one list" }).click();
    const tabs = () => page.locator('[data-task-tab][role="tab"]').evaluateAll((all) => all.map((tab) => `${tab.textContent?.trim()}|${tab.getAttribute("aria-selected")}`));
    const detail = page.locator('[data-slot="task-tab"] [data-slot="task-detail"]');
    await detail.locator('[data-slot="task-stream"]').waitFor({ timeout: 10_000 });
    expect(await tabs()).toEqual(["Cake prices from one list|true"]);
    expect(await panel.isVisible()).toBe(false);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "panel-detail");
    // Its thread opens as a tab of the same panel.
    await detail.locator('[data-slot="task-thread-row"]').click();
    await page.locator('[data-slot="thread-tab-view"] [data-slot="thread-tab-title"]', { hasText: "Menu page data source" }).waitFor({ timeout: 10_000 });
    // The Tasks tab is still the board; another task from it is a second tab beside the first.
    await page.locator('[data-tasks-tab][role="tab"]').click();
    await panel.locator('[data-slot="task-column"]').first().waitFor();
    await panel.locator('[data-slot="task-card"]', { hasText: "Sell sourdough by the half loaf" }).click();
    await page.locator(`[data-slot="task-tab"] [data-slot="task-detail"][data-task-id="${ids.sourdough}"]`).waitFor({ timeout: 10_000 });
    expect(await tabs()).toEqual(["Cake prices from one list|false", "Sell sourdough by the half loaf|true"]);
    // The row by kind: the tasks' tabs right after Tasks, before the thread's.
    expect(await page.locator('[role="tablist"][aria-label="Page tabs"] [role="tab"]').evaluateAll((all) => all.map((tab) =>
      (tab.hasAttribute("data-tasks-tab") ? "tasks" : tab.hasAttribute("data-task-tab") ? "task" : tab.hasAttribute("data-thread-tab") ? "thread" : "page")))).toEqual(["page", "tasks", "task", "task", "thread"]);
    await lookBoth(page, "panel-task-tabs");
    // Back to the first by its tab: both stay open.
    await page.locator(`[data-task-tab="${ids.prices}"][role="tab"]`).click();
    await page.locator(`[data-slot="task-tab"] [data-slot="task-detail"][data-task-id="${ids.prices}"]`).waitFor();
    expect(await pageOverflow(page)).toEqual([]);
  } finally {
    await page.close();
  }
}, 90_000);

test("a thread linked to a task: its tag in the header, the task under the brief", async () => {
  const page = await open({ width: 1440, height: 900 }, `/threads/${ids.thread}`);
  try {
    const tag = page.locator('[data-slot="thread-task-tags"] [data-slot="task-chip"]');
    await tag.waitFor({ timeout: 15_000 });
    expect(await tag.getAttribute("title")).toBe("Open the task");
    const brief = page.locator('[data-slot="task-chip"][title="Sent with the task\'s description"]');
    await brief.waitFor({ timeout: 10_000 });
    // Renamed by the first test: the chip follows the task.
    expect(await brief.locator('[data-slot="task-chip-title"]').textContent()).toBe("Cake prices from one list");
    await lookBoth(page, "thread-tags");
    // The tag opens the task in the agent's panel.
    await tag.click();
    await page.waitForURL(/\/agent$/, { timeout: 10_000 });
    await page.locator(`[data-slot="task-tab"] [data-slot="task-detail"][data-task-id="${ids.prices}"]`).waitFor({ timeout: 10_000 });
  } finally {
    await page.close();
  }
}, 60_000);

test("phone: list, a full-screen task, the status sheet", async () => {
  const page = await open({ width: 390, height: 844 }, "/tasks");
  try {
    await page.locator('[data-slot="task-row"]').first().waitFor({ timeout: 15_000 });
    expect(await page.locator('nav[aria-label="Tasks view"] button').allTextContents()).toEqual(["List", "Due"]);
    expect(await page.locator('[data-slot="task-column"]').count()).toBe(0);
    expect(await pageOverflow(page)).toEqual([]);
    // A long due label ("Overdue · Oct 7, 2025 · 09:30") leaves its task's
    // title readable: past its room it goes under the title, whole.
    const rowTitle = page.locator('[data-slot="task-row"]', { hasText: "Sell sourdough" }).locator("span.truncate").first();
    expect((await rowTitle.boundingBox())!.width).toBeGreaterThan(150);
    const rowDue = page.locator('[data-slot="task-row"]', { hasText: "Sell sourdough" }).locator('[data-slot="task-due"]');
    expect((await rowDue.boundingBox())!.height).toBeLessThan(24);
    await lookBoth(page, "phone-list");
    // Each status folds from its heading, a touch target of its own; Done
    // starts folded.
    const done = page.locator('[data-slot="task-group"][data-group="done"]');
    const toggle = done.locator('[data-slot="task-group-toggle"]');
    expect(await done.locator('[data-slot="task-row"]').count()).toBe(0);
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.tap();
    await done.locator('[data-slot="task-row"]').first().waitFor();
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "phone-list-done-open");
    await toggle.tap();
    await done.locator('[data-slot="task-row"]').first().waitFor({ state: "detached" });
    await page.locator('[data-slot="task-row"]', { hasText: "Sell sourdough" }).tap();
    await page.waitForURL(new RegExp(`/tasks/${ids.sourdough}$`));
    const detail = page.locator('[data-slot="task-detail"]');
    await detail.locator('[data-slot="task-stream"]').waitFor({ timeout: 10_000 });
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "phone-detail");
    await detail.locator('[data-slot="task-status"]').tap();
    const sheet = page.locator('[data-slot="task-status-sheet"]');
    await sheet.waitFor({ timeout: 10_000 });
    // Slid in: its top in the screen's lower part and still for a moment.
    let last = Number.NaN;
    await waitUntil(async () => {
      const top = await sheet.evaluate((el) => el.getBoundingClientRect().top);
      const still = Math.abs(top - last) < 1 && top < 844 - 200;
      last = top;
      return still || null;
    }, { timeout: 5_000, label: "the sheet at rest" });
    await lookBoth(page, "phone-status-sheet");
    await sheet.getByRole("button", { name: "In progress" }).tap();
    await waitUntil(async () => ((await detail.locator('[data-slot="task-status"]').textContent()) === "In progress") || null, { timeout: 10_000, label: "the new status" });
    // Back returns to the list.
    await detail.getByRole("button", { name: "Tasks" }).tap();
    await page.waitForURL(/\/tasks$/);
    await page.locator('[data-slot="task-row"]').first().waitFor();
  } finally {
    await page.close();
  }
}, 90_000);

// A phone's panel takes the Tasks tab as a desktop's does: List and Due in
// it. A task chosen there is the whole screen, as every task is on a phone,
// and Back from it finds the tab as it was.
test("phone: + in the agent's panel opens the Tasks tab; a task from it opens full screen and Back returns to the tab", async () => {
  const page = await open({ width: 390, height: 844 }, "/agent");
  try {
    const view = page.getByRole("tablist", { name: "View" });
    await view.waitFor({ timeout: 15_000 });
    expect(await view.getByRole("tab").allTextContents()).toEqual(["Chat", "Panel"]);
    await view.getByRole("tab", { name: "Panel" }).tap();
    await page.getByRole("button", { name: "Open a thread beside Juno" }).tap();
    const items = page.getByRole("menuitem");
    await items.first().waitFor();
    expect((await items.first().textContent())?.trim()).toMatch(/^Tasks/);
    await lookBoth(page, "phone-panel-plus");
    await items.first().tap();
    const panel = page.locator('[data-slot="tasks-panel"]');
    await panel.locator('[data-slot="task-row"]').first().waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-tasks-tab][role="tab"]').getAttribute("aria-selected")).toBe("true");
    expect(await panel.locator('nav[aria-label="Tasks view"] button').allTextContents()).toEqual(["List", "Due"]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "phone-panel-tasks");
    await panel.locator('[data-slot="task-row"]', { hasText: "Docs overhaul" }).tap();
    await page.waitForURL(/\/tasks\/tsk_[^/]+$/);
    const detail = page.locator('[data-slot="task-detail"]');
    await detail.locator('[data-slot="task-stream"]').waitFor({ timeout: 10_000 });
    await detail.getByRole("button", { name: "Tasks" }).tap();
    await page.waitForURL(/\/agent$/);
    await panel.locator('[data-slot="task-row"]').first().waitFor({ timeout: 10_000 });
    // The Tasks tab as it was left, and no tab made for the task.
    expect(await page.locator('[role="tablist"][aria-label="Page tabs"] [role="tab"]').evaluateAll((all) => all
      .filter((tab) => tab.hasAttribute("data-tasks-tab") || tab.hasAttribute("data-task-tab"))
      .map((tab) => `${tab.hasAttribute("data-tasks-tab") ? "tasks" : "task"}|${tab.getAttribute("aria-selected")}`))).toEqual(["tasks|true"]);
    expect(await view.getByRole("tab", { name: "Panel" }).getAttribute("aria-selected")).toBe("true");
    // One Back from the panel is the chat, as before the task was read.
    await page.goBack();
    await page.locator('[role="tablist"][aria-label="View"] [role="tab"][aria-selected="true"]', { hasText: "Chat" }).waitFor({ timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe("/agent");
  } finally {
    await page.close();
  }
}, 90_000);

// Phone mode is every screen under 768 px. One with room for three columns
// (a foldable opened, a small tablet) is offered the Board; narrowed to a
// phone's width (the foldable closed) it shows List, and the Board again
// once it has the room back.
test("a small screen with room: the Board among the views, a task full screen, List while it is a phone's width", async () => {
  const page = await open({ width: 700, height: 900 }, "/tasks");
  try {
    await page.locator('[data-slot="task-column"]').first().waitFor({ timeout: 15_000 });
    const views = () => page.locator('nav[aria-label="Tasks view"] button').allTextContents();
    expect(await views()).toEqual(["Board", "List", "Due"]);
    // Three columns whole in the page, the rest a step away; the page itself does not scroll.
    const whole = await page.locator('[data-slot="task-column"]').evaluateAll((all) => all.filter((column) => {
      const box = column.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth;
    }).length);
    expect(whole).toBeGreaterThanOrEqual(3);
    // The board starts at the page's gutter, under the views.
    const left = (selector: string) => page.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().left));
    expect([await left('[data-slot="task-column"]'), await left('nav[aria-label="Tasks view"]')]).toEqual([16, 16]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "small-screen-board");
    await card(page, "Sell sourdough").tap();
    await page.waitForURL(new RegExp(`/tasks/${ids.sourdough}$`));
    const detail = page.locator('[data-slot="task-detail"]');
    await detail.locator('[data-slot="task-stream"]').waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-slot="task-column"]').count()).toBe(0);
    await lookBoth(page, "small-screen-detail");
    await detail.getByRole("button", { name: "Tasks" }).tap();
    await page.waitForURL(/\/tasks$/);
    await page.locator('[data-slot="task-column"]').first().waitFor();
    // The foldable closed: no room, so the list; opened again, the board kept.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-slot="task-row"]').first().waitFor({ timeout: 10_000 });
    expect([await views(), await page.locator('[data-slot="task-column"]').count()]).toEqual([["List", "Due"], 0]);
    expect(await pageOverflow(page)).toEqual([]);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.locator('[data-slot="task-column"]').first().waitFor({ timeout: 10_000 });
    expect(await views()).toEqual(["Board", "List", "Due"]);
    // The Tasks tab of the agent's panel is the same board there.
    await page.goto(`${server.baseUrl}/agent`);
    await page.getByRole("tablist", { name: "View" }).getByRole("tab", { name: "Panel" }).tap();
    await page.getByRole("button", { name: "Open a thread beside Juno" }).tap();
    await page.getByRole("menuitem", { name: /^Tasks/ }).tap();
    const panel = page.locator('[data-slot="tasks-panel"]');
    await panel.locator('[data-slot="task-column"]').first().waitFor({ timeout: 10_000 });
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "small-screen-panel-board");
  } finally {
    await page.close();
  }
}, 90_000);

// Labels and the filter bar: a card's labels (where its thread's worker ran,
// automatic, first), one added from the detail, a Label filter; on a phone
// the Filter sheet. Pictures in both themes.
test("labels and filters on a desktop and a phone", async () => {
  const desk = await open({ width: 1440, height: 900 }, "/tasks");
  try {
    // Renamed by the first test.
    const prices = card(desk, "Cake prices from one list");
    await prices.waitFor({ timeout: 15_000 });
    const labelsOf = (loc: ReturnType<Page["locator"]>) => loc.locator('[data-slot="task-label"]').evaluateAll((els) => els.map((e) => `${e.textContent?.trim()}:${e.getAttribute("data-by")}`));
    expect(await labelsOf(prices)).toEqual(["northwind-server:auto", "pricing:owner"]);
    // A label added from the detail.
    await card(desk, "Sell sourdough by the half loaf").click();
    const field = desk.locator('[data-slot="task-labels-field"]');
    await field.waitFor();
    await field.locator('input[aria-label="Add a label"]').fill("ops");
    await field.locator('input[aria-label="Add a label"]').press("Enter");
    await field.locator('[data-slot="task-label"]', { hasText: "ops" }).waitFor();
    await desk.keyboard.press("Escape");
    await waitUntil(async () => (await labelsOf(card(desk, "Sell sourdough by the half loaf"))).join() === "pricing:owner,ops:owner" || null, { timeout: 10_000, label: "the new label on the card" });
    // The Label filter: it stays open while ticking.
    await desk.locator('[data-slot="task-filter-label"]').click();
    await desk.getByRole("menuitemcheckbox", { name: "pricing" }).click();
    await waitUntil(async () => (await desk.locator('[data-slot="task-card"]').count()) === 2 || null, { timeout: 5_000, label: "two cards left" });
    expect(await desk.locator('[data-slot="task-filter-label"]').textContent()).toBe("Label · 1");
    const selectAll = desk.getByRole("menuitemcheckbox", { name: "Select all" });
    expect(await selectAll.getAttribute("aria-checked")).toBe("mixed");
    expect(await pageOverflow(desk)).toEqual([]);
    await lookBoth(desk, "labels-filter-desktop");
    // Select all ticks every label and No label: every card is back.
    await selectAll.click();
    await waitUntil(async () => (await desk.locator('[data-slot="task-card"]').count()) === 5 || null, { timeout: 5_000, label: "every card with all ticked" });
    expect(await desk.getByRole("menuitemcheckbox").evaluateAll((items) => items.map((i) => i.getAttribute("aria-checked")))).not.toContain("false");
    await lookBoth(desk, "labels-filter-select-all");
    await desk.keyboard.press("Escape");
    await desk.getByRole("button", { name: "Clear filters" }).click();
    await waitUntil(async () => (await desk.locator('[data-slot="task-card"]').count()) === 5 || null, { timeout: 5_000, label: "all cards back" });
  } finally {
    await desk.close();
  }
  const phone = await open({ width: 390, height: 844 }, "/tasks");
  try {
    await phone.locator('[data-slot="task-row"]').first().waitFor({ timeout: 15_000 });
    const filter = phone.locator('[data-slot="task-filter-phone"]');
    expect(await filter.textContent()).toBe("Filter");
    await filter.tap();
    const sheet = phone.locator('[data-slot="task-filter-sheet"]');
    expect(await sheet.getByRole("menuitemcheckbox").first().textContent()).toBe("Select all");
    await sheet.getByRole("menuitemcheckbox", { name: "3.21" }).tap();
    await waitUntil(async () => (await filter.textContent()) === "Filter · 1" || null, { timeout: 5_000, label: "the count on Filter" });
    await lookBoth(phone, "labels-filter-phone-sheet");
    await phone.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await waitUntil(async () => (await phone.locator('[data-slot="task-row"]').count()) === 1 || null, { timeout: 5_000, label: "one row left" });
    expect(await pageOverflow(phone)).toEqual([]);
    await lookBoth(phone, "labels-filter-phone");
  } finally {
    await phone.close();
  }
}, 90_000);

// Last: it adds a task to each status, folds columns and moves tasks about.
test("a pane too narrow for the board keeps it in one row: a step button and a drag of its ground move it, a column folds away to a heading above it and a reload keeps that, a status with no task folds away of itself", async () => {
  const page = await open({ width: 1440, height: 900 }, "/agent");
  try {
    const openTasks = async () => {
      await page.getByRole("button", { name: "Open a thread beside Juno" }).waitFor({ timeout: 15_000 });
      if (await page.locator('[data-slot="tasks-panel"]').count() === 0) {
        await page.getByRole("button", { name: "Open a thread beside Juno" }).click();
        await page.getByRole("menuitem", { name: /^Tasks/ }).click();
      }
      await page.locator('[data-slot="tasks-panel"] [data-slot="task-card"]').first().waitFor({ timeout: 10_000 });
    };
    await openTasks();
    const panel = page.locator('[data-slot="tasks-panel"]');
    const board = panel.locator('[data-slot="task-board"]');
    // The board as the user's own requests change it.
    const api = (method: string, url: string, body?: unknown) => page.evaluate(async (request) => {
      const res = await fetch(request.url, { method: request.method, headers: { "content-type": "application/json" }, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
      return { status: res.status, body: await res.json().catch(() => null) as { task?: { id: string }; tasks?: Array<{ id: string; status: string }> } | null };
    }, { method, url, body });
    // Whatever the tests before left: a task in every status.
    for (const status of ["todo", "progress", "review", "done"]) {
      const made = await api("POST", "/api/task-board/tasks", { title: `Narrow pane: ${status}` });
      expect(made.status).toBe(201);
      if (status !== "todo") expect((await api("PATCH", `/api/task-board/tasks/${made.body!.task!.id}`, { status })).status).toBe(200);
    }
    await panel.locator('[data-slot="task-card"]', { hasText: "Narrow pane: done" }).waitFor({ timeout: 10_000 });
    const stepButton = (side: "left" | "right") => panel.locator(`[data-slot="task-board-step"][data-side="${side}"]`);
    /** Each column's status, width and whether it lies whole inside the board's margins; and what the board says is cut. */
    const seen = () => board.evaluate((el) => {
      const pane = el.getBoundingClientRect();
      const columns = Array.from(el.querySelectorAll<HTMLElement>('[data-slot="task-column"]')).map((column) => {
        const box = column.getBoundingClientRect();
        return { status: column.dataset.status, width: Math.round(box.width), top: Math.round(box.top), whole: box.left >= pane.left + 23 && box.right <= pane.right - 23 };
      });
      return { more: el.getAttribute("data-more"), scrollLeft: Math.round(el.scrollLeft), columns };
    });
    /** Resolves once the board says this much is cut off: a step's scroll has come to its end. */
    const cutIs = (more: string) => board.locator(`xpath=self::*[@data-more="${more}"]`).waitFor({ timeout: 5_000 });
    // One row, each column at its narrowest, the last one off to the right.
    const start = await seen();
    const narrowest = 170;
    expect(start.columns.map((c) => [c.status, c.width])).toEqual([["todo", narrowest], ["progress", narrowest], ["review", narrowest], ["done", narrowest]]);
    expect(new Set(start.columns.map((c) => c.top)).size).toBe(1);
    expect([start.more, start.scrollLeft, start.columns.map((c) => c.whole)]).toEqual(["right", 0, [true, true, true, false]]);
    expect([await stepButton("right").count(), await stepButton("left").count()]).toEqual([1, 0]);
    expect(await pageOverflow(page)).toEqual([]);
    // Each due label inside its card's padding, the longest broken between its parts.
    const spills = await board.evaluate((el) => Array.from(el.querySelectorAll<HTMLElement>('[data-slot="task-card"]')).flatMap((card) => {
      const due = card.querySelector('[data-slot="task-due"]');
      if (!due) return [];
      const [c, d] = [card.getBoundingClientRect(), due.getBoundingClientRect()];
      return d.right > c.right - 10 + 0.5 ? [`${due.textContent}: ${Math.round(d.right - (c.right - 10))}px`] : [];
    }));
    expect(spills).toEqual([]);
    await lookBoth(page, "panel-board-cut");

    // A step brings the column cut off there into view whole, at the board's end; a step back, to its start.
    const fits = await board.evaluate((el) => el.clientWidth);
    await stepButton("right").click();
    await cutIs("left");
    const end = await seen();
    expect([end.scrollLeft, end.columns.map((c) => c.whole)]).toEqual([24 + 4 * narrowest + 3 * 12 + 24 - fits, [false, true, true, true]]);
    expect([await stepButton("right").count(), await stepButton("left").count()]).toEqual([0, 1]);
    await stepButton("left").click();
    await cutIs("right");
    expect([(await seen()).scrollLeft, await stepButton("left").count()]).toEqual([0, 0]);

    // The board's own ground drags it: a press under the columns, moved to the left.
    const box = (await board.boundingBox())!;
    const ground = { x: box.x + 300, y: box.y + box.height - 12 };
    expect(await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement | null)?.dataset.slot, ground)).toBe("task-board");
    await page.mouse.move(ground.x, ground.y);
    await page.mouse.down();
    await page.mouse.move(ground.x - 120, ground.y, { steps: 6 });
    await page.mouse.up();
    expect((await seen()).scrollLeft).toBe(120);
    await board.evaluate((el) => { el.scrollLeft = 0; });

    // A column folds away from its heading: its heading joins the line above the board. With two folded, the rest fit and nothing is cut.
    const column = (status: string) => panel.locator(`[data-slot="task-column"][data-status="${status}"]`);
    const fold = (status: string) => column(status).locator('[data-slot="task-column-fold"]');
    const shelf = panel.locator('[data-slot="task-board-folded"]');
    const shelved = () => shelf.locator('[data-slot="task-column"]').evaluateAll((all) => all.map((el) => `${el.getAttribute("data-status")}:${el.getAttribute("data-folded")}`));
    const inRow = async () => (await seen()).columns.map((c) => c.status);
    // Backlog starts there, folded until opened.
    expect([await shelved(), await fold("done").getAttribute("aria-expanded")]).toEqual([["backlog:true"], "true"]);
    await fold("done").click();
    await fold("todo").click();
    const folded = await seen();
    expect(await shelved()).toEqual(["backlog:true", "todo:true", "done:true"]);
    expect(folded.columns.map((c) => [c.status, c.width > narrowest, c.whole])).toEqual([["progress", true, true], ["review", true, true]]);
    expect([folded.more, await panel.locator('[data-slot="task-board-step"]').count()]).toEqual(["none", 0]);
    // A folded heading says the status and how many it holds, and shows none of them.
    expect([await fold("done").getAttribute("aria-expanded"), await column("done").locator('[data-slot="task-card"]').count()]).toEqual(["false", 0]);
    expect((await fold("done").innerText()).replace(/\s+/g, " ").trim()).toMatch(/^Done \d+$/);
    // The line sits above the columns.
    const [shelfBox, boardBox] = [(await shelf.boundingBox())!, (await board.boundingBox())!];
    expect(shelfBox.y + shelfBox.height).toBeLessThanOrEqual(boardBox.y + 1);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "panel-board-folded");

    // Kept in this browser: a reload draws them folded; a press on a folded heading opens its column again.
    await page.reload();
    await openTasks();
    expect(await shelved()).toEqual(["backlog:true", "todo:true", "done:true"]);
    await fold("done").click();
    await fold("todo").click();
    expect([await shelved(), await inRow()]).toEqual([["backlog:true"], ["todo", "progress", "review", "done"]]);

    // A status left with no task, in a pane short of room, folds away of itself; opened by hand it stays, empty as it is.
    const inReview = (await api("GET", "/api/task-board/tasks")).body!.tasks!.filter((task) => task.status === "review").map((task) => task.id);
    for (const id of inReview) expect((await api("PATCH", `/api/task-board/tasks/${id}`, { status: "done" })).status).toBe(200);
    await shelf.locator('[data-slot="task-column"][data-status="review"]').waitFor({ timeout: 10_000 });
    expect([await shelved(), await inRow()]).toEqual([["backlog:true", "review:empty"], ["todo", "progress", "done"]]);
    // The three with tasks now fit: nothing is cut, and no button to step.
    expect([(await seen()).more, await panel.locator('[data-slot="task-board-step"]').count()]).toEqual(["none", 0]);
    await lookBoth(page, "panel-board-empty-status");
    await fold("review").click();
    expect([await shelved(), await inRow(), await column("review").locator('[data-slot="task-card"]').count()]).toEqual([["backlog:true"], ["todo", "progress", "review", "done"], 0]);
    // Its tasks back where they were.
    for (const id of inReview) expect((await api("PATCH", `/api/task-board/tasks/${id}`, { status: "review" })).status).toBe(200);
    await column("review").locator('[data-slot="task-card"]').first().waitFor({ timeout: 10_000 });
  } finally {
    await page.close();
  }
}, 90_000);

// A small screen's board with more columns than fit: one row at the page's
// gutter, the rest a tap on the step button away.
test("a small screen's board with a column cut off: a tap on the step button brings it in, another goes back", async () => {
  const page = await open({ width: 600, height: 900 }, "/tasks");
  try {
    const board = page.locator('[data-slot="task-board"]');
    await board.locator('[data-slot="task-column"]').first().waitFor({ timeout: 15_000 });
    // A task in every status, whatever the tests before left.
    for (const status of ["todo", "progress", "review", "done"]) {
      const made = await page.evaluate(async (title) => {
        const res = await fetch("/api/task-board/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
        return { status: res.status, id: ((await res.json()) as { task: { id: string } }).task.id };
      }, `Small screen: ${status}`);
      expect(made.status).toBe(201);
      if (status !== "todo") {
        expect(await page.evaluate(async (request) => (await fetch(`/api/task-board/tasks/${request.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: request.status }) })).status, { id: made.id, status })).toBe(200);
      }
    }
    await card(page, "Small screen: done").waitFor({ timeout: 10_000 });
    const stepButton = (side: "left" | "right") => page.locator(`[data-slot="task-board-step"][data-side="${side}"]`);
    /** Each column's status and where it lies in the page; how far the board is scrolled and what it says is cut. */
    const seen = () => board.evaluate((el) => ({
      more: el.getAttribute("data-more"),
      scrollLeft: Math.round(el.scrollLeft),
      columns: Array.from(el.querySelectorAll<HTMLElement>('[data-slot="task-column"]')).map((column) => {
        const box = column.getBoundingClientRect();
        return { status: column.dataset.status, left: Math.round(box.left), right: Math.round(box.right) };
      })
    }));
    const cutIs = (more: string) => board.locator(`xpath=self::*[@data-more="${more}"]`).waitFor({ timeout: 5_000 });
    // Four columns of 170 and three gaps of 12, from the gutter of 16: the last is cut off.
    await cutIs("right");
    const start = await seen();
    expect(start.scrollLeft).toBe(0);
    expect(start.columns).toEqual([
      { status: "todo", left: 16, right: 186 }, { status: "progress", left: 198, right: 368 },
      { status: "review", left: 380, right: 550 }, { status: "done", left: 562, right: 732 }
    ]);
    expect([await stepButton("right").count(), await stepButton("left").count()]).toEqual([1, 0]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "small-screen-board-cut");
    // The step: the board's end, its last column whole, a gutter from the edge.
    await stepButton("right").tap();
    await cutIs("left");
    const end = await seen();
    expect([end.scrollLeft, end.columns.at(-1)]).toEqual([16 + 4 * 170 + 3 * 12 + 16 - 600, { status: "done", left: 414, right: 584 }]);
    expect([await stepButton("right").count(), await stepButton("left").count()]).toEqual([0, 1]);
    await lookBoth(page, "small-screen-board-stepped");
    await stepButton("left").tap();
    await cutIs("right");
    expect((await seen()).scrollLeft).toBe(0);
  } finally {
    await page.close();
  }
}, 90_000);

// A long Done does not push the other columns away: each column is as tall
// as the board and scrolls on its own, its heading in sight, so a card from
// the end of Done drops on In review wherever that column's cards end.
test("each column scrolls on its own: a card dragged from the end of a long Done reaches In review", async () => {
  const page = await open({ width: 1440, height: 900 }, "/tasks");
  try {
    await page.locator('[data-slot="task-board"]').waitFor({ timeout: 15_000 });
    const made: string[] = [];
    for (let i = 1; i <= 14; i++) {
      const id = await page.evaluate(async (title) => {
        const res = await fetch("/api/task-board/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
        const task = ((await res.json()) as { task: { id: string } }).task;
        await fetch(`/api/task-board/tasks/${task.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "done" }) });
        return task.id;
      }, `Long Done ${String(i).padStart(2, "0")}`);
      made.push(id);
    }
    const done = page.locator('[data-slot="task-column"][data-status="done"]');
    await done.locator('[data-slot="task-card"]', { hasText: "Long Done 14" }).waitFor({ timeout: 10_000 });
    // The board itself does not scroll down; Done's cards do, inside it.
    const sizes = await page.evaluate(() => {
      const board = document.querySelector<HTMLElement>('[data-slot="task-board"]')!;
      const cards = document.querySelector<HTMLElement>('[data-slot="task-column"][data-status="done"] [data-slot="task-column-cards"]')!;
      return { board: board.scrollHeight - board.clientHeight, cards: cards.scrollHeight - cards.clientHeight };
    });
    expect([sizes.board <= 1, sizes.cards > 100]).toEqual([true, true]);
    // The last card, scrolled to; In review's heading still in sight above it.
    const last = done.locator('[data-slot="task-card"]').last();
    await last.scrollIntoViewIfNeeded();
    const review = page.locator('[data-slot="task-column"][data-status="review"]');
    const head = (await review.locator('[data-slot="task-column-fold"]').boundingBox())!;
    expect(head.y).toBeGreaterThanOrEqual(0);
    const title = (await last.locator("span").first().textContent())!;
    // Dropped low in In review, beside the card it came from: the column reaches that far.
    const [from, to] = [(await last.boundingBox())!, (await review.boundingBox())!];
    expect(to.y + to.height).toBeGreaterThan(from.y + from.height / 2);
    await last.dragTo(review, { targetPosition: { x: to.width / 2, y: from.y + from.height / 2 - to.y } });
    await review.locator('[data-slot="task-card"]', { hasText: title }).waitFor({ timeout: 10_000 });
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "board-long-done");
  } finally {
    await page.close();
  }
}, 90_000);

// A card's "⋯" holds the task's actions: shown on hover, its Status moves
// the card with no drag; a right-click opens the same menu. On a phone a
// row's "⋯" is there without a hover.
test("a card's ⋯ moves it from the Status submenu; a right-click opens the same menu; a phone's row shows its ⋯", async () => {
  const page = await open({ width: 1440, height: 900 }, "/tasks");
  try {
    const made = await page.evaluate(async () => {
      const res = await fetch("/api/task-board/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Menu: move me" }) });
      return ((await res.json()) as { task: { id: string } }).task.id;
    });
    const target = page.locator(`[data-slot="task-card"][data-task-id="${made}"]`);
    await target.waitFor({ timeout: 15_000 });
    const actions = target.locator('[data-slot="task-actions"]');
    // Hidden until the card is hovered.
    expect(await actions.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    await target.hover();
    await page.waitForFunction((id) => getComputedStyle(document.querySelector(`[data-slot="task-card"][data-task-id="${id}"] [data-slot="task-actions"]`)!).opacity === "1", made, { timeout: 5_000 });
    await actions.click();
    await page.getByRole("menuitem", { name: "Status" }).click();
    await lookBoth(page, "card-actions-status");
    await page.getByRole("menuitem", { name: "In review" }).click();
    await page.locator(`[data-slot="task-column"][data-status="review"] [data-slot="task-card"][data-task-id="${made}"]`).waitFor({ timeout: 10_000 });
    // Not opened: no task beside the board.
    expect(await page.locator('[data-slot="task-detail"]').count()).toBe(0);
    await target.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete task" }).waitFor({ timeout: 5_000 });
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual(["Status", "Due", "Rename", "Ask Juno", "Delete task"]);
    await page.keyboard.press("Escape");
  } finally {
    await page.close();
  }
  const phone = await open({ width: 390, height: 844 }, "/tasks");
  try {
    const row = phone.locator('[data-slot="task-row"]', { hasText: "Menu: move me" });
    await row.waitFor({ timeout: 15_000 });
    expect(await row.locator('[data-slot="task-actions"]').evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await lookBoth(phone, "phone-row-actions");
  } finally {
    await phone.close();
  }
}, 90_000);

// A deleted task is kept until the user deletes it forever: the board's
// search narrows Recently deleted, and Delete forever asks first. Last in the
// file: it leaves nothing deleted behind, but a failure part way could.
test("Recently deleted: the board's search narrows it, and Delete forever takes a task away for good", async () => {
  const api = (route: string, init?: RequestInit) => fetch(`${server.baseUrl}${route}`, init);
  const made: Record<string, string> = {};
  for (const [key, title, description] of [
    ["review", "Draft the quarterly cost review", "Compare the mill's invoices with the till."],
    ["idea", "Old idea: a second flour mill", ""]
  ] as const) {
    const created = await api("/api/task-board/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, description }) });
    made[key] = ((await created.json()) as { task: { id: string } }).task.id;
    expect((await api(`/api/task-board/tasks/${made[key]}`, { method: "DELETE" })).status).toBe(200);
  }
  const deletedIds = async () => ((await (await api("/api/task-board/tasks?deleted=1")).json()) as { tasks: Array<{ id: string }> }).tasks.map((t) => t.id).sort();
  expect(await deletedIds()).toEqual([made.review!, made.idea!].sort());

  for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 900 }, { width: 390, height: 844 }]) {
    const page = await open(viewport, "/tasks");
    const phone = viewport.width < 768;
    try {
      const footLink = page.getByRole("button", { name: /^Recently deleted \(\d+\)$/ });
      await footLink.waitFor({ timeout: 15_000 });
      await (phone ? footLink.tap() : footLink.click());
      const list = page.locator('[data-slot="tasks-deleted"]');
      const rows = list.locator('[data-slot="task-deleted-row"]');
      await rows.nth(1).waitFor();
      expect(await list.textContent()).not.toContain("30 days");
      expect(await pageOverflow(page)).toEqual([]);
      // Each row keeps its title readable beside its two buttons.
      const title = rows.first().locator("span.truncate");
      expect((await title.boundingBox())!.width).toBeGreaterThan(phone ? 90 : 200);
      await lookBoth(page, `deleted-${viewport.width}`);
      const search = page.getByRole("searchbox", { name: "Search tasks" });
      await search.fill("invoices");
      await waitUntil(async () => ((await rows.count()) === 1) || null, { timeout: 5_000, label: "the search's one row" });
      expect(await rows.first().textContent()).toContain("Draft the quarterly cost review");
      await lookBoth(page, `deleted-${viewport.width}-searched`);
      await search.fill("");
      await waitUntil(async () => ((await rows.count()) === 2) || null, { timeout: 5_000, label: "both rows again" });
    } finally {
      await page.close();
    }
  }

  // Delete forever asks; the answer takes the task away for good.
  const page = await open({ width: 1440, height: 900 }, "/tasks");
  try {
    await page.getByRole("button", { name: /^Recently deleted \(\d+\)$/ }).click();
    const row = page.locator('[data-slot="task-deleted-row"]', { hasText: "Old idea: a second flour mill" });
    await row.getByRole("button", { name: "Delete forever" }).click();
    const dialog = page.locator("[data-confirm-dialog]");
    await dialog.waitFor();
    expect(await dialog.getByRole("heading").textContent()).toBe("Delete “Old idea: a second flour mill” forever?");
    expect(await dialog.textContent()).toContain("This can't be undone.");
    await lookBoth(page, "deleted-forever-confirm");
    await dialog.getByRole("button", { name: "Delete forever" }).click();
    await row.waitFor({ state: "detached", timeout: 10_000 });
    expect(await deletedIds()).toEqual([made.review!]);
  } finally {
    await page.close();
  }
  expect((await api(`/api/task-board/tasks/${made.review}/forever`, { method: "DELETE" })).status).toBe(200);
  expect(await deletedIds()).toEqual([]);
}, 120_000);
