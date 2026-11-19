import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

/**
 * The Threads page and thread labels through the compiled server, in a
 * desktop pane of 600px and on a phone: the tabs, a row's labels and
 * projects as they fit, a filter, a label added in a thread's header and
 * seen on the page, rows selected to be labelled, deleted and archived
 * together, and the sidebar's row that leads here.
 */

const browser = browserForFile();
let server: RunningServer;
const ids = { slices: "", prices: "", vegan: "", frost: "", cache: "", upload: "", notes: "" };

beforeAll(async () => {
  server = await startServer({
    configured: true,
    label: "threads-page",
    seed(dataDir) {
      // The model is a closed local port: what an archive draws from a
      // thread fails at once, inside the container.
      const configFile = path.join(dataDir, "config.json");
      const config = (flatFromFile(JSON.parse(fs.readFileSync(configFile, "utf8"))) as Record<string, any>);
      config.models.providers.openai.baseURL = "http://127.0.0.1:9/v1";
      fs.writeFileSync(configFile, JSON.stringify(fileFromFlat(config), null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agent = new AgentStore(store.db);
        const projects = new ProjectsStore(store.db);
        const workers = new WorkersStore(store.db);
        const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
        const project = (name: string) => projects.insert({ name, workingDir: "/tmp", isGit: false, gitRemote: null, tmuxSessionName: `md-threads-${name}`, ownership: "app" });
        const [atlas, server_, docs] = [project("atlas-api"), project("search-server"), project("docs-site")];
        let made = 0;
        /** A thread with one exchange, last active `hours` ago; its workers
         *  ran in these projects (archived: the page reads where work ran). */
        const thread = (title: string, hours: number, labels: Array<[string, "owner" | "agent"]>, ranIn: string[]) => {
          const id = agent.createManagerThread(title).id;
          agent.appendMessage({ threadId: id, role: "user", source: "user", content: { type: "text", text: `About ${title}.` } });
          agent.appendMessage({ threadId: id, role: "assistant", source: "self", content: { type: "assistant", text: "Noted." } });
          store.db.prepare("update agent_messages set created_at = ? where thread_id = ?").run(hoursAgo(hours), id);
          labels.forEach(([name, by], index) => agent.putThreadLabel(id, name, by, new Date(Date.parse("2026-03-01T00:00:00.000Z") + index * 1000).toISOString()));
          for (const projectId of ranIn) {
            made += 1;
            const workerId = workers.insert({ projectId, name: `worker${made}`, mode: "shared-cwd", branch: null, worktreePath: null, tmuxWindowName: `w${made}`, ownership: "app", ownerThreadId: id });
            // Made a minute apart, as workers are: inserts in one millisecond tie.
            store.db.prepare("update workers set created_at = ? where id = ?").run(`2026-03-01T08:${String(made).padStart(2, "0")}:00.000Z`, workerId);
            workers.archive(workerId);
          }
          return id;
        };
        // In January of the running year: a date of another year is written with its year.
        const archive = (id: string, day: number) => {
          agent.archiveThread(id);
          store.db.prepare("update agent_threads set archived_at = ? where id = ?").run(`${new Date().getFullYear()}-01-${String(day).padStart(2, "0")}T09:00:00.000Z`, id);
        };
        ids.slices = thread("Sell rye by the slice", 2.5, [["batches", "owner"], ["3.21", "agent"], ["ops", "owner"], ["vegan", "owner"], ["customer escalation follow-up", "owner"]], [atlas, server_, docs]);
        ids.prices = thread("Bread prices from one sheet for every shop in a chain", 5.5, [["batches", "owner"]], [atlas]);
        ids.vegan = thread("Vegan menu replies", 30, [], []);
        ids.frost = thread("Frost alerts", 50, [["ops", "owner"]], [server_]);
        ids.cache = thread("Cache expiry leak", 80, [["ops", "owner"]], [server_]);
        ids.upload = thread("Flaky upload test", 90, [], []);
        ids.notes = thread("Old release notes", 100, [["batches", "owner"]], [docs]);
        archive(ids.cache, 12);
        archive(ids.upload, 11);
        archive(ids.notes, 10);
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
  page.setDefaultTimeout(8000);
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}${route}`);
  return page;
}

/** A picture in each theme, for a person to look at (MANDATE_E2E_CAPTURE_FRAMES=1). */
async function lookBoth(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  await look(page, `${name}-light`, { animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await look(page, `${name}-dark`, { animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
}

const rows = (page: Page) => page.locator('[data-slot="thread-row"]');
const row = (page: Page, id: string) => page.locator(`[data-slot="thread-row"][data-thread-id="${id}"]`);
const titles = (page: Page) => rows(page).locator('[data-slot="thread-row-title"]').allTextContents();
const tab = (page: Page, name: "Active" | "Archived") => page.getByRole("tab", { name: new RegExp(`^${name}`) });
const tabCount = (page: Page, name: "Active" | "Archived") => tab(page, name).locator('[data-slot="tab-count"]').textContent();
const allThreadsCount = (page: Page) => page.locator('a[data-slot="all-threads"] [data-slot="all-threads-count"]').textContent();
const labelsOf = (target: Locator) => target.locator('[data-slot="thread-label"]').allTextContents().then((all) => all.map((name) => name.trim()));

/** What a cell of a row shows of its items: how many, what it says of the
 *  rest, how far the count stands from the last one, and whether everything
 *  shown is inside the cell. */
async function fitted(cell: Locator, item: string, more: string): Promise<{ shown: number; more: string | null; gap: number | null; inside: boolean }> {
  return cell.evaluate((el, [itemSlot, moreSlot]) => {
    const box = el.getBoundingClientRect();
    const items = [...el.querySelectorAll(`[data-slot="${itemSlot}"]`)].map((node) => node.getBoundingClientRect());
    const count = el.querySelector(`[data-slot="${moreSlot}"]`);
    const countBox = count?.getBoundingClientRect() ?? null;
    return {
      shown: items.length,
      more: count?.textContent ?? null,
      gap: countBox && items.length > 0 ? Math.round(countBox.left - items.at(-1)!.right) : null,
      inside: [...items, ...(countBox ? [countBox] : [])].every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5)
    };
  }, [item, more] as const);
}
const labelsCell = (target: Locator) => fitted(target.locator('[data-slot="thread-row-labels"]'), "thread-label", "thread-label-more");
const projectsCell = (target: Locator) => fitted(target.locator('[data-slot="thread-row-projects"]'), "thread-row-project", "thread-row-project-more");

/** Every cell of every row, and the row's link area, inside the row's box. */
async function rowsInBounds(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((all) => all.flatMap((el) => {
    const box = el.getBoundingClientRect();
    return [...el.children]
      .filter((child) => { const r = child.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; })
      .map((child) => `${el.getAttribute("data-thread-id")}: ${child.getAttribute("data-slot") ?? child.tagName} leaves its row`);
  }));
}

async function serverThreads(): Promise<{ open: Array<{ id: string; labels: string[] }>; archived: string[] }> {
  const open = (await (await fetch(`${server.baseUrl}/api/agents/manager/threads`)).json()) as { threads: Array<{ id: string; labels: Array<{ name: string; by: string }> }> };
  const archived = (await (await fetch(`${server.baseUrl}/api/agents/manager/threads?archived=1`)).json()) as { archived: Array<{ title: string }> };
  return { open: open.threads.map((t) => ({ id: t.id, labels: t.labels.map((l) => `${l.name}:${l.by}`) })), archived: archived.archived.map((t) => t.title) };
}

// First: it changes nothing on the server, and the desktop test below does.
test("a phone: two-line rows with every label and project, the Filter sheet, Select, and a thread's labels under its title with the sheet that edits them", async () => {
  const page = await open({ width: 390, height: 844 }, "/threads");
  try {
    await rows(page).nth(3).waitFor();
    expect(await titles(page)).toEqual(["Sell rye by the slice", "Bread prices from one sheet for every shop in a chain", "Vegan menu replies", "Frost alerts"]);
    expect(await page.locator('[data-slot="threads-head"]').count()).toBe(0);
    const slices = row(page, ids.slices);
    expect(await labelsOf(slices.locator('[data-slot="thread-row-meta"]'))).toEqual(["batches", "3.21", "ops", "vegan", "customer escalation follow-up"]);
    expect(await slices.locator('[data-slot="thread-row-meta"] [data-slot="thread-row-project"]').allTextContents()).toEqual(["atlas-api", "search-server", "docs-site"]);
    // A thread with neither label nor project is one line.
    expect(await row(page, ids.vegan).locator('[data-slot="thread-row-meta"]').count()).toBe(0);
    expect(await pageOverflow(page)).toEqual([]);
    expect(await rowsInBounds(page)).toEqual([]);
    await lookBoth(page, "phone-active");

    // One Filter button, with how many are ticked.
    const filter = page.locator('[data-slot="thread-filter-phone"]');
    expect((await filter.textContent())?.trim()).toBe("Filter");
    await filter.tap();
    const sheet = page.locator('[data-slot="thread-filter-sheet"]');
    await sheet.getByRole("menuitemcheckbox", { name: "batches" }).waitFor();
    expect(await sheet.locator("h2").textContent()).toBe("Filter threads");
    expect(await sheet.locator('[data-slot="filter-group"]').allTextContents()).toEqual(["Label", "Project"]);
    await lookBoth(page, "phone-filter-sheet");
    await sheet.getByRole("menuitemcheckbox", { name: "batches" }).tap();
    await rows(page).nth(1).waitFor();
    expect(await titles(page)).toEqual(["Sell rye by the slice", "Bread prices from one sheet for every shop in a chain"]);
    expect((await filter.textContent())?.trim()).toBe("Filter · 1");
    // Unticked where it was ticked (Clear filters is below the half-height sheet's fold).
    await sheet.getByRole("menuitemcheckbox", { name: "batches" }).tap();
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "hidden" });
    await rows(page).nth(3).waitFor();
    expect((await filter.textContent())?.trim()).toBe("Filter");

    // Select shows the checkboxes; a row then ticks instead of opening.
    expect(await page.locator('input[data-slot="thread-row-select"]').count()).toBe(0);
    await page.getByRole("button", { name: "Select", exact: true }).tap();
    await row(page, ids.vegan).tap();
    expect(await page.locator('[data-slot="threads-selected-count"]').textContent()).toBe("1 selected");
    expect(page.url()).toBe(`${server.baseUrl}/threads`);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "phone-selecting");
    await page.getByRole("button", { name: "Done", exact: true }).tap();
    expect(await page.locator('input[data-slot="thread-row-select"]').count()).toBe(0);

    // A thread's page: its labels in a row under the title, edited from its
    // menu. The row opens from its second line too.
    const chip = (await slices.locator('[data-slot="thread-row-meta"] [data-slot="thread-label"]').first().boundingBox())!;
    await page.touchscreen.tap(chip.x + chip.width / 2, chip.y + chip.height / 2);
    await page.waitForURL(`${server.baseUrl}/threads/${ids.slices}`);
    const under = page.locator('[data-slot="phone-labels-row"]');
    await under.waitFor();
    expect(await labelsOf(under)).toEqual(["batches", "3.21", "ops", "vegan", "customer escalation follow-up"]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "phone-thread-labels-row");
    await page.getByRole("button", { name: "Thread actions", exact: true }).tap();
    await page.getByRole("menuitem", { name: "Labels…" }).tap();
    const labels = page.locator('[data-slot="thread-labels-sheet"]');
    await labels.locator('input[aria-label="Add a label"]').waitFor();
    expect(await labels.locator("h2").textContent()).toBe("Labels");
    await lookBoth(page, "phone-labels-sheet");
  } finally {
    await page.close();
  }
}, 90_000);

test("a desktop pane of 600px: the tabs, rows whose labels fit their line, a filter, a label added in the header, and rows labelled, deleted and archived together", async () => {
  const page = await open({ width: 1000, height: 900 }, "/threads");
  try {
    await rows(page).nth(3).waitFor();
    // A pane of a two-pane split: about 600px beside the sidebar.
    const paneAt1000 = await page.locator('[data-slot="threads-page"]').evaluate((el) => el.getBoundingClientRect().width);
    await page.setViewportSize({ width: Math.round(1000 - (paneAt1000 - 600)), height: 900 });
    const pane = await page.locator('[data-slot="threads-page"]').evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.abs(pane - 600) <= 2).toBe(true);

    expect([await tabCount(page, "Active"), await tabCount(page, "Archived"), await allThreadsCount(page)]).toEqual(["4", "3", "7"]);
    expect(await page.locator('[data-slot="threads-head-cell"]').allTextContents()).toEqual(["Thread", "Labels", "Project", "Last activity"]);
    expect(await titles(page)).toEqual(["Sell rye by the slice", "Bread prices from one sheet for every shop in a chain", "Vegan menu replies", "Frost alerts"]);
    expect(await rows(page).locator('[data-slot="thread-row-time"]').allTextContents()).toEqual(["2h ago", "5h ago", "1d ago", "2d ago"]);

    // Five labels do not fit the column: as many as do, then how many more,
    // right after them and inside the cell.
    const slices = row(page, ids.slices);
    await slices.locator('[data-slot="thread-label-more"]').waitFor();
    const fit = await labelsCell(slices);
    expect(fit.shown >= 1 && fit.shown < 5).toBe(true);
    expect([fit.more, fit.gap, fit.inside]).toEqual([`+${5 - fit.shown}`, 4, true]);
    // One label fits: nothing is counted.
    expect(await labelsCell(row(page, ids.prices))).toEqual({ shown: 1, more: null, gap: null, inside: true });
    // Three projects, of which a row names two at most: those that fit, whole.
    const named = await projectsCell(slices);
    expect(named.shown >= 1 && named.shown <= 2).toBe(true);
    expect([named.more, named.gap, named.inside]).toEqual([`+${3 - named.shown}`, 6, true]);
    expect(await slices.locator('[data-slot="thread-row-project"]').evaluateAll((all) => all.every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
    // A long title is cut inside its cell; nothing leaves a row or the page.
    expect(await row(page, ids.prices).locator('[data-slot="thread-row-title"] span').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await rowsInBounds(page)).toEqual([]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "desktop-active");

    // A wider pane fits more of them.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction((before) => document.querySelectorAll('[data-slot="thread-row"] [data-slot="thread-row-labels"]')[0]!.querySelectorAll('[data-slot="thread-label"]').length > before, fit.shown);
    const wide = await labelsCell(slices);
    expect([wide.more, wide.inside]).toEqual([wide.shown === 5 ? null : `+${5 - wide.shown}`, true]);
    expect(await projectsCell(slices)).toEqual({ shown: 2, more: "+1", gap: 6, inside: true });
    await lookBoth(page, "desktop-wide");
    await page.setViewportSize({ width: Math.round(1000 - (paneAt1000 - 600)), height: 900 });

    // The whole row opens its thread: a click on a label or on a project
    // too (at a point: what is hit there is the row's link, not the cell).
    for (const cell of ["thread-row-labels", "thread-row-projects", "thread-row-time"]) {
      const box = (await slices.locator(`[data-slot="${cell}"]`).boundingBox())!;
      await page.mouse.click(box.x + 6, box.y + box.height / 2);
      await page.waitForURL(`${server.baseUrl}/threads/${ids.slices}`);
      await page.goBack();
      await rows(page).nth(3).waitFor();
    }

    // A filter narrows the tab shown and says how many are ticked.
    await page.locator('[data-slot="thread-filter-label"]').click();
    expect(await page.getByRole("menuitemcheckbox").allTextContents()).toEqual(["Select all", "3.21", "batches", "customer escalation follow-up", "ops", "vegan", "No label"]);
    await page.getByRole("menuitemcheckbox", { name: "batches" }).click();
    await lookBoth(page, "desktop-filter-menu");
    await page.keyboard.press("Escape");
    await rows(page).nth(1).waitFor();
    expect(await titles(page)).toEqual(["Sell rye by the slice", "Bread prices from one sheet for every shop in a chain"]);
    expect((await page.locator('[data-slot="thread-filter-label"]').textContent())?.trim()).toBe("Label · 1");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await rows(page).nth(3).waitFor();

    // A label added in the thread's header is on the page's row.
    await row(page, ids.vegan).locator("a").click();
    await page.waitForURL(`${server.baseUrl}/threads/${ids.vegan}`);
    const header = page.locator('[data-slot="thread-labels"]');
    await header.getByRole("button", { name: "Add a label" }).click();
    const field = page.locator('[data-slot="thread-labels-field"] input[aria-label="Add a label"]');
    await field.fill("bat");
    expect(await page.locator('[data-slot="thread-label-suggestion"]').allTextContents()).toEqual(["batches", 'Create "bat"']);
    await lookBoth(page, "desktop-header-field");
    await page.locator('[data-slot="thread-label-suggestion"]').first().click();
    await header.locator('[data-slot="thread-label"]', { hasText: "batches" }).waitFor();
    await field.fill("urgent");
    await field.press("Enter");
    await header.locator('[data-slot="thread-label"]', { hasText: "urgent" }).waitFor();
    await page.keyboard.press("Escape");
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "desktop-header-labels");
    // What opened the field closes it: the chips as the + does.
    const chipsButton = header.locator("button", { has: page.locator('[data-slot="thread-label"]') });
    const fieldBox = page.locator('[data-slot="thread-labels-field"]');
    await chipsButton.click();
    await fieldBox.waitFor();
    await chipsButton.click();
    await fieldBox.waitFor({ state: "detached", timeout: 3000 });
    await header.getByRole("button", { name: "Add a label" }).click();
    await fieldBox.waitFor();
    await header.getByRole("button", { name: "Add a label" }).click();
    await fieldBox.waitFor({ state: "detached", timeout: 3000 });
    await page.locator('a[data-slot="all-threads"]').click();
    await page.waitForURL(`${server.baseUrl}/threads`);
    await row(page, ids.vegan).locator('[data-slot="thread-label"]', { hasText: "urgent" }).waitFor();
    expect(await labelsOf(row(page, ids.vegan))).toEqual(["batches", "urgent"]);

    // Two rows labelled together.
    await row(page, ids.prices).locator('input[data-slot="thread-row-select"]').check();
    await row(page, ids.frost).locator('input[data-slot="thread-row-select"]').check();
    const bar = page.locator('[data-slot="threads-selection-bar"]');
    expect(await bar.locator('[data-slot="threads-selected-count"]').textContent()).toBe("2 selected");
    expect(await page.locator('[data-slot="threads-head"]').count()).toBe(0);
    await bar.getByRole("button", { name: "Add label" }).click();
    const bulk = page.locator('[data-slot="bulk-labels-field"] input[aria-label="Add a label"]');
    await bulk.fill("q4");
    await lookBoth(page, "desktop-selection-bar");
    await bulk.press("Enter");
    await row(page, ids.frost).locator('[data-slot="thread-label"]', { hasText: "q4" }).waitFor();
    await row(page, ids.prices).locator('[data-slot="thread-label"]', { hasText: "q4" }).waitFor();
    expect(await bar.locator('[data-slot="threads-selected-count"]').textContent()).toBe("2 selected");
    const labelled = Object.fromEntries((await serverThreads()).open.map((t) => [t.id, t.labels]));
    expect([labelled[ids.prices], labelled[ids.frost], labelled[ids.vegan]]).toEqual([["batches:owner", "q4:owner"], ["ops:owner", "q4:owner"], ["batches:owner", "urgent:owner"]]);

    // The same two archived together: one dialog, each by its own request.
    await bar.getByRole("button", { name: "Archive…" }).click();
    const dialog = page.getByRole("dialog");
    expect(await dialog.locator("h2").textContent()).toBe("Archive 2 threads?");
    expect(await dialog.locator('[data-slot="dialog-description"]').textContent()).toBe("They move to the Archived tab of Threads, where you can still read them.");
    await lookBoth(page, "desktop-archive-dialog");
    await dialog.getByRole("button", { name: "Archive", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await rows(page).nth(2).waitFor({ state: "detached" });
    expect(await titles(page)).toEqual(["Sell rye by the slice", "Vegan menu replies"]);
    expect([await tabCount(page, "Active"), await tabCount(page, "Archived"), await bar.count()]).toEqual(["2", "5", 0]);

    // On Archived: two of them deleted together, the others left.
    await tab(page, "Archived").click();
    await rows(page).nth(4).waitFor();
    expect(await page.locator('[data-slot="threads-head-cell"]').allTextContents()).toEqual(["Thread", "Labels", "Project", "Archived"]);
    expect(await row(page, ids.cache).locator('[data-slot="thread-row-time"]').textContent()).toBe("Jan 12");
    await row(page, ids.upload).locator('input[data-slot="thread-row-select"]').check();
    await row(page, ids.notes).locator('input[data-slot="thread-row-select"]').check();
    await page.locator('[data-slot="threads-selection-bar"]').getByRole("button", { name: "Delete…" }).click();
    expect(await dialog.locator("h2").textContent()).toBe("Delete 2 archived threads permanently?");
    expect(await dialog.textContent()).toContain("This removes, for good, these threads’ conversations and 1 worker with its chat and plan.");
    expect(await dialog.textContent()).toContain("Other threads are not touched.");
    await lookBoth(page, "desktop-delete-dialog");
    await dialog.getByRole("button", { name: "Delete 2 threads" }).click();
    await dialog.waitFor({ state: "detached" });
    await row(page, ids.notes).waitFor({ state: "detached" });
    const left = (await serverThreads()).archived;
    expect(left.includes("Flaky upload test") || left.includes("Old release notes")).toBe(false);
    expect(left.includes("Cache expiry leak")).toBe(true);
    expect([await tabCount(page, "Archived"), await allThreadsCount(page)]).toEqual(["3", "5"]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "desktop-archived");
  } finally {
    await page.close();
  }
}, 120_000);

// A touch screen wide enough for desktop rows (a tablet): a row's box is
// 14px, so everything left of the title's area, the row's full height,
// is the box's to touch.
test("a touch screen with desktop rows: a tap anywhere left of a row's title ticks it", async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  page.setDefaultTimeout(8000);
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/threads`);
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    // One the 600px test leaves open (it archives prices and frost).
    const target = row(page, ids.vegan);
    const box = target.locator('input[data-slot="thread-row-select"]');
    await box.waitFor();
    // Measured before each tap: a ticked row brings the selection bar in
    // where the column heads were, and the rows move.
    const where = async () => (await target.boundingBox())!;
    expect((await where()).height).toBeGreaterThanOrEqual(44);
    // In the row's padding near its top edge, then just before the title's
    // area (it starts 1.75rem in) near its bottom edge.
    let at = await where();
    await page.touchscreen.tap(at.x + 3, at.y + 4);
    expect(await box.isChecked()).toBe(true);
    at = await where();
    await page.touchscreen.tap(at.x + 26, at.y + at.height - 4);
    expect(await box.isChecked()).toBe(false);
    expect(new URL(page.url()).pathname).toBe("/threads");
    // Past it, the row opens its thread as before.
    at = await where();
    await page.touchscreen.tap(at.x + 31, at.y + at.height / 2);
    await page.waitForURL(new RegExp(`/threads/${ids.vegan}$`));
  } finally {
    await page.close();
  }
}, 60_000);

// The server's wiring of labels: a label put on a thread is published to
// every open page, and threads and tasks share their names' spellings, each
// asking the other for the one in use.
test("a thread's new label reaches an open page by the stream; a task and a thread keep each other's spelling", async () => {
  const api = (route: string, body: unknown) => fetch(`${server.baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const page = await open({ width: 1200, height: 800 }, "/threads");
  try {
    const target = row(page, ids.slices);
    await target.waitFor();
    // How many labels the row says it has: the chips it shows and its "+N".
    const total = (id: string) => page.evaluate((threadId) => {
      const cell = document.querySelector(`[data-slot="thread-row"][data-thread-id="${threadId}"] [data-slot="thread-row-labels"]`);
      const chips = cell ? cell.querySelectorAll('[data-slot="thread-label"]').length : 0;
      const more = Number(cell?.querySelector('[data-slot="thread-label-more"]')?.textContent?.trim().replace("+", "") || 0);
      return chips + more;
    }, id);
    const before = await total(ids.slices);
    // Put on from elsewhere (as the agent's tool does): the row counts it with no reload.
    expect((await api(`/api/agents/manager/threads/${ids.slices}/labels`, { name: "Invoices" })).status).toBe(200);
    await page.waitForFunction(([threadId, was]) => {
      const cell = document.querySelector(`[data-slot="thread-row"][data-thread-id="${threadId}"] [data-slot="thread-row-labels"]`);
      const chips = cell ? cell.querySelectorAll('[data-slot="thread-label"]').length : 0;
      const more = Number(cell?.querySelector('[data-slot="thread-label-more"]')?.textContent?.trim().replace("+", "") || 0);
      return chips + more === (was as number) + 1;
    }, [ids.slices, before] as const, { timeout: 10_000 });
    const listed = await (await fetch(`${server.baseUrl}/api/agents/manager/threads`)).json() as { threads: Array<{ id: string; labels: Array<{ name: string }> }> };
    expect(listed.threads.find((t) => t.id === ids.slices)!.labels.map((l) => l.name)).toContain("Invoices");
    // A task takes the thread's spelling of the name…
    const task = ((await (await api("/api/task-board/tasks", { title: "Quarterly invoices" })).json()) as { task: { id: string } }).task.id;
    const onTask = (await (await api(`/api/task-board/tasks/${task}/labels`, { name: "invoices" })).json()) as { task: { labels: Array<{ name: string }> } };
    expect(onTask.task.labels.map((l) => l.name)).toEqual(["Invoices"]);
    // …and a thread the task's.
    await api(`/api/task-board/tasks/${task}/labels`, { name: "Quarterly" });
    const onThread = (await (await api(`/api/agents/manager/threads/${ids.slices}/labels`, { name: "QUARTERLY" })).json()) as { labels: Array<{ name: string }> };
    expect(onThread.labels.map((l) => l.name)).toContain("Quarterly");
  } finally {
    await page.close();
  }
}, 60_000);
