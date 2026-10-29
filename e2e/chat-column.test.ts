import { expect, test } from "bun:test";
import path from "node:path";
import type { Page } from "playwright";
import { startWorkspaceFixture, THREAD_ID, WORKER_PATH } from "./helpers/workspace-fixture";
import { artifactDir } from "./helpers/diagnostics";
import { browserForFile } from "./helpers/browser";
import { trackPageErrors } from "./helpers/page-diagnostics";

/**
 * The transcript and the composer under it share one column: the same left
 * and right edges at any desktop width, so a bubble never runs past the
 * composer. The composer once capped itself at 760px inside an 880px chat,
 * which left it 32px short on each side of a manager thread with the
 * workers hidden at 1440, and 60px short in a worker's chat. With classic
 * scrollbars the transcript's takes width from its own box, so both boxes
 * keep the same stable gutter, which overlay scrollbars leave at zero. Each
 * case runs with headless Chromium's hidden scrollbars, classic ones, and
 * overlay ones. Measured here because happy-dom has no layout.
 */

const browsers = {
  hidden: browserForFile(),
  classic: browserForFile({ ignoreDefaultArgs: ["--hide-scrollbars"] }),
  overlay: browserForFile({ ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--enable-features=OverlayScrollbar"] })
};

async function edges(page: Page, scope = "body") {
  return page.evaluate((scope) => {
    const root = document.querySelector(scope)!;
    const box = (selector: string) => {
      const rect = root.querySelector(selector)!.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right) };
    };
    const column = root.querySelector('[data-slot="transcript-column"]')!;
    const scroller = column.parentElement!;
    return {
      transcript: box('[data-slot="transcript-column"]'),
      composer: box('[data-slot="composer"]'),
      scrollbar: scroller.offsetWidth - scroller.clientWidth,
      scrolls: scroller.scrollHeight > scroller.clientHeight
    };
  }, scope);
}

const cases = [
  { label: "manager thread, workers hidden, 1440", width: 1440, worker: false },
  { label: "manager thread, workers hidden, 1100", width: 1100, worker: false },
  { label: "worker chat, 1440", width: 1440, worker: true }
];

