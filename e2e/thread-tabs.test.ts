import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { BrowserContextOptions, Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { settle } from "./helpers/settle.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ProjectsStore } from "../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../src/server/modules/workers/workers-store.js";
import { HandoffStore } from "../src/server/modules/personal/handoff-store.js";
import { seedProject } from "../tests/helpers/fixtures.js";
import { waitUntil } from "../tests/helpers/wait.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";

// A manager thread opened beside the personal agent: a tab of its panel with the
// thread's whole conversation, kept on the server so it is there after a
// reload and on another device. Opened from a "Sent to" card, the tab row's
// "+", a sidebar row's ⋯ and the thread page's ⋯; on a phone (and a half
// screen) in the panel.

let server: RunningServer;
const browser = browserForFile();
const seeded = { release: "", ci: "", docs: "", workerId: "", workerThread: "" };
const REPLY = "Photo import finished: all three albums match.";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed(dataDir) {
      const file = path.join(dataDir, "config.json");
      const config = (flatFromFile(JSON.parse(fs.readFileSync(file, "utf8"))) as Record<string, any>);
      config.agent = { ...config.agent, personalAgentName: "Juno" };
      fs.writeFileSync(file, JSON.stringify(fileFromFlat(config), null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const personal = agents.getOrCreatePersonalThread();
        seeded.release = agents.createManagerThread("Release 3.21", { titleByUser: true }).id;
        seeded.ci = agents.createManagerThread("CI speed-up", { titleByUser: true }).id;
        seeded.docs = agents.createManagerThread("Docs layout", { titleByUser: true }).id;
        agents.appendMessage({ threadId: seeded.release, role: "user", source: "user", content: { type: "text", text: "Run the photo import on the test album first." } });
        agents.appendMessage({ threadId: seeded.release, role: "assistant", source: "self", wakeId: "wake_r1", content: { type: "assistant", text: REPLY } });
        const projectId = seedProject(new ProjectsStore(store.db), { name: "project-1", tmuxSessionName: "md-thread-tabs" });
        seeded.workerId = new WorkersStore(store.db).insert({
          projectId, name: "release-notes", mode: "shared-cwd", branch: null, worktreePath: null,
          tmuxWindowName: "release-notes", ownership: "app", ownerThreadId: seeded.release
        });
        seeded.workerThread = agents.getOrCreateThread("worker", seeded.workerId).id;

        // The personal agent handed the photo import to the release thread, which has
        // answered (nothing left to wake the agent for): its card.
        const text = "Run the photo import on the test album and tell me the photo counts.";
        agents.appendMessage({ threadId: personal.id, role: "user", source: "user", content: { type: "text", text: "Have the release thread run the photo import on the test album." } });
        const handoffs = new HandoffStore(store.db);
        const handoff = handoffs.insert({ personalThreadId: personal.id, kind: "thread", state: "replied", text, spoken: false, workerId: null, targetThreadId: seeded.release, newThreadTitle: null });
        handoffs.transition(handoff.id, ["replied"], { reply: REPLY, repliedAt: new Date().toISOString() });
        agents.appendMessage({ threadId: personal.id, role: "assistant", source: "self", wakeId: "wake_g1", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "call_send", toolName: "send_to_thread", args: { threadId: seeded.release, text } }] } });
        agents.appendMessage({ threadId: personal.id, role: "tool", source: "self", wakeId: "wake_g1", content: { type: "tool_result", toolCallId: "call_send", toolName: "send_to_thread", result: { handoff: {
          id: handoff.id, kind: "thread", state: "replied", text, spoken: false, workerId: null, workerName: null, ownerThreadTitle: null,
          threadId: seeded.release, threadTitle: "Release 3.21", newThreadTitle: null, reply: null, reason: null, stop: null,
          createdAt: handoff.createdAt, updatedAt: handoff.createdAt, repliedAt: null
        } } } });
        agents.appendMessage({ threadId: personal.id, role: "assistant", source: "self", wakeId: "wake_g1", content: { type: "assistant", text: "Sent to the release thread." } });
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => server?.cleanup());

