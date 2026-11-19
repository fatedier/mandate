import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics, look } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { expectFit, onPhone, startTouchHarness, stopTouchHarness } from "./helpers/touch-targets.js";
import { MandateStore } from "../src/server/app/store.js";
import { fileFromFlat, flatFromFile } from "../src/server/config/file-layout.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { CalendarStore } from "../src/server/modules/calendar/calendar-store.js";
import { CalendarService } from "../src/server/modules/calendar/calendar-service.js";

/**
 * The personal agent's calendar through the compiled server: the Calendar
 * page's four views, an entry's details with Pause, Resume and Delete, the
 * tab beside the agent, a phone, and an entry come due while Mandate was off
 * waking the agent with its row in the chat.
 */

const browser = browserForFile();
let server: RunningServer;
// The longest title an entry takes: 120 characters, in Han script, so three
// bytes each and wide on the page.
const LONG = "整理书架".repeat(30);
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Tomorrow at this local time, as the browser in this run sees it. */
function tomorrowAt(hour: number, minute = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour, minute);
}

beforeAll(async () => {
  await startTouchHarness({ server: false });
  server = await startServer({
    configured: true,
    label: "calendar",
    seed(dataDir) {
      const configFile = path.join(dataDir, "config.json");
      const config = flatFromFile(JSON.parse(fs.readFileSync(configFile, "utf8"))) as Record<string, any>;
      config.agent = { ...config.agent, personalAgentName: "Juno" };
      fs.writeFileSync(configFile, JSON.stringify(fileFromFlat(config), null, 2));
      const store = new MandateStore(dataDir);
      try {
        const agents = new AgentStore(store.db);
        const personal = agents.getOrCreatePersonalThread();
        const last = agents.appendMessage({ threadId: personal.id, role: "assistant", source: "self", content: { type: "assistant", text: "Your calendar is set up." } });
        agents.markThreadSeen(personal.id, last.seq);
        const entries = new CalendarStore(store.db);
        const calendar = new CalendarService({ store: entries, sse: { emit: () => {} } as never, timeZone: ZONE, deliver: () => () => {} });
        calendar.add({ title: "Daily check", note: "Look at last night's duty reports.", repeat: "0 9 * * *" });
        const nightly = calendar.add({ title: "Nightly", note: "Sum up the nightly runs.", repeat: "30 9 * * *" });
        calendar.pause(nightly.id, "user");
        calendar.add({ title: LONG, note: "Use the big mixer for the dough.", at: tomorrowAt(10).toISOString() });
        calendar.add({ title: "Long note", note: Array.from({ length: 45 }, (_, i) => `Step ${String(i + 1).padStart(2, "0")}: check the next schedule's runs.`).join("\n"), at: tomorrowAt(11).toISOString() });
        // Came due while Mandate was off: delivered, late, when it starts.
        const now = Date.now();
        entries.insert({
          id: "cal_lateAAAAAAA", title: "Weekly review of the schedules", note: "Read every schedule's runs and leave a sticky note.",
          atMs: now - 10 * 60_000, cron: null, timezone: ZONE, untilDay: null, pausedAt: null, pausedBy: null, skips: [],
          nextDueMs: now - 10 * 60_000, createdAt: now - 86_400_000, updatedAt: now - 86_400_000, deletedAt: null, deletedBy: null
        });
        calendar.dispose();
      } finally {
        store.db.close();
      }
    }
  });
}, 60_000);

afterAll(async () => {
  await stopTouchHarness();
  server?.cleanup();
});

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

const view = (page: Page) => page.locator('[data-slot="calendar-view"]').first();
const blockOf = (page: Page, title: string) => page.locator('[data-slot="calendar-block"]', { hasText: title }).first();
const details = (page: Page) => page.locator('[data-slot="calendar-details"]').first();

/** Each block lies inside its day's column. */
async function blocksInside(page: Page): Promise<string[]> {
  return page.locator('[data-slot="calendar-block"]').evaluateAll((all) => all.filter((el) => {
    const box = el.getBoundingClientRect();
    const column = el.closest('[data-slot="calendar-day-column"]')!.getBoundingClientRect();
    return box.left < column.left - 0.5 || box.right > column.right + 0.5;
  }).map((el) => el.textContent ?? ""));
}