// Headless Chromium's hidden scrollbars take no width, as overlay ones do: the
// overlay run covers them.
for (const [scrollbars, browser] of Object.entries(browsers).filter(([name]) => name !== "hidden")) for (const { label, width, worker } of cases) {
  test(`the composer lines up with the transcript (${label}, ${scrollbars} scrollbars)`, async () => {
    const fixture = startWorkspaceFixture();
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    try {
      if (worker) {
        await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
        await page.getByRole("tab", { name: "Chat", exact: true }).first().click();
        await page.getByPlaceholder("Message the worker…").waitFor();
      } else {
        await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}`);
        await page.getByPlaceholder("Message the manager…").waitFor();
        const hide = page.locator('[data-slot="panel-toggle"][aria-label="Hide panel"]');
        if (await hide.count()) await hide.click();
        await page.locator('[data-slot="panel-toggle"][aria-label="Show panel"]').waitFor();
      }
      await page.locator('[data-slot="transcript-column"]').waitFor();
      const seen = await edges(page);
      await page.screenshot({ path: path.join(artifactDir("chat-column"), `${label.replace(/[^a-z0-9]+/gi, "-")}-${scrollbars}.png`) });
      // The worker chat's history overflows, so a classic scrollbar is drawn
      // and takes width: the case the shared gutter is for.
      if (worker) expect(seen.scrolls).toBe(true);
      if (scrollbars === "classic") expect(seen.scrollbar).toBeGreaterThan(0);
      if (scrollbars === "overlay") expect(seen.scrollbar).toBe(0);
      // The column is capped, not the full window: otherwise the check is
      // only that two full-width boxes agree.
      expect(seen.transcript.right - seen.transcript.left).toBeLessThan(width - 200);
      expect(seen.composer).toEqual(seen.transcript);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
      fixture.stop();
    }
  }, 20_000);
}

test("a tall draft in a short window keeps the composer's controls reachable", async () => {
  // The gutter box hides overflow, and a flex item that hides overflow may
  // shrink below its content: it once clipped the Send row out of reach.
  const fixture = startWorkspaceFixture();
  const page = await browsers.classic.newPage({ viewport: { width: 1440, height: 400 } });
  page.setDefaultTimeout(8000);
  const errors = trackPageErrors(page);
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await page.getByRole("tab", { name: "Chat", exact: true }).first().click();
    const draft = page.getByPlaceholder("Message the worker…");
    await draft.fill(Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long draft.`).join("\n"));
    const clipped = await page.evaluate(() => {
      const box = document.querySelector('[data-slot="composer"]')!.parentElement!.parentElement!;
      return box.scrollHeight - box.clientHeight;
    });
    await page.screenshot({ path: path.join(artifactDir("chat-column"), "tall-draft-short-window.png") });
    expect(clipped).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Send message" }).click({ trial: true, timeout: 3000 });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

/**
 * The chat owns its gutters, 16px on a phone and 28px from 768px, applied
 * once: a worker page, panel or sheet cancels its own padding around the
 * chat. Before, a phone's worker chat sat inside the page's 16px plus the
 * list's 28px (302px of text where a thread had 334), and its composer kept
 * a 12px gutter of its own (16px wider than the text on each side).
 */
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function openWorkerChat(page: Page, scope?: string) {
  const root = scope ? page.locator(scope) : page;
  await root.getByRole("tab", { name: "Chat", exact: true }).first().click();
  await page.getByText("Message 35.", { exact: false }).first().waitFor();
}

const phoneCases = [
  { label: "manager thread", url: () => `/threads/${THREAD_ID}`, scope: "body", open: async (page: Page) => { await page.getByPlaceholder("Message the manager…").waitFor(); } },
  { label: "worker page", url: () => WORKER_PATH, scope: "body", open: (page: Page) => openWorkerChat(page) },
  // The thread's own chat stays mounted under the sheet: measure the sheet's.
  { label: "worker sheet", url: () => `/threads/${THREAD_ID}?worker=zoom-worker`, scope: '[data-slot="worker-sheet"]', open: (page: Page) => openWorkerChat(page, '[data-slot="worker-sheet"]') }
];

for (const { label, url, scope, open } of phoneCases) {
  test(`on a phone the chat keeps 16px each side, text and composer alike (${label})`, async () => {
    const fixture = startWorkspaceFixture();
    const context = await browsers.hidden.newContext(PHONE);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = trackPageErrors(page);
    try {
      await page.goto(`${fixture.baseUrl}${url()}`);
      await open(page);
      await page.locator(scope).locator('[data-slot="composer"]').waitFor();
      const seen = await edges(page, scope);
      await page.screenshot({ path: path.join(artifactDir("chat-column"), `phone-${label.replace(/[^a-z0-9]+/gi, "-")}.png`) });
      expect(seen.transcript).toEqual({ left: 16, right: 390 - 16 });
      expect(seen.composer).toEqual(seen.transcript);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
      fixture.stop();
    }
  }, 20_000);
}

test("on the desktop worker page the chat starts where the page's content does", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browsers.hidden.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
    await openWorkerChat(page);
    const seen = await page.evaluate(() => ({
      tabs: Math.round(document.querySelector('main [role="tablist"]')!.getBoundingClientRect().left),
      main: Math.round(document.querySelector("main")!.getBoundingClientRect().left),
      column: Math.round(document.querySelector('[data-slot="transcript-column"]')!.getBoundingClientRect().left)
    }));
    expect(seen.column - seen.main).toBe(28);
    expect(seen.column).toBe(seen.tabs);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

test("in a thread's worker panel the chat keeps 28px from the panel's edge", async () => {
  const fixture = startWorkspaceFixture();
  const page = await browsers.hidden.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${fixture.baseUrl}/threads/${THREAD_ID}?worker=zoom-worker`);
    await openWorkerChat(page, '[data-slot="worker-panel"]');
    const seen = await page.evaluate(() => {
      const panel = document.querySelector('[data-slot="worker-panel"]')!;
      return {
        // Its inner edge: the panel has a border on that side.
        panel: Math.round(panel.getBoundingClientRect().left + panel.clientLeft),
        column: Math.round(panel.querySelector('[data-slot="transcript-column"]')!.getBoundingClientRect().left),
        composer: Math.round(panel.querySelector('[data-slot="composer"]')!.getBoundingClientRect().left)
      };
    });
    expect(seen.column - seen.panel).toBe(28);
    expect(seen.composer).toBe(seen.column);
  } finally {
    await page.close();
    fixture.stop();
  }
}, 20_000);

// 768 is inside the band the bug lived in (768–959); the code does not branch
// within it.
for (const width of [768]) {
  test(`with a 20px default font the composer's gutter still matches the transcript's (${width})`, async () => {
    // Tailwind's md: is 48rem, which a 20px default font moves to 960px; a
    // px media query for one gutter and md: for the other once disagreed
    // between 768 and 959.
    const fixture = startWorkspaceFixture();
    const context = await browsers.hidden.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Page.setFontSizes", { fontSizes: { standard: 20 } });
      await page.goto(`${fixture.baseUrl}${WORKER_PATH}`);
      await openWorkerChat(page);
      expect(await page.evaluate(() => matchMedia("(min-width: 48rem)").matches)).toBe(false);
      const seen = await edges(page);
      expect(seen.composer).toEqual(seen.transcript);
    } finally {
      await context.close();
      fixture.stop();
    }
  }, 20_000);
}