const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function open(pathname: string, device: BrowserContextOptions = DESKTOP): Promise<Page> {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}${pathname}`);
  return page;
}

/** The threads open beside the personal agent, as the server keeps them. */
async function served(): Promise<string[]> {
  const body = await (await fetch(`${server.baseUrl}/api/agents/personal/thread-tabs`)).json() as { tabs: Array<{ threadId: string }> };
  return body.tabs.map((tab) => tab.threadId);
}
async function closeAll(): Promise<void> {
  for (const threadId of await served()) await fetch(`${server.baseUrl}/api/agents/personal/thread-tabs/${threadId}`, { method: "DELETE" });
}

const tabs = (page: Page) => page.locator('[role="tablist"][aria-label="Page tabs"] [role="tab"]');
const threadTab = (page: Page, threadId: string) => page.locator(`[role="tab"][data-thread-tab="${threadId}"]`);
const view = (page: Page) => page.locator('[data-slot="thread-tab-view"]');

test("a Sent to card opens its thread beside the personal agent: the whole conversation, kept after a reload; a worker in it opens on the thread's page", async () => {
  await closeAll();
  const page = await open("/agent");
  try {
    const card = page.locator('[data-slot="handoff-card"]');
    const icon = page.locator('[data-slot="handoff-peek"] [data-slot="handoff-panel"]');
    // In the box its name opens: before Open thread, and says what it does.
    await card.locator('[data-slot="handoff-target"]').click();
    await icon.waitFor();
    expect([(await icon.innerText()).trim(), await icon.evaluate((el) => el.nextElementSibling?.getAttribute("data-slot"))]).toEqual(["Open in panel", "handoff-open"]);
    await icon.click();
    // The box closes; the page stays, with the thread beside it.
    await icon.waitFor({ state: "detached" });
    await threadTab(page, seeded.release).and(page.locator('[aria-selected="true"]')).waitFor();
    await view(page).getByText(REPLY).waitFor();
    expect(await tabs(page).allTextContents()).toEqual(["Page", "Release 3.21"]);
    expect(await view(page).locator('[data-slot="thread-tab-title"]').textContent()).toBe("Release 3.21");
    expect(await view(page).getByRole("link", { name: "Open thread" }).getAttribute("href")).toBe(`/threads/${seeded.release}`);
    // Its own composer, to write to its manager.
    await view(page).getByPlaceholder("Message the manager…").waitFor();
    await card.locator('[data-slot="handoff-target"]').click();
    expect((await icon.innerText()).trim()).toBe("Show in panel");
    await page.keyboard.press("Escape");
    await icon.waitFor({ state: "detached" });
    expect(await served()).toEqual([seeded.release]);
    await look(page, "desktop-thread-tab");

    // After a reload: the same tab, shown.
    await page.reload();
    await view(page).getByText(REPLY).waitFor();
    expect(await threadTab(page, seeded.release).getAttribute("aria-selected")).toBe("true");

    // A worker of the thread at work has its row above the composer; it
    // opens on the thread's page, which has the workers' panel.
    await page.route("**/api/agents/active-wakes", (route) => route.fulfill({ json: {
      wakes: [{ threadId: seeded.workerThread, wakeId: "wake_w1", scope: "worker", scopeId: seeded.workerId, startedAt: new Date().toISOString() }]
    } }));
    await page.reload();
    await view(page).locator('[data-slot="worker-strip-row"]').click();
    await page.locator(`[data-slot="worker-panel"] [data-worker-tab="${seeded.workerId}"][aria-selected="true"]`).waitFor();
    expect(new URL(page.url()).pathname).toBe(`/threads/${seeded.release}`);
  } finally {
    await page.context().close();
  }
}, 60_000);

test("the + opens an open thread beside the personal agent, ticking those open; a sidebar row's ⋯ and a thread page's ⋯ open one and go there; Close closes it on the server", async () => {
  await closeAll();
  const page = await open("/agent");
  try {
    await page.locator('[data-slot="handoff-card"]').waitFor();
    const plus = page.getByRole("button", { name: "Open a thread beside Juno" });
    await plus.click();
    const items = page.getByRole("menuitem");
    await items.first().waitFor();
    expect(await items.allTextContents()).toEqual(expect.arrayContaining(["Release 3.21", "CI speed-up", "Docs layout"]));
    await items.filter({ hasText: "CI speed-up" }).click();
    await threadTab(page, seeded.ci).and(page.locator('[aria-selected="true"]')).waitFor();
    await plus.click();
    await page.getByRole("menuitem").filter({ hasText: "CI speed-up" }).locator('[aria-label="Open"]').waitFor();
    expect(await page.getByRole("menuitem").filter({ hasText: "Docs layout" }).locator('[aria-label="Open"]').count()).toBe(0);
    await page.keyboard.press("Escape");

    // A sidebar row's ⋯, from another page: in sight on hover only.
    await page.goto(`${server.baseUrl}/home`);
    const row = page.locator('[data-slot="app-nav"] [data-thread-title="Docs layout"]').locator("xpath=..");
    const more = row.getByRole("button", { name: "Actions for Docs layout" });
    await more.waitFor({ state: "attached" });
    expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe("0");
    await row.hover();
    await page.waitForFunction((el) => getComputedStyle(el!).opacity === "1", await more.elementHandle());
    await more.click();
    await page.getByRole("menuitem", { name: "Open beside Juno" }).click();
    await page.waitForURL(`${server.baseUrl}/agent`);
    await threadTab(page, seeded.docs).and(page.locator('[aria-selected="true"]')).waitFor();
    expect(await tabs(page).allTextContents()).toEqual(["Page", "CI speed-up", "Docs layout"]);

    // The thread page's ⋯.
    await page.goto(`${server.baseUrl}/threads/${seeded.release}`);
    await page.getByRole("button", { name: "Thread actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Open beside Juno" }).click();
    await page.waitForURL(`${server.baseUrl}/agent`);
    await view(page).getByText(REPLY).waitFor();
    expect(await served()).toEqual([seeded.ci, seeded.docs, seeded.release]);

    // Close: gone here and on the server, and the tab before it shows.
    await threadTab(page, seeded.release).getByRole("button", { name: "Close Release 3.21" }).click();
    await threadTab(page, seeded.docs).and(page.locator('[aria-selected="true"]')).waitFor();
    expect(await served()).toEqual([seeded.ci, seeded.docs]);
  } finally {
    await page.context().close();
  }
}, 60_000);

test("on a phone the threads open beside the personal agent are tabs of its panel; a drawer row's ⋯ opens one there", async () => {
  await closeAll();
  await fetch(`${server.baseUrl}/api/agents/personal/thread-tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: seeded.ci }) });
  const page = await open("/agent", PHONE);
  try {
    await page.getByRole("tablist", { name: "View" }).getByRole("tab", { name: "Panel" }).tap();
    await threadTab(page, seeded.ci).tap();
    await view(page).getByPlaceholder("Message the manager…").waitFor();
    await look(page, "phone-page-view");

    // The drawer's rows each have their ⋯, always in sight.
    await page.goto(`${server.baseUrl}/home`);
    await page.getByRole("button", { name: "Open navigation" }).tap();
    const drawer = page.getByRole("dialog");
    const more = drawer.getByRole("button", { name: "Actions for Release 3.21" });
    await more.waitFor();
    expect(await more.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await look(page, "phone-drawer");
    await more.tap();
    await page.getByRole("menuitem", { name: "Open beside Juno" }).tap();
    await page.waitForURL(`${server.baseUrl}/agent`);
    await view(page).getByText(REPLY).waitFor();
    // The drawer closes with its 200 ms exit; the thread can be drawn sooner.
    await drawer.waitFor({ state: "detached", timeout: 2_000 });
    expect(await threadTab(page, seeded.release).getAttribute("aria-selected")).toBe("true");
  } finally {
    await page.context().close();
  }
}, 60_000);

