import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, workerPath } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";
import { look, trackPageErrors } from "./helpers/page-diagnostics";
import { settle, trackRequests } from "./helpers/settle";

// How full a worker's context is. A manager thread says it in its header; a
// worker said it nowhere. It need not be in sight all the time, so it is a
// line of the worker's menu, above Compact now: in a thread's panel and in a
// phone's sheet, and with nothing added to the tab row.
//
// The fixture's worker has nothing measured; the tests that want a figure
// give its conversation one (102k of 250k, 41%).

const browser = browserForFile();

async function measured(page: Page) {
  await page.route("**/api/agents/workers/*/thread*", async (route) => {
    const answer = await (await route.fetch()).json() as Record<string, unknown>;
    await route.fulfill({ json: { ...answer, contextUsage: { inputTokens: 102_000, budgetTokens: 250_000, updatedAt: "2026-09-13T00:00:00.000Z" } } });
  });
}

/** The worker's menu as drawn, once opened. */
async function menuOf(page: Page) {
  await page.locator('[role="menu"]').waitFor();
  await settle(page);
  return page.locator('[role="menu"]').evaluate((menu) => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const named = (name: string) => items.find((item) => item.textContent?.trim() === name)!;
    const line = menu.querySelector<HTMLElement>('[data-slot="context-line"]');
    const compact = named("Compact now");
    if (!line) return { says: null as string | null, items: items.map((item) => item.textContent?.trim()) };
    const meter = line.firstElementChild!;
    const within = box(menu);
    return {
      says: line.textContent,
      items: items.map((item) => item.textContent?.trim()),
      // Between the item above it and Compact now, touching neither.
      underRefresh: box(line).top >= box(named("Refresh panes")).bottom - 0.5,
      overCompact: box(line).bottom <= box(compact).top + 0.5,
      next: line.nextElementSibling === compact,
      // The meter starts where the items' icons do.
      meterAtIcons: Math.round((box(meter).left - box(compact.querySelector("svg")!).left) * 10) / 10,
      meterWidth: Math.round(box(meter).right - box(meter).left),
      fill: (meter.firstElementChild as HTMLElement).style.width,
      inside: box(line).left >= within.left - 0.5 && box(line).right <= within.right + 0.5,
      onScreen: within.left >= 0 && within.right <= window.innerWidth && within.top >= 0 && within.bottom <= window.innerHeight
    };
  });
}

const DRAWN = {
  says: "Context 41%", underRefresh: true, overCompact: true, next: true,
  meterAtIcons: 0, meterWidth: 36, fill: "41%", inside: true, onScreen: true
};

test("in a thread's panel the worker's menu says how full its context is, above Compact now; the tab row has no figure", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const requests = await trackRequests(page);
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await measured(page);
    await page.goto(`${fixture.baseUrl}${workerPath()}`);
    const tabs = page.locator('[data-slot="worker-tabs"]');
    await tabs.waitFor();
    // The panel opens on the worker's plan: its chat was never opened, and
    // the figure is there all the same (the view reads the conversation).
    await requests.idle();
    expect(await tabs.locator('[role="tab"][aria-selected="true"]').textContent()).not.toBe("Chat");
    expect(await page.getByPlaceholder("Message the worker").count()).toBe(0);
    // The thread's own figure stays in its header; the worker's tab row carries none.
    expect(await tabs.textContent()).not.toContain("%");
    await tabs.locator('[title="Worker actions"]').click();
    const seen = await menuOf(page);
    await look(page, "panel");
    expect(seen).toMatchObject(DRAWN);
    expect(seen.items).toContain("Compact now");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);

test("on a phone the worker's menu carries the line inside its width, and the tabs are as wide as before", async () => {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const requests = await trackRequests(page);
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await measured(page);
    await page.goto(`${fixture.baseUrl}${workerPath()}`);
    const tabs = page.locator('[data-slot="worker-tabs"]');
    await tabs.waitFor();
    await requests.idle();
    // The figure took nothing from the tabs: the row carries none, and the
    // tabs have all the room the menu leaves, nothing between them but the
    // 8px a touch screen keeps. (Whether all five fit 390px is the font's
    // to say: an Android phone's Roboto runs the row 2px past it, and the
    // row scrolls, as it does on a narrower phone.)
    const row = await tabs.evaluate((tabRow) => ({
      percent: tabRow.textContent?.includes("%") ?? false,
      between: tabRow.querySelector('[title="Worker actions"]')!.getBoundingClientRect().left - tabRow.querySelector('[role="tablist"]')!.getBoundingClientRect().right
    }));
    expect(row.percent).toBe(false);
    expect(row.between).toBeLessThanOrEqual(8.5);
    await tabs.locator('[title="Worker actions"]').tap();
    const seen = await menuOf(page);
    await look(page, "phone");
    expect(seen).toMatchObject(DRAWN);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    fixture.stop();
  }
}, 20_000);