test("the Calendar page: Week first, tomorrow's Day with its blocks, details with Pause, Resume and Delete, Month and List", async () => {
  const page = await open({ width: 1440, height: 900 }, "/home");
  try {
    const nav = page.locator('a[data-slot="calendar-nav"]');
    await nav.waitFor({ timeout: 15_000 });
    // After Notes in the sidebar, with no count.
    expect(await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[data-slot]')].map((a) => a.getAttribute("data-slot"));
      return links.indexOf("calendar-nav") === links.indexOf("notes-nav") + 1;
    })).toBe(true);
    await nav.click();
    await view(page).waitFor({ timeout: 10_000 });
    expect(await view(page).getAttribute("data-view")).toBe("week");
    await lookBoth(page, "calendar-week");
    // Tomorrow, whole, in Day.
    await page.getByRole("tab", { name: "Day" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await blockOf(page, "Daily check").waitFor({ timeout: 10_000 });
    expect(await blockOf(page, "Daily check").textContent()).toBe("09:00Daily check· Daily 09:00");
    expect(await blockOf(page, "Nightly").getAttribute("data-paused") !== null).toBe(true);
    expect(await blocksInside(page)).toEqual([]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "calendar-day");
    // A one-off's details: Delete asks, and can be cancelled.
    await blockOf(page, "整理书架").click();
    await details(page).waitFor();
    expect(await details(page).locator('[data-slot="calendar-details-title"]').textContent()).toBe(LONG);
    expect(await details(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.locator('[data-slot="calendar-details-popover"]').evaluate((el) => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth + 0.5;
    })).toBe(true);
    await lookBoth(page, "calendar-details");
    await details(page).getByRole("button", { name: "Delete" }).click();
    expect(await details(page).locator('[data-slot="calendar-details-ask"] p').textContent()).toBe(`Delete "${LONG}"? This can't be undone.`);
    await details(page).getByRole("button", { name: "Cancel" }).click();
    await details(page).getByRole("button", { name: "Close" }).click();
    await details(page).waitFor({ state: "detached" });
    // A long note scrolls inside the popover, which stays in the window beside
    // a block as wide as the day, its actions reached.
    await blockOf(page, "Long note").click();
    const popover = page.locator('[data-slot="calendar-details-popover"]');
    await popover.waitFor();
    expect(await popover.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return {
        inside: box.top >= 0 && box.bottom <= window.innerHeight + 0.5 && box.left >= 0 && box.right <= window.innerWidth + 0.5,
        scrolls: el.scrollHeight > el.clientHeight
      };
    })).toEqual({ inside: true, scrolls: true });
    await popover.getByRole("button", { name: "Delete" }).scrollIntoViewIfNeeded();
    expect(await popover.getByRole("button", { name: "Delete" }).isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached" });
    // The grid scrolled with details open: they move with their block at
    // every step, not only when something else draws the page again.
    await blockOf(page, "Daily check").click();
    await popover.waitFor();
    // Opened at 07:30, the day's grid has room to scroll up.
    const steps = await page.evaluate(async () => {
      const grid = document.querySelector<HTMLElement>('[data-slot="calendar-grid-scroll"]')!;
      const block = [...document.querySelectorAll('[data-slot="calendar-block"]')].find((el) => el.textContent?.includes("Daily check"))!;
      const shown = () => document.querySelector('[data-slot="calendar-details-popover"]')!.getBoundingClientRect().top;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const out: Array<[number, number]> = [];
      for (let i = 0; i < 5; i++) {
        const [b0, p0] = [block.getBoundingClientRect().top, shown()];
        grid.scrollTop -= 20;
        await frame();
        await frame();
        out.push([Math.round(block.getBoundingClientRect().top - b0), Math.round(shown() - p0)]);
      }
      return out;
    });
    expect(steps).toEqual(Array.from({ length: 5 }, () => [20, 20]));
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached" });
    // The paused one resumes; its block is drawn plain once the page fetches again.
    await blockOf(page, "Nightly").click();
    await details(page).getByRole("button", { name: "Resume" }).click();
    await page.locator('[data-slot="calendar-block"]:not([data-paused])', { hasText: "Nightly" }).waitFor({ timeout: 10_000 });
    await page.keyboard.press("Escape");
    // One time of a repeat deleted alone: gone from the page, the others kept.
    await blockOf(page, "Daily check").click();
    await details(page).getByRole("button", { name: "Delete" }).click();
    await details(page).getByRole("button", { name: "Only this one" }).click();
    await blockOf(page, "Daily check").waitFor({ state: "detached", timeout: 10_000 });
    await page.getByRole("button", { name: "Next" }).click();
    await blockOf(page, "Daily check").waitFor({ timeout: 10_000 });
    // Month and List.
    await page.getByRole("tab", { name: "Month" }).click();
    await page.locator('[data-slot="calendar-chip"]').first().waitFor({ timeout: 10_000 });
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "calendar-month");
    await page.getByRole("tab", { name: "List" }).click();
    await page.locator('[data-slot="calendar-list-row"]').first().waitFor({ timeout: 10_000 });
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "calendar-list");
  } finally {
    await page.close();
  }
}, 90_000);