// On a phone the panel has its tab row from the start, as on a desktop:
// its + opens a thread beside the agent with none open yet. No Hide page in
// it: the bar's Chat goes back.
test("on a phone the panel's + opens a thread beside the agent from the start", async () => {
  for (const colorScheme of ["light", "dark"] as const) {
    await closeAll();
    const page = await open("/agent", { ...PHONE, colorScheme });
    try {
      await page.getByRole("tablist", { name: "View" }).getByRole("tab", { name: "Panel" }).tap();
      expect(await tabs(page).allTextContents()).toEqual(["Page"]);
      expect(await page.getByRole("button", { name: "Hide page" }).count()).toBe(0);
      const plus = page.getByRole("button", { name: "Open a thread beside Juno" });
      await plus.tap();
      const item = page.getByRole("menuitem", { name: "CI speed-up" });
      await item.waitFor();
      // The menu stays on the phone's screen.
      const menu = (await page.locator('[role="menu"]').boundingBox())!;
      expect(menu.x).toBeGreaterThanOrEqual(0);
      expect(menu.x + menu.width).toBeLessThanOrEqual(390.5);
      await look(page, `phone-page-plus-${colorScheme}`, { animations: "disabled" });
      await item.tap();
      await threadTab(page, seeded.ci).and(page.locator('[aria-selected="true"]')).waitFor();
      expect(await served()).toEqual([seeded.ci]);
      await look(page, `phone-page-plus-opened-${colorScheme}`, { animations: "disabled" });
    } finally {
      await page.context().close();
    }
  }
}, 60_000);

