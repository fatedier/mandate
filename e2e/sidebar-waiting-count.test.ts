import { afterAll, beforeAll, expect, test } from "bun:test";
import { startServer, type RunningServer } from "./helpers/server";
import { browserForFile } from "./helpers/browser";
import { seedProject } from "../tests/helpers/fixtures.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { seedJudgedThread, managerStopCheckOn } from "./helpers/status-seeds";
import { look } from "./helpers/page-diagnostics.js";

// What waits on the user leads the sidebar's Threads, and New thread carries
// no count beside it; the phone's closed menu button carries one, as a dot.
// However many threads there are, the waiting one shows at rest (the menu and
// the threads scroll as one, see nav-scroll), and thread rows scroll instead
// of shrinking.
const browser = browserForFile();
let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      managerStopCheckOn(dataDir);
      const store = new MandateStore(dataDir);
      const agent = new AgentStore(store.db);
      const projects = new ProjectsStore(store.db);
      const workers = new WorkersStore(store.db);
      const projectId = seedProject(projects, { name: "project-1", tmuxSessionName: "md-project-1-many" });
      const threads = Array.from({ length: 40 }, (_, i) => agent.createManagerThread(`Thread ${String(i + 1).padStart(2, "0")}`));
      workers.insert({
        projectId, name: "evicthook", mode: "shared-cwd", branch: null, worktreePath: null,
        tmuxWindowName: "evicthook", ownership: "app", ownerThreadId: threads[0]!.id
      });
      // One thing waits: a thread stopped on a result for the user to read.
      seedJudgedThread(store.db, agent, "Changelog", "result", "The changelog for 3.21 is written.");
      store.db.close();
    }
  });
}, 60_000);

afterAll(async () => {
  server?.cleanup();
});

/** How much of a row a person can see: its box cut by every scrolling
 *  ancestor and the viewport (a bounding box alone ignores the clipping). */
async function visibleHeight(page: import("playwright").Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    let top = Math.max(r.top, 0);
    let bottom = Math.min(r.bottom, window.innerHeight);
    for (let a = el.parentElement; a; a = a.parentElement) {
      const o = getComputedStyle(a).overflowY;
      if (o === "auto" || o === "scroll" || o === "hidden") {
        const ar = a.getBoundingClientRect();
        top = Math.max(top, ar.top);
        bottom = Math.min(bottom, ar.bottom);
      }
    }
    return Math.max(0, bottom - top);
  }, selector);
}

test("with forty threads the waiting thread leads the list and shows at rest, New thread counts nothing, no worker is listed, and thread rows keep their height", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 700 } });
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${server.baseUrl}/projects`);
    await page.locator('[role="group"][aria-label="Threads"] [data-thread-title="Thread 40"]').waitFor();
    const waiting = page.locator('[role="group"][aria-label="Threads"] [data-thread-title]').first();
    expect(await waiting.getAttribute("data-thread-title")).toBe("Changelog");
    await waiting.locator('[role="img"][aria-label="state: result to read"]').waitFor();
    const box = (await waiting.boundingBox())!;
    expect(box.y >= 0 && box.y + box.height <= 700).toBe(true);
    // Nothing covers it: it is what the page shows at that point.
    const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-thread-title="Changelog"]') !== null, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(topmost).toBe(true);
    expect(await page.locator('[data-slot="new-thread"] [role="img"]').count()).toBe(0);
    // The sidebar lists no worker: a worker is reached from its thread.
    expect(await page.locator('aside [role="group"][aria-label="Workers"], aside [data-worker-name="evicthook"]').count()).toBe(0);
    // Thread rows keep their height and scroll instead of shrinking.
    const thread = (await page.locator('[role="group"][aria-label="Threads"] [data-thread-title="Thread 01"]').boundingBox())!;
    expect(thread.height).toBeGreaterThanOrEqual(27);
  } finally {
    await page.close();
  }
}, 30_000);

test("a short window still shows a whole thread row: desktop at 420px tall, and a phone in landscape, whose menu button carries the waiting count", async () => {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 420 } });
  desktop.setDefaultTimeout(8000);
  try {
    await desktop.goto(`${server.baseUrl}/projects`);
    await desktop.locator('[role="group"][aria-label="Threads"] [data-thread-title="Thread 20"]').waitFor();
    // Rows keep their height in the short list: revealed, one shows whole.
    const thread = '[role="group"][aria-label="Threads"] [data-thread-title="Thread 20"]';
    await desktop.locator(thread).scrollIntoViewIfNeeded();
    expect(await visibleHeight(desktop, thread)).toBeGreaterThanOrEqual(27);
  } finally {
    await desktop.close();
  }
  const context = await browser.newContext({ viewport: { width: 667, height: 375 }, hasTouch: true });
  const phone = await context.newPage();
  phone.setDefaultTimeout(8000);
  try {
    await phone.goto(`${server.baseUrl}/projects`);
    // Closed, the menu button carries a dot inside its own box, named with the count.
    const menu = phone.getByRole("button", { name: "Open navigation" });
    const dot = menu.locator('[role="img"][aria-label="1 item to look at"]');
    await dot.waitFor();
    const [menuBox, dotBox] = [(await menu.boundingBox())!, (await dot.boundingBox())!];
    expect(dotBox.width).toBeLessThanOrEqual(8.5);
    expect(dotBox.x >= menuBox.x && dotBox.x + dotBox.width <= menuBox.x + menuBox.width).toBe(true);
    expect(dotBox.y >= menuBox.y && dotBox.y + dotBox.height <= menuBox.y + menuBox.height).toBe(true);
    await look(phone, "phone", { clip: { x: 0, y: 0, width: 240, height: 60 } });
    await menu.tap();
    // The drawer covers the menu button's count; its threads, the waiting one
    // first, say which waits, and its New thread row counts nothing.
    const first = phone.locator('[role="dialog"] [role="group"][aria-label="Threads"] [data-thread-title]').first();
    expect(await first.getAttribute("data-thread-title")).toBe("Changelog");
    expect(await phone.locator('[role="dialog"] [data-slot="new-thread"] [role="img"]').count()).toBe(0);
    // And a thread row, whole once revealed.
    const thread = '[role="group"][aria-label="Threads"] [data-thread-title="Thread 20"]';
    await phone.locator(thread).scrollIntoViewIfNeeded();
    expect(await visibleHeight(phone, thread)).toBeGreaterThanOrEqual(27);
  } finally {
    await context.close();
  }
}, 30_000);
