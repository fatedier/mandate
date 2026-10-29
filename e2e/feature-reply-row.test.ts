import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { seedFeatureReply, startServer, type RunningServer } from "./helpers/server.js";

/**
 * A feature reply is the worker's whole closing turn, forwarded up to
 * 20k characters, so at full length it buries the manager conversation it is
 * answering — and it sat among rows that are all a single line. The transcript
 * shows its first line and opens the rest.
 *
 * Only a real engine can say whether that held: the row and the dialog are
 * distinguished by what is on screen and what is not, and happy-dom lays
 * nothing out.
 */

const VIEWPORT = { width: 1280, height: 900 };
const FEATURE_NAME = "research-row-timestamps";
/** Matches the seed's first line, which is what the row should be showing. */
const FIRST_LINE = "PARA-00";
/** Only ever in the body, so its presence tells the row from the dialog. */
const LAST_LINE = "PARA-11";
/** A reply that needs no affordance, seeded alongside the long one. */
const SHORT_FEATURE = "short-feature";
/** A worker whose turn failed before it said anything. Its reason holds a
 *  run with nowhere to break (no space, hyphen or slash), wider than the
 *  column: only a browser says whether that breaks or pushes the transcript
 *  sideways. */
const FAILED_FEATURE = "failed-feature";
const FAILED_REASON = `Checksum mismatch for ${"0123456789abcdef".repeat(9)}`;

let server: RunningServer;
const browser = browserForFile();
let threadId = "";

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      threadId = seedFeatureReply(dataDir, { featureName: FEATURE_NAME, paragraphs: 12 });
      // Both cases into one instance: a second server booted inside a test
      // would turn a failure earlier in the file into an unrelated red here.
      seedFeatureReply(dataDir, { featureName: SHORT_FEATURE, paragraphs: 0 });
      seedFeatureReply(dataDir, {
        featureName: FAILED_FEATURE,
        ended: { text: `The worker's turn failed: ${FAILED_REASON}`, outcome: "error", detail: FAILED_REASON }
      });
    }
  });
});

afterAll(async () => {
  server?.cleanup();
});

async function openChat(): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  attachPageDiagnostics(page);
  await page.goto(`${server.baseUrl}/threads/${threadId}`);
  // Found by its first line, not its worker's name: a reply names its worker
  // only when the thread has more than one.
  await longReply(page).waitFor({ timeout: 15_000 });
  return page;
}

const longReply = (page: Page) => page.locator('[data-slot="worker-reply"]').filter({ hasText: FIRST_LINE }).first();

const visible = (page: Page, needle: string) =>
  page.evaluate((text) => document.body.innerText.includes(text), needle);

test("the row shows the reply's first line and nothing below it", async () => {
  const page = await openChat();
  try {
    // The opening line is the summary, so it is on screen...
    expect(await visible(page, FIRST_LINE)).toBe(true);
    // ...and the rest of the reply is not, which is the whole point.
    expect(await visible(page, LAST_LINE)).toBe(false);

    // And the row stays a row: a reply must not be taller than the rows it
    // sits among by more than its own two lines.
    const height = (await longReply(page).boundingBox())?.height ?? null;
    expect(height).not.toBeNull();
    expect(height!).toBeLessThan(80);
    // Two workers replied in this thread, so each reply names its worker.
    expect(await longReply(page).innerText()).toContain(FEATURE_NAME);
  } finally {
    await page.close();
  }
});

test("opening the reply shows the part the row withheld", async () => {
  const page = await openChat();
  try {
    await page.getByRole("button", { name: "View reply" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });

    // The tail is reachable now, and the dialog is what is carrying it.
    expect(await dialog.innerText()).toContain(LAST_LINE);
    expect(await dialog.innerText()).toContain(FEATURE_NAME);

    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
    // Closing puts it back out of sight rather than leaving it in the flow.
    expect(await visible(page, LAST_LINE)).toBe(false);
  } finally {
    await page.close();
  }
});

// A turn that ended with no words for its manager was drawn as "Worker
// replied" over the server's sentence, with View reply once it was long.
// It says what happened, over the reason alone, shown whole.
test("a worker whose turn failed reads Worker failed over the reason, whole and inside the column", async () => {
  const page = await openChat();
  try {
    const row = page.locator('[data-slot="worker-reply"][data-outcome="error"]');
    await row.waitFor({ timeout: 15_000 });
    expect((await row.innerText()).replace(/\s+/g, " ")).toBe(`Worker failed ${FAILED_FEATURE} ${FAILED_REASON}`);
    // The sentence is the manager's model's; no reader is shown it.
    expect(await visible(page, "The worker's turn failed")).toBe(false);
    // Nothing to open: the long reply's is still the page's only one.
    expect(await page.getByRole("button", { name: "View reply" }).count()).toBe(1);

    const box = await row.evaluate((el) => {
      const column = el.closest<HTMLElement>('[data-slot="transcript-column"]')!;
      const body = el.querySelector<HTMLElement>('[data-slot="worker-reply-body"]')!;
      const lineHeight = parseFloat(getComputedStyle(body).lineHeight);
      return {
        lines: Math.round(body.getBoundingClientRect().height / lineHeight),
        pastColumn: Math.round(el.getBoundingClientRect().right - column.getBoundingClientRect().right),
        bodyOverflows: body.scrollWidth > body.clientWidth + 1,
        pageOverflows: document.documentElement.scrollWidth > window.innerWidth
      };
    });
    // The reason took more than one line, or its width proved nothing.
    expect(box.lines).toBeGreaterThan(1);
    expect(box.pastColumn).toBeLessThanOrEqual(0);
    expect(box.bodyOverflows).toBe(false);
    expect(box.pageOverflows).toBe(false);
  } finally {
    await page.close();
  }
});