test("at half a screen's width the thread tabs are in the panel; an archived thread's tab is read-only", async () => {
  await closeAll();
  for (const threadId of [seeded.ci, seeded.docs]) {
    await fetch(`${server.baseUrl}/api/agents/personal/thread-tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) });
  }
  const archived = await fetch(`${server.baseUrl}/api/agents/manager/threads/${seeded.docs}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
  expect(archived.status).toBe(200);
  const page = await open("/agent", { viewport: { width: 720, height: 900 } });
  try {
    await page.getByRole("tablist", { name: "View" }).getByRole("tab", { name: "Panel" }).click();
    expect(await tabs(page).allTextContents()).toEqual(["Page", "CI speed-up", "Docs layout"]);
    await threadTab(page, seeded.docs).click();
    await view(page).locator('[data-slot="archived-note"]').waitFor();
    expect(await view(page).getByPlaceholder("Message the manager…").count()).toBe(0);
    await look(page, "half-archived");
  } finally {
    await page.context().close();
  }
}, 60_000);

test("a panel too narrow for its tabs lists them all at its end, the + beside the list; one chosen there shows in sight", async () => {
  await closeAll();
  for (const threadId of [seeded.release, seeded.ci, seeded.docs]) {
    await fetch(`${server.baseUrl}/api/agents/personal/thread-tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId }) });
  }
  const context = await browser.newContext(DESKTOP);
  // A narrow panel: the three threads' tabs do not fit beside Page.
  await context.addInitScript(() => {
    if (window.top !== window) return;
    localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, maximized: false, ratio: 0.3, tabs: [], active: "page" }, version: 0 }));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  attachPageDiagnostics(page);
  try {
    await page.goto(`${server.baseUrl}/agent`);
    const allTabs = page.getByRole("button", { name: "All tabs" });
    await allTabs.waitFor();
    expect(await allTabs.textContent()).toBe("4");
    // The + is in sight, at the row's end rather than after the scrolled tabs.
    const plus = page.getByRole("button", { name: "Open a thread beside Juno" });
    const row = page.locator('[role="tablist"][aria-label="Page tabs"]');
    expect(await plus.evaluate((el) => el.closest('[role="tablist"]') === null)).toBe(true);
    const [plusBox, panelBox] = [await plus.boundingBox(), await page.locator('[data-slot="agent-page"]').boundingBox()];
    expect(plusBox!.x + plusBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width);
    await look(page, "narrow-row");

    await allTabs.click();
    const menu = page.locator('[data-slot="all-tabs-menu"]');
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Page", "Release 3.21", "CI speed-up", "Docs layout"]);
    await look(page, "narrow-row-list");
    // Its × closes that tab only: nothing is chosen, and the list stays open.
    await menu.getByRole("button", { name: "Close CI speed-up" }).click();
    await waitUntil(async () => (await menu.getByRole("menuitem").count()) === 3, { timeout: 5_000, interval: 50, label: "the closed tab to leave the list" });
    expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Page", "Release 3.21", "Docs layout"]);
    expect(await served()).toEqual([seeded.release, seeded.docs]);
    expect(await page.locator('[role="tablist"][aria-label="Page tabs"] [aria-selected="true"]').textContent()).toBe("Page");
    await menu.getByRole("menuitem", { name: "Docs layout" }).click();
    await threadTab(page, seeded.docs).and(page.locator('[aria-selected="true"]')).waitFor();
    await settle(page);
    // Scrolled into the row's sight.
    const [tabBox, rowBox] = [await threadTab(page, seeded.docs).boundingBox(), await row.boundingBox()];
    expect(tabBox!.x).toBeGreaterThanOrEqual(rowBox!.x - 1);
    expect(tabBox!.x + tabBox!.width).toBeLessThanOrEqual(rowBox!.x + rowBox!.width + 1);
  } finally {
    await context.close();
  }
}, 60_000);

// The personal agent's tabs in the order the person dragged them into:
// a thread opened beside the agent (the server's, every device's)
// moved before Tasks (this browser's), kept after a reload; another browser
// keeps its own order.
test("a thread tab beside the personal agent dragged before Tasks stays there after a reload, and another browser keeps its own order", async () => {
  await closeAll();
  await fetch(`${server.baseUrl}/api/agents/personal/thread-tabs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId: seeded.release }) });
  const withTasks = () => {
    if (window.top !== window) return;
    if (localStorage.getItem("mandate.agent-page.v1")) return;
    localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, ratio: 0.5, tabs: ["tasks"], active: "page" }, version: 0 }));
  };
  const openWithTasks = async () => {
    const context = await browser.newContext(DESKTOP);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    attachPageDiagnostics(page);
    await page.addInitScript(withTasks);
    await page.goto(`${server.baseUrl}/agent`);
    await threadTab(page, seeded.release).waitFor();
    await page.locator('[role="tablist"][aria-label="Page tabs"] [data-tasks-tab]').waitFor();
    return page;
  };
  const kinds = (page: Page) => tabs(page).evaluateAll((all) => all.map((tab) => tab.getAttribute("data-thread-tab") ?? (tab.hasAttribute("data-tasks-tab") ? "tasks" : "first")));
  const page = await openWithTasks();
  try {
    expect(await kinds(page)).toEqual(["first", "tasks", seeded.release]);
    const from = (await threadTab(page, seeded.release).boundingBox())!;
    const to = (await page.locator('[role="tablist"][aria-label="Page tabs"] [data-tasks-tab]').boundingBox())!;
    const y = from.y + from.height / 2;
    await page.mouse.move(from.x + from.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 - 10, y, { steps: 3 });
    await page.mouse.move(to.x + to.width * 0.2, y, { steps: 12 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("[data-carried]") === null);
    expect(await kinds(page)).toEqual(["first", seeded.release, "tasks"]);
    await page.reload();
    await threadTab(page, seeded.release).waitFor();
    await page.locator('[role="tablist"][aria-label="Page tabs"] [data-tasks-tab]').waitFor();
    expect(await kinds(page)).toEqual(["first", seeded.release, "tasks"]);
    // Kept in this browser only: another has the row as opened.
    const other = await openWithTasks();
    try {
      expect(await kinds(other)).toEqual(["first", "tasks", seeded.release]);
    } finally {
      await other.context().close();
    }
  } finally {
    await page.context().close();
    await closeAll();
  }
}, 60_000);

