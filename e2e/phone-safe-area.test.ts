import { expect, test } from "bun:test";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID } from "./helpers/workspace-fixture";
import { settle } from "./helpers/settle";
import { browserForFile } from "./helpers/browser";

// In full screen on a phone with a camera cutout the page reaches under it,
// and env(safe-area-inset-top) says how far. The top bar and the drawer keep
// their controls below it; with no inset (Chrome's normal mode, where the
// address bar holds the top) nothing changes.
const browser = browserForFile();

const INSET = 40;

async function open(inset: number) {
  const fixture = startWorkspaceFixture();
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: inset, topMax: inset } });
  await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
  await page.getByRole("button", { name: "Open navigation" }).waitFor();
  return { page, close: async () => { await context.close(); fixture.stop(); } };
}

/** The top bar's box, its controls' boxes, and where the content starts. */
const topBar = (page: Page) => page.evaluate(() => {
  const header = document.querySelector("header")!;
  const box = header.getBoundingClientRect();
  const controls = [...header.querySelectorAll("button, a[href]")]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => { const r = el.getBoundingClientRect(); return { name: el.getAttribute("aria-label") ?? el.textContent?.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom) }; });
  return { top: Math.round(box.top), height: Math.round(box.height), bottom: Math.round(box.bottom), controls, main: Math.round(document.querySelector("main")!.getBoundingClientRect().top) };
});

test("without a safe area the top bar is 48px, its controls centred, as before", async () => {
  const { page, close } = await open(0);
  try {
    const bar = await topBar(page);
    expect({ top: bar.top, height: bar.height }).toEqual({ top: 0, height: 48 });
    expect(bar.controls.length).toBeGreaterThan(0);
    for (const c of bar.controls) expect({ name: c.name, centre: (c.top + c.bottom) / 2 }).toEqual({ name: c.name, centre: 24 });
    expect(bar.main).toBeGreaterThanOrEqual(bar.bottom);
  } finally {
    await close();
  }
}, 30_000);

test("under a 40px cutout the top bar grows by it and keeps its controls inside it, below the cutout", async () => {
  const { page, close } = await open(INSET);
  try {
    const bar = await topBar(page);
    expect({ top: bar.top, height: bar.height }).toEqual({ top: 0, height: 48 + INSET });
    for (const c of bar.controls) {
      expect({ name: c.name, belowCutout: c.top >= INSET, inside: c.bottom <= bar.bottom, centre: (c.top + c.bottom) / 2 })
        .toEqual({ name: c.name, belowCutout: true, inside: true, centre: INSET + 24 });
    }
    expect(bar.main).toBeGreaterThanOrEqual(bar.bottom);
  } finally {
    await close();
  }
}, 30_000);

test("under a 40px cutout the drawer's title, full-screen toggle and close sit below it", async () => {
  const { page, close } = await open(INSET);
  try {
    await page.getByRole("button", { name: "Open navigation" }).tap();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await settle(page);
    const tops = await dialog.evaluate((el) => {
      const top = (selector: string) => Math.round(el.querySelector(selector)!.getBoundingClientRect().top);
      return { title: top("h2"), toggle: top('[aria-label="Full screen"]'), close: top("button:has(> .sr-only)") };
    });
    for (const [name, y] of Object.entries(tops)) expect({ name, belowCutout: y >= INSET }).toEqual({ name, belowCutout: true });
  } finally {
    await close();
  }
}, 30_000);
