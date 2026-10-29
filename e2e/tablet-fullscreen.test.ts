import { expect, test } from "bun:test";
import type { BrowserContextOptions, Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { browserForFile } from "./helpers/browser";

// A touch screen wide enough for the desktop layout (a tablet, an unfolded
// foldable) has no drawer: its full-screen toggle sits in the sidebar's
// header beside Collapse, and below Expand on the collapsed rail. A mouse
// gets none — the browser and the desktop shell have their own.
const browser = browserForFile();

const TOUCH: BrowserContextOptions = { viewport: { width: 900, height: 700 }, isMobile: true, hasTouch: true };
const MOUSE_NARROW: BrowserContextOptions = { viewport: { width: 900, height: 700 } };
const MOUSE_WIDE: BrowserContextOptions = { viewport: { width: 1440, height: 900 } };

async function open(device: BrowserContextOptions) {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
  await page.locator('[data-slot="sidebar-header"]').waitFor();
  return { page, close: async () => { await context.close(); fixture.stop(); } };
}

const press = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).tap();

test("on a touch screen the sidebar header's toggle enters and leaves full screen", async () => {
  const { page, close } = await open(TOUCH);
  try {
    const header = page.locator('[data-slot="sidebar-header"]');
    expect(await header.getByRole("button", { name: "Full screen", exact: true }).count()).toBe(1);
    await press(page, "Full screen");
    await page.waitForFunction(() => document.fullscreenElement !== null);
    await header.getByRole("button", { name: "Exit full screen" }).waitFor();
    await press(page, "Exit full screen");
    await page.waitForFunction(() => document.fullscreenElement === null);
    await header.getByRole("button", { name: "Full screen", exact: true }).waitFor();
  } finally {
    await close();
  }
}, 30_000);

test("on a touch screen the collapsed rail keeps the toggle", async () => {
  const { page, close } = await open(TOUCH);
  try {
    await press(page, "Collapse sidebar");
    await page.getByRole("button", { name: "Expand sidebar" }).waitFor();
    await press(page, "Full screen");
    await page.waitForFunction(() => document.fullscreenElement !== null);
    await page.getByRole("button", { name: "Exit full screen" }).waitFor();
  } finally {
    await close();
  }
}, 30_000);

for (const [where, device] of [["900px", MOUSE_NARROW], ["1440px", MOUSE_WIDE]] as const) {
  test(`with a mouse at ${where} the sidebar offers no full-screen toggle`, async () => {
    const { page, close } = await open(device);
    try {
      expect(await page.getByRole("button", { name: /full screen/i }).count()).toBe(0);
      await page.getByRole("button", { name: "Collapse sidebar" }).click();
      await page.getByRole("button", { name: "Expand sidebar" }).waitFor();
      expect(await page.getByRole("button", { name: /full screen/i }).count()).toBe(0);
      // The rail's slot for it takes no room: the nav starts right under the header.
      const gap = await page.evaluate(() => {
        const header = document.querySelector('[data-slot="sidebar-header"]')!.getBoundingClientRect();
        const nav = document.querySelector('[data-slot="sidebar-header"] ~ nav')!.getBoundingClientRect();
        return Math.round(nav.top - header.bottom);
      });
      expect(gap).toBe(0);
    } finally {
      await close();
    }
  }, 30_000);
}
