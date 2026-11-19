import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ScheduleStore } from "../src/server/modules/schedules/schedule-store.js";
import { waitUntil } from "../tests/helpers/wait.js";

/**
 * The On duty page through the compiled server: every duty thread with its
 * checks; Run now, Pause and Resume; Show in sidebar and Remove from
 * sidebar; on a desktop and a phone.
 */

const browser = browserForFile();
const DAY = 24 * 3_600_000;
let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    configured: true,
    label: "duty-page",
    seed(dataDir) {
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const schedules = new ScheduleStore(store.db);
        const at = new Date(Date.now() - DAY).toISOString();
        const duty = (title: string, name: string, brief: string, status: "active" | "paused") => {
          const thread = agents.createManagerThread(title);
          schedules.insert({
            threadId: thread.id, name, cron: "0 9 * * *", timezone: "UTC", checkScript: `echo '{"wake":false}'`, checkTimeoutMs: 60_000,
            brief, status, nextDueAt: status === "active" ? new Date(Date.now() + DAY).toISOString() : null
          }, at);
          schedules.ensureDutyThread(thread.id, "investigate", `${dataDir}/notes-${thread.id}`, at);
        };
        duty("Greenhouse sensor watch", "sensors", "Odd readings from the bed sensors.", "active");
        duty("Compost bin", "compost", "Fill level of the compost bin.", "paused");
        // A title as long as a thread's gets (60 characters), and a long brief.
        duty("Nightly seed count for every tray and pot in the potting hut", "seeds", "New pests on the leaves of every bed in the greenhouse, with the spray and dose each one needs.", "active");
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(() => { server?.cleanup(); });

async function open(viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport, ...(viewport.width < 768 ? { hasTouch: true, isMobile: true } : {}) });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}/duty`);
  await page.locator('[data-slot="duty-row"]').first().waitFor({ timeout: 15_000 });
  return page;
}

const row = (page: Page, title: string) => page.locator('[data-slot="duty-row"]', { hasText: title }).first();
const sidebarGroup = (page: Page) => page.locator('[role="group"][aria-label="On duty"]');

test("a long title or brief stays on its line inside the list, with room for the title, on a wide and a narrow desktop", async () => {
  // 768: a desktop window beside the sidebar, too narrow for the columns.
  for (const width of [1280, 1024, 768]) {
    const page = await open({ width, height: 800 });
    try {
      await page.waitForFunction(() => document.querySelector('[data-slot="duty-list"]')!.getBoundingClientRect().width > 0);
      const fits = await page.evaluate(() => {
        const list = document.querySelector('[data-slot="duty-list"]')!;
        const column = list.parentElement!.getBoundingClientRect();
        const title = [...document.querySelectorAll<HTMLElement>('[data-slot="duty-title"]')].find((t) => t.textContent!.startsWith("Nightly"))!;
        const box = title.getBoundingClientRect();
        return { list: list.getBoundingClientRect().right <= column.right + 1, oneLine: box.height < 24, room: box.width > 120 };
      });
      expect([width, fits]).toEqual([width, { list: true, oneLine: true, room: true }]);
      expect([width, await pageOverflow(page)]).toEqual([width, []]);
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("the page lists the duty threads; a check runs, pauses and resumes; a thread goes in and out of the sidebar", async () => {
  const page = await open({ width: 1440, height: 900 });
  try {
    expect(await page.locator('[data-slot="duty-row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-thread-id")))).toHaveLength(3);
    await row(page, "Greenhouse sensor watch").getByText("Odd readings from the bed sensors.").waitFor();
    await page.locator('[data-slot="duty-chip"]', { hasText: "All" }).getByText("3").waitFor();
    // The nav entry: no check is failing, so no count (nor a total on duty).
    expect(await page.locator('[data-slot="on-duty-nav"]').textContent()).toBe("On duty");
    // Run now: the check runs on the server and its outcome comes back over the stream.
    await row(page, "Greenhouse sensor watch").hover();
    await row(page, "Greenhouse sensor watch").getByRole("button", { name: "Run now" }).click();
    await row(page, "Greenhouse sensor watch").getByText("Run now · nothing new").waitFor({ timeout: 20_000 });
    // Pause, then Resume.
    await row(page, "Greenhouse sensor watch").getByRole("button", { name: "Pause" }).click();
    await row(page, "Greenhouse sensor watch").locator('[data-slot="duty-outcome"]', { hasText: "Paused" }).waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-slot="duty-chip"]', { hasText: "Paused" }).textContent()).toBe("Paused 2");
    await row(page, "Greenhouse sensor watch").getByRole("button", { name: "Resume" }).click();
    await row(page, "Greenhouse sensor watch").getByRole("button", { name: "Pause" }).waitFor({ timeout: 10_000 });
    // Into the sidebar from the row's menu, and out again.
    expect(await sidebarGroup(page).count()).toBe(0);
    await row(page, "Compost bin").hover();
    await row(page, "Compost bin").getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Show in sidebar" }).click();
    await sidebarGroup(page).getByText("Compost bin").waitFor({ timeout: 10_000 });
    await row(page, "Compost bin").getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Remove from sidebar" }).click();
    await waitUntil(async () => (await sidebarGroup(page).count()) === 0 || null, { timeout: 10_000, label: "the group gone" });
    // Pressing the row (not its title) shows its checks.
    await row(page, "Greenhouse sensor watch").locator('[data-slot="duty-last"]').click();
    await page.locator('[data-slot="duty-runs"]').getByText("Run now · nothing new").waitFor({ timeout: 10_000 });
    await look(page, "desktop");
    // The title opens the thread.
    await row(page, "Greenhouse sensor watch").locator('[data-slot="duty-title"]').click();
    await page.waitForURL(/\/threads\//, { timeout: 5_000 });
  } finally {
    await page.close();
  }

  const phone = await open({ width: 390, height: 844 });
  try {
    const card = row(phone, "Compost bin");
    // On a phone: ⋯ is always there, with Resume in it.
    await card.getByRole("button", { name: "More actions" }).click();
    await phone.getByRole("menuitem", { name: "Resume" }).waitFor({ timeout: 5_000 });
    await phone.keyboard.press("Escape");
    await phone.getByRole("menu").waitFor({ state: "detached", timeout: 5_000 });
    await card.locator('[data-slot="duty-outcome"]').click();
    await phone.locator('[data-slot="duty-runs"]').waitFor({ timeout: 5_000 });
    await look(phone, "phone");
    // The drawer carries the page's entry.
    await phone.getByRole("button", { name: "Open navigation" }).click();
    await phone.locator('[data-slot="on-duty-nav"]').waitFor({ timeout: 5_000 });
  } finally {
    await phone.close();
  }
}, 90_000);
