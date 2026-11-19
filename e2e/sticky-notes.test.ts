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
import { StickyNotesService } from "../src/server/modules/sticky-notes/sticky-notes-service.js";

/**
 * The personal agent's sticky notes through the compiled server: the Notes
 * page and its count on the sidebar, a long body opened with More, Done and
 * Restore, the Notes tab beside the agent, and a phone.
 */

const browser = browserForFile();
let server: RunningServer;
const ids: Record<string, string> = {};

beforeAll(async () => {
  server = await startServer({
    configured: true,
    label: "sticky-notes",
    seed(dataDir) {
      const configFile = path.join(dataDir, "config.json");
      const config = flatFromFile(JSON.parse(fs.readFileSync(configFile, "utf8"))) as Record<string, any>;
      config.agent = { ...config.agent, personalAgentName: "Juno" };
      fs.writeFileSync(configFile, JSON.stringify(fileFromFlat(config), null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const board = new TaskBoardService({ db: store.db, agentStore: agents, sse: { emit: () => {} } as never, threadDots: () => new Map() });
        const personal = agents.getOrCreatePersonalThread();
        agents.appendMessage({ threadId: personal.id, role: "user", source: "user", content: { type: "text", text: "Watch the oven alarms for me." } });
        const last = agents.appendMessage({ threadId: personal.id, role: "assistant", source: "self", content: { type: "assistant", text: "The spike rule fired: 40 oven alarms in an hour, from one kitchen." } });
        agents.markThreadSeen(personal.id, last.seq);
        const thread = agents.createManagerThread("Oven alarms watch");
        const task = board.create({ title: "Rotate staging keys" }, "owner");
        const notes = new StickyNotesService({
          db: store.db, sse: { emit: () => {} } as never,
          about: (ref) => (ref.kind === "thread" ? agents.getThreadById(ref.id)?.title ?? null : board.detail(ref.id)?.title ?? null)
        });
        const done = notes.add({ title: "Nightly docs pass finished", body: "Nothing to do.", kind: "fyi" });
        notes.done(done.id);
        const removed = notes.add({ title: "Old flour order reminder", body: "Stale.", kind: "later" });
        notes.remove(removed.id, "you placed it, as you said in chat.");
        ids.removed = removed.id;
        const fyi = notes.add({ title: "Two docs changes merged overnight", body: "Both changed only Markdown; worth a glance.", kind: "fyi" });
        notes.markSeen([fyi]);
        ids.code = notes.add({ title: "The failing query", body: ["```sql", ...Array.from({ length: 12 }, (_, n) => `select ${n + 1} from t;`), "```"].join("\n"), kind: "fyi" }).id;
        ids.cjk = notes.add({ title: "花园浇水".repeat(30), body: "记得给温室里的番茄苗浇水施肥。".repeat(40), kind: "later" }).id;
        ids.check = notes.add({ title: "Staging keys rotated, waiting for you to check", body: "New keys are live on staging; the old ones go in 24 hours.", kind: "check", taskId: task.id }).id;
        ids.alert = notes.add({ title: "The spike rule fired", body: "40 oven alarms between 14:10 and 15:00 from one kitchen: `door left open`.", kind: "alert", threadId: thread.id }).id;
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
  const drawn = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.emulateMedia({ colorScheme: "light" });
  await drawn();
  await look(page, `${name}-light`, { animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await drawn();
  await look(page, `${name}-dark`, { animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
}

const card = (page: Page, id: string) => page.locator(`[data-slot="sticky-note"][data-note-id="${id}"]`).first();

test("the Notes page: a wall of paper by kind in both themes, its count on the sidebar gone once seen, long words and code kept inside", async () => {
  const page = await open({ width: 1440, height: 900 }, "/home");
  try {
    const nav = page.locator('a[data-slot="notes-nav"]');
    await nav.waitFor({ timeout: 15_000 });
    await nav.locator('[role="img"][aria-label="4 items to look at"]').waitFor({ timeout: 10_000 });
    await nav.click();
    await card(page, ids.alert!).waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-slot="sticky-note"]').count()).toBe(5);
    expect(await page.locator('[data-slot="notes-count"]').textContent()).toBe("5 notes");
    // Shown on a page in front: seen, so the sidebar's count goes; the tape stays while the page does.
    await nav.locator('[role="img"]').waitFor({ state: "detached", timeout: 10_000 });
    expect(await page.locator('[data-slot="sticky-note"][data-new]').count()).toBe(4);
    // A wall: several columns here, newest change first.
    const lefts = await page.locator('[data-slot="sticky-note"]').evaluateAll((all) => [...new Set(all.map((el) => Math.round(el.getBoundingClientRect().left)))].length);
    expect(lefts).toBeGreaterThanOrEqual(3);
    expect(await page.locator('[data-slot="sticky-note"]').first().getAttribute("data-note-id")).toBe(ids.alert!);
    // Nothing spills: long unbroken words wrap and clamp; a code block is cut at the body's height.
    const spills = await page.locator('[data-slot="sticky-note"]').evaluateAll((all) => all.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.getAttribute("data-note-id")));
    expect(spills).toEqual([]);
    const cjk = card(page, ids.cjk!);
    const titleLines = await cjk.locator('[data-slot="sticky-note-title"]').evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(titleLines).toBe(2);
    const bodyCut = await card(page, ids.code!).locator('[data-slot="sticky-note-body"]').evaluate((el) => ({ height: el.getBoundingClientRect().height, lines: parseFloat(getComputedStyle(el).lineHeight), hidden: el.scrollHeight > el.clientHeight }));
    expect(bodyCut.height).toBeLessThanOrEqual(bodyCut.lines * 5 + 2);
    expect(bodyCut.hidden).toBe(true);
    expect(await pageOverflow(page)).toEqual([]);
    // A long body opens whole with More and closes with Less; a short one offers neither.
    const cjkBody = cjk.locator('[data-slot="sticky-note-body"]');
    const cjkId = ids.cjk!;
    expect(await card(page, ids.alert!).getByRole("button", { name: "More" }).count()).toBe(0);
    await cjk.getByRole("button", { name: "More" }).click();
    expect(await cjkBody.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) * 6)).toBe(true);
    // Its neighbours keep their own height, not stretched to it.
    const heights = await page.locator('[data-slot="sticky-note"]').evaluateAll((all) => all.map((el) => [el.getAttribute("data-note-id"), Math.round(el.getBoundingClientRect().height)] as const));
    const opened = heights.find(([id]) => id === cjkId)![1];
    expect(heights.filter(([id]) => id !== cjkId).every(([, h]) => h < opened / 2)).toBe(true);
    await lookBoth(page, "notes-more");
    await cjk.getByRole("button", { name: "Less" }).click();
    expect(await cjkBody.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // Each kind's paper and label, in each theme.
    const inks = () => page.locator('[data-slot="sticky-note"]').evaluateAll((all) => Object.fromEntries(all.map((el) => [el.getAttribute("data-kind"), {
      paper: getComputedStyle(el).getPropertyValue("--note-paper").trim(),
      band: getComputedStyle(el).getPropertyValue("--note-band").trim(),
      label: getComputedStyle(el.querySelector('[data-slot="sticky-note-kind"]')!).color
    }])));
    expect(await inks()).toEqual({
      alert: { paper: "#fcecec", band: "#fcecec", label: "rgb(180, 35, 24)" },
      check: { paper: "#eeedfc", band: "#eeedfc", label: "rgb(74, 80, 214)" },
      fyi: { paper: "#e7f4ec", band: "#e7f4ec", label: "rgb(26, 122, 72)" },
      later: { paper: "#f8f0de", band: "#f8f0de", label: "rgb(138, 101, 22)" }
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    expect(await inks()).toEqual({
      alert: { paper: "#262021", band: "#4a2a2d", label: "rgb(255, 166, 173)" },
      check: { paper: "#212126", band: "#33324f", label: "rgb(188, 186, 255)" },
      fyi: { paper: "#1e2320", band: "#1d3d2d", label: "rgb(128, 218, 172)" },
      later: { paper: "#24211c", band: "#42321a", label: "rgb(232, 188, 120)" }
    });
    await page.emulateMedia({ colorScheme: "light" });
    await lookBoth(page, "notes-page");
  } finally {
    await page.close();
  }
}, 60_000);

test("Done takes a note off the wall into Done; Restore brings back one the agent removed", async () => {
  const page = await open({ width: 1440, height: 900 }, "/notes");
  try {
    const fyiTitle = "Two docs changes merged overnight";
    const fyi = page.locator('[data-slot="sticky-note"]', { hasText: fyiTitle });
    await fyi.waitFor({ timeout: 15_000 });
    await fyi.hover();
    await fyi.getByRole("button", { name: "Done" }).click();
    await fyi.waitFor({ state: "detached", timeout: 10_000 });
    await page.getByRole("button", { name: "Show done (3)" }).click();
    const rows = page.locator('[data-slot="sticky-note-done-row"]');
    await rows.first().waitFor();
    expect(await rows.locator('[data-slot="sticky-note-done-title"]').allTextContents()).toEqual([fyiTitle, "Old flour order reminder", "Nightly docs pass finished"]);
    expect(await rows.nth(1).locator('[data-slot="sticky-note-done-when"]').textContent()).toMatch(/^Removed by Juno \d\d:\d\d: you placed it, as you said in chat\.$/);
    await lookBoth(page, "notes-done");
    await rows.nth(1).getByRole("button", { name: "Restore" }).click();
    await card(page, ids.removed!).waitFor({ timeout: 10_000 });
    expect(await page.getByRole("button", { name: "Show done (2)" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Hide done" }).count()).toBe(1);
  } finally {
    await page.close();
  }
}, 60_000);

test("the agent's page: + Notes opens the wall beside the chat", async () => {
  const page = await open({ width: 1440, height: 900 }, "/agent");
  try {
    await page.getByRole("button", { name: "Open a thread beside Juno" }).waitFor({ timeout: 15_000 });
    await page.getByText("The spike rule fired: 40 oven alarms in an hour").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Open a thread beside Juno" }).click();
    await page.getByRole("menuitem", { name: /^Notes/ }).click();
    const panel = page.locator('[data-slot="notes-panel"]');
    await panel.locator('[data-slot="sticky-note"]').first().waitFor({ timeout: 10_000 });
    const width = await panel.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(500);
    expect(await panel.locator('[data-slot="sticky-note"]').evaluateAll((all) => [...new Set(all.map((el) => Math.round(el.getBoundingClientRect().left)))].length)).toBe(2);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "notes-panel");
    // A card offers Done alone: nothing takes the user elsewhere.
    const alert = panel.locator(`[data-note-id="${ids.alert}"]`);
    await alert.hover();
    expect(await alert.locator("button").evaluateAll((all) => all.map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim()))).toEqual(["Done"]);
  } finally {
    await page.close();
  }
}, 90_000);

test("phone: one column, Done without a hover, and the drawer and the agent's menu reach Notes", async () => {
  const page = await open({ width: 390, height: 844 }, "/agent");
  try {
    await page.getByText("The spike rule fired: 40 oven alarms in an hour").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Agent actions" }).click();
    await page.getByRole("menuitem", { name: "Notes" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator('a[data-slot="notes-nav"]').click();
    await card(page, ids.alert!).waitFor({ timeout: 15_000 });
    const lefts = await page.locator('[data-slot="sticky-note"]').evaluateAll((all) => [...new Set(all.map((el) => Math.round(el.getBoundingClientRect().left)))]);
    expect(lefts.length).toBe(1);
    const done = card(page, ids.alert!).getByRole("button", { name: "Done" });
    expect(await done.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe("1");
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "notes-phone");
  } finally {
    await page.close();
  }
}, 90_000);
