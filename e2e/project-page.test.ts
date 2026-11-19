import { afterAll, beforeAll, expect, test } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { seedProject, seedWorker } from "../tests/helpers/fixtures.js";

/**
 * A project's page and the Projects list through the compiled server: a
 * list row opens the project's page; the page counts and lists the
 * project's workers, what the agents know of it, its threads, its open
 * tasks and its reports, and its links open the Threads page and the board
 * filtered to it. In a desktop pane of 600px and on a phone, one column
 * that never scrolls sideways.
 */

const browser = browserForFile();
let server: RunningServer;
const SLUG = "md-pp-atlas-api";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    label: "project-page",
    seed(dataDir) {
      const store = new MandateStore(dataDir);
      try {
        const db = store.db;
        const agents = new AgentStore(db);
        const projects = new ProjectsStore(db);
        const workers = new WorkersStore(db);
        const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
        const dir = (name: string) => { const d = path.join(dataDir, "work", name); fs.mkdirSync(d, { recursive: true }); return d; };
        const atlas = seedProject(projects, { name: "atlas-api", workingDir: dir("atlas-api"), tmuxSessionName: SLUG });
        const search = seedProject(projects, { name: "search-server", workingDir: dir("search-server"), tmuxSessionName: "md-pp-search-server" });
        let made = 0;
        /** A thread last active `hours` ago whose workers ran in `projectId`; `archived` archives the thread and its workers. */
        const thread = (title: string, hours: number, projectId: string, workerNames: string[], archived = false) => {
          const id = agents.createManagerThread(title).id;
          agents.appendMessage({ threadId: id, role: "user", source: "user", content: { type: "text", text: `About ${title}.` } });
          db.prepare("update agent_messages set created_at = ? where thread_id = ?").run(hoursAgo(hours), id);
          for (const name of workerNames) {
            made += 1;
            const workerId = seedWorker(workers, projectId, { name, tmuxWindowName: `pp-w${made}`, ownerThreadId: id });
            if (archived) workers.archive(workerId);
          }
          if (archived) agents.archiveThread(id);
          return id;
        };
        const slices = thread("Sell bread by the slice", 2.5, atlas, ["Slice pricing"]);
        thread("Menu prices from one source", 6, atlas, ["Price table"]);
        thread("Old cache fix", 40, atlas, ["Cache expiry"], true);
        const tuning = thread("Search tuning", 1, search, ["Ranker"]);
        // Tasks linked to the threads: the project's name is their automatic label.
        const board = new TaskBoardService({ db, agentStore: agents, sse: { emit: () => {} } as never, threadDots: () => new Map() });
        const task = (title: string, threadId: string, status: "todo" | "progress" | "review" | "done") => {
          const t = board.create({ title }, "owner");
          board.link(t.id, threadId);
          if (status !== "todo") board.setStatus(t.id, status, "owner");
        };
        task("Move bread sales to slices", slices, "progress");
        task("Ship the price table", slices, "done");
        task("Tune the ranker", tuning, "todo");
        // What the agents know of atlas-api: three memories and its brief.
        const memory = db.prepare(`insert into memory_entries (id, scope, project_id, worker_id, type, source, user_quote, content, status, source_thread_id, source_message_id, created_at, updated_at, metadata_json)
          values (?, 'project', ?, null, 'knowledge', 'extraction', null, ?, 'available', null, null, ?, ?, null)`);
        ["Orders round up to a whole slice.", "Prices come from one table.", "Releases go dev, then staging, then production."]
          .forEach((content, i) => memory.run(`mem_pp${i}`, atlas, content, hoursAgo(i + 1), hoursAgo(i + 1)));
        db.prepare("insert into memory_briefs (scope, project_id, content, input_digest, built_at) values ('project', ?, ?, 'pp', ?)").run(atlas, [
          "atlas-api takes orders and serves the price table.",
          "",
          "### Orders",
          "- Bread is sold by the slice, rounded up.",
          "- Prices come from one table."
        ].join("\n"), hoursAgo(2));
        // search-server's brief runs long: the page shows its first lines.
        db.prepare("insert into memory_briefs (scope, project_id, content, input_digest, built_at) values ('project', ?, ?, 'pp', ?)").run(search, [
          "search-server ranks and serves search results.",
          ...Array.from({ length: 6 }, (_, i) => [`### Area ${i + 1}`, `- A note about area ${i + 1}.`, `- Another note about area ${i + 1}.`]).flat()
        ].join("\n"), hoursAgo(2));
        // One report tagged with atlas-api.
        db.prepare(`insert into canvas_documents (id, title, html, scope, scope_id, project_id, file_path, thread_id, created_at, updated_at, content_revision, kind)
          values ('cnv_pp1', 'Slice pricing report', '<p>Report</p>', 'manager', null, ?, null, ?, ?, ?, 0, 'report')`).run(atlas, slices, hoursAgo(3), hoursAgo(3));
      } finally {
        store.db.close();
      }
    }
  });
}, 90_000);

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