// Two rows can draw a tab of one id: a file open beside the personal agent
// and in a thread's panel, the agent's page kept (hidden) while the thread's
// shows. A drag is the row's it was pressed in.
test("a file open beside the personal agent and in a thread's panel is dragged in the thread's panel, the row it was pressed in", async () => {
  await closeAll();
  const files = ["file:/tmp/e2e-panel-notes-a.md", "file:/tmp/e2e-panel-notes-b.md"];
  const both = ({ thread, files }: { thread: string; files: string[] }) => {
    if (window.top !== window) return;
    if (localStorage.getItem("mandate.agent-page.v1")) return;
    localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, ratio: 0.5, tabs: files, active: "page" }, version: 0 }));
    localStorage.setItem("mandate.worker-panel.v3", JSON.stringify({ state: { byThread: { [thread]: { open: true, tabs: files, active: "workers", workerTab: {} } } }, version: 0 }));
  };
  const context = await browser.newContext(DESKTOP);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  attachPageDiagnostics(page);
  try {
    await page.addInitScript(both, { thread: seeded.release, files });
    await page.goto(`${server.baseUrl}/agent`);
    await page.locator('[role="tablist"][aria-label="Page tabs"] [data-file-tab="/tmp/e2e-panel-notes-b.md"]').waitFor();
    // In the app, not a load: the agent's page stays, hidden.
    await page.locator('[data-slot="app-nav"] [data-thread-title="Release 3.21"]').click();
    await page.waitForURL(`${server.baseUrl}/threads/${seeded.release}`);
    const panel = page.locator('[data-slot="worker-panel-side"] [role="tablist"][aria-label="Worker tabs"]');
    const fileTab = (path: string) => panel.locator(`[data-file-tab="${path}"]`);
    await fileTab("/tmp/e2e-panel-notes-b.md").waitFor();
    expect(await page.locator('[data-file-tab="/tmp/e2e-panel-notes-a.md"]').count()).toBe(2);
    const from = (await fileTab("/tmp/e2e-panel-notes-a.md").boundingBox())!;
    const to = (await fileTab("/tmp/e2e-panel-notes-b.md").boundingBox())!;
    const y = from.y + from.height / 2;
    await page.mouse.move(from.x + from.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 10, y, { steps: 3 });
    await page.mouse.move(to.x + to.width * 0.8, y, { steps: 12 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("[data-carried]") === null);
    expect(await panel.locator("[data-file-tab]").evaluateAll((all) => all.map((tab) => tab.getAttribute("data-file-tab")))).toEqual(["/tmp/e2e-panel-notes-b.md", "/tmp/e2e-panel-notes-a.md"]);
    // The agent's row is as it was.
    expect(await page.evaluate(() => (JSON.parse(localStorage.getItem("mandate.agent-page.v1") ?? "{}") as { state?: { order?: string[] } }).state?.order ?? null)).toBeNull();
  } finally {
    await context.close();
  }
}, 60_000);