test("an entry come due while Mandate was off wakes the agent: its row in the chat reads Calendar and its title", async () => {
  const page = await open({ width: 1440, height: 900 }, "/agent");
  try {
    const row = page.locator('[data-slot="provenance-label"]', { hasText: "Calendar" }).first();
    await row.waitFor({ timeout: 20_000 });
    expect(await page.locator('[data-slot="provenance-detail"]', { hasText: "Weekly review of the schedules" }).count()).toBeGreaterThan(0);
  } finally {
    await page.close();
  }
}, 60_000);

test("the agent's page: + Calendar opens the calendar beside the chat, at the panel's width", async () => {
  const page = await open({ width: 1440, height: 900 }, "/agent");
  try {
    await page.getByRole("button", { name: "Open a thread beside Juno" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Open a thread beside Juno" }).click();
    await page.getByRole("menuitem", { name: /^Calendar/ }).click();
    const panel = page.locator('[data-slot="calendar-panel"]');
    await panel.locator('[data-slot="calendar-view"][data-place="panel"]').waitFor({ timeout: 10_000 });
    // The long title's one-off is tomorrow: on a Sunday, in next week's Week.
    if (new Date().getDay() === 0) await panel.getByRole("button", { name: "Next" }).click();
    await panel.locator('[data-slot="calendar-block"]', { hasText: "整理书架" }).first().waitFor({ timeout: 10_000 });
    const width = await panel.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(500);
    expect(width).toBeLessThan(760);
    expect(await blocksInside(page)).toEqual([]);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "calendar-panel");
  } finally {
    await page.close();
  }
}, 90_000);

test("phone: List first, a row's details in a sheet, Month as dots, and the drawer and the agent's menu reach the calendar", async () => {
  const page = await open({ width: 390, height: 844 }, "/agent");
  try {
    await page.getByText("Your calendar is set up.").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Agent actions" }).click();
    await page.getByRole("menuitem", { name: "Calendar" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator('a[data-slot="calendar-nav"]').click();
    await view(page).waitFor({ timeout: 15_000 });
    expect([await view(page).getAttribute("data-place"), await view(page).getAttribute("data-view")]).toEqual(["phone", "list"]);
    const row = page.locator('[data-slot="calendar-list-row"]').first();
    await row.waitFor({ timeout: 10_000 });
    expect(await pageOverflow(page)).toEqual([]);
    // The four views all show, none scrolled out of the row or faded at its edge.
    const tabs = page.locator('[data-slot="calendar-toolbar"] [data-slot="page-tabs"]');
    expect(await tabs.evaluate((el) => ({ more: el.getAttribute("data-more"), at: el.scrollLeft }))).toEqual({ more: null, at: 0 });
    await lookBoth(page, "calendar-phone-list");
    // A tap opens the row it lands on: a touch area spilling onto the next row opened that one.
    const tapped = (await row.locator("span").nth(2).textContent()) ?? "";
    await row.tap();
    await page.locator('[data-slot="calendar-details-sheet"] [data-slot="calendar-details"]').waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-slot="calendar-details-title"]').textContent()).toBe(tapped);
    await lookBoth(page, "calendar-phone-sheet");
    await page.locator('[data-slot="calendar-details"]').getByRole("button", { name: "Close" }).click();
    await page.getByRole("tab", { name: "Month" }).click();
    await page.locator('[data-slot="calendar-dots"] i').first().waitFor({ timeout: 10_000 });
    expect(await page.locator('[data-slot="calendar-chip"]').count()).toBe(0);
    expect(await pageOverflow(page)).toEqual([]);
    await lookBoth(page, "calendar-phone-month");
  } finally {
    await page.close();
  }
}, 90_000);

test("phone: each control of the calendar is 44 by 44 to a finger and none overlap, in List, an entry's sheet and Month", async () => {
  const list = await onPhone(`${server.baseUrl}/calendar`, '[data-slot="calendar-list-row"]');
  expectFit("calendar list", list);
  const sheet = await onPhone(`${server.baseUrl}/calendar`, '[data-slot="calendar-list-row"]', async (page) => {
    await page.locator('[data-slot="calendar-list-row"]').first().tap();
    await page.locator('[data-slot="calendar-details-sheet"] [data-slot="calendar-details"]').waitFor();
  });
  expectFit("calendar entry sheet", sheet);
  const month = await onPhone(`${server.baseUrl}/calendar`, '[data-slot="calendar-list-row"]', async (page) => {
    await page.getByRole("tab", { name: "Month" }).tap();
    await page.locator('[data-slot="calendar-dots"] i').first().waitFor();
  });
  expectFit("calendar month", month);
}, 90_000);