const figures = (page: Page) => page.locator('[data-slot="project-figure"]').allTextContents();
const block = (page: Page, name: string) => page.locator(`[data-slot="project-block"][data-block="${name}"]`);
/** The page once its reads have landed: all five counts are there. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="project-figure"]').length === 5);
}

test("desktop: a list row opens the project's page; it counts and lists what the project has, and its links open the pages that hold it all", async () => {
  const page = await open({ width: 1440, height: 900 }, "/projects");
  try {
    const row = page.locator('[data-slot="project-row"]', { hasText: "atlas-api" });
    // The tasks come with the stream, after the projects.
    await row.locator('[data-slot="project-row-fact"]', { hasText: "1 open task" }).waitFor();
    expect((await row.locator('[data-slot="project-row-fact"]').allTextContents()).slice(0, 2)).toEqual(["2 working", "1 open task"]);
    await row.locator('[data-slot="project-row-name"]').click();
    await page.waitForURL((url) => url.pathname === `/projects/${SLUG}`);
    await settled(page);
    expect((await page.locator('[data-slot="pane-header"] nav[aria-label="Breadcrumb"]').textContent())?.replace(/\s+/g, "")).toBe("Projects/atlas-api");
    // Two open threads ran here (one with an active worker), one archived; a third worker was archived with its thread.
    expect(await figures(page)).toEqual(["2 working", "1 open task", "3 threads", "3 memories", "1 report"]);
    expect(await block(page, "workers").locator('[data-slot="worker-row"]').count()).toBe(2);
    expect(await block(page, "brief").textContent()).toContain("Bread is sold by the slice, rounded up.");
    expect(await block(page, "threads").locator('[data-slot="project-thread-row"]').allTextContents()).toEqual([
      expect.stringContaining("Sell bread by the slice"), expect.stringContaining("Menu prices from one source"), expect.stringContaining("Old cache fix")
    ]);
    expect(await block(page, "tasks").locator('[data-slot="project-task-row"]').allTextContents()).toEqual(["Move bread sales to slices"]);
    expect(await block(page, "reports").locator('[data-slot="project-report-title"]').allTextContents()).toEqual(["Slice pricing report"]);
    // Threads and Open tasks share a row where there is room.
    const [threads, tasks] = await Promise.all([block(page, "threads").boundingBox(), block(page, "tasks").boundingBox()]);
    expect(threads!.y).toBe(tasks!.y);
    await lookBoth(page, "project-page-desktop");

    await block(page, "threads").getByRole("link", { name: "All threads →" }).click();
    await page.waitForURL((url) => url.pathname === "/threads" && url.search === "");
    expect((await page.locator('[data-slot="thread-filter-project"]').textContent())?.trim()).toBe("Project · 1");
    expect(await page.locator('[data-slot="thread-row-title"]').allTextContents()).toEqual(["Sell bread by the slice", "Menu prices from one source"]);

    await page.goBack();
    await settled(page);
    await block(page, "tasks").getByRole("link", { name: "Board →" }).click();
    await page.waitForURL((url) => url.pathname === "/tasks" && url.search === "");
    expect((await page.locator('[data-slot="task-filter-label"]').textContent())?.trim()).toBe("Label · 1");
    await page.locator('[data-slot="task-card"]', { hasText: "Move bread sales to slices" }).waitFor();
    expect(await page.locator('[data-slot="task-card"]', { hasText: "Tune the ranker" }).count()).toBe(0);
  } finally {
    await page.close();
  }
}, 40_000);

test("the brief fades out only where it is cut", async () => {
  const page = await open({ width: 1440, height: 900 }, `/projects/${SLUG}`);
  try {
    await settled(page);
    // atlas-api's five lines fit.
    await block(page, "brief").getByText("Prices come from one table.").waitFor();
    expect(await block(page, "brief").locator('[data-slot="project-brief-fade"]').count()).toBe(0);
    await page.goto(`${server.baseUrl}/projects/md-pp-search-server`);
    await settled(page);
    await block(page, "brief").locator('[data-slot="project-brief-fade"]').waitFor();
  } finally {
    await page.close();
  }
}, 30_000);

test("a desktop pane of 600px: the page is one column and nothing scrolls sideways, nor on the list", async () => {
  const page = await open({ width: 1000, height: 1400 }, `/projects/${SLUG}`);
  try {
    await settled(page);
    // A pane of a two-pane split: about 600px beside the sidebar.
    const width = () => page.locator("main").evaluate((el) => el.getBoundingClientRect().width);
    await page.setViewportSize({ width: Math.round(1000 - ((await width()) - 600)), height: 1400 });
    expect(Math.abs((await width()) - 600) <= 2).toBe(true);
    const [threads, tasks] = await Promise.all([block(page, "threads").boundingBox(), block(page, "tasks").boundingBox()]);
    expect(threads!.x).toBe(tasks!.x);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "project-page-pane");
    await page.goto(`${server.baseUrl}/projects`);
    await page.locator('[data-slot="project-row"]').nth(1).waitFor();
    expect(await pageOverflow(page)).toEqual([]);
    // Whatever sits beside it (a missing session's warning and Restore, the
    // facts, an old date), a row keeps room to say which project it is.
    await page.locator('[data-slot="project-row"]', { hasText: "session missing" }).first().waitFor();
    const widths = await page.locator('[data-slot="project-row-name"], [data-slot="project-row-folder"]').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(widths.filter((width) => width < 120)).toEqual([]);
    await lookBoth(page, "projects-list-pane");
  } finally {
    await page.close();
  }
}, 40_000);

test("phone: the top bar reads Projects, then the name; the page is one column and nothing scrolls sideways, nor on the list", async () => {
  const page = await open({ width: 390, height: 844 }, `/projects/${SLUG}`);
  try {
    await settled(page);
    const crumbs = page.locator('nav[aria-label="Breadcrumb"]').first();
    expect((await crumbs.textContent())?.replace(/\s+/g, "")).toBe("Projects/atlas-api");
    expect(await crumbs.getByRole("link", { name: "Projects" }).getAttribute("href")).toBe("/projects");
    expect(await crumbs.locator('[aria-current="page"]').textContent()).toBe("atlas-api");
    const [threads, tasks] = await Promise.all([block(page, "threads").boundingBox(), block(page, "tasks").boundingBox()]);
    expect(threads!.x).toBe(tasks!.x);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "project-page-phone");
    await page.goto(`${server.baseUrl}/projects`);
    await page.locator('[data-slot="project-row"]').nth(1).waitFor();
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "projects-list-phone");
  } finally {
    await page.close();
  }
}, 40_000);
