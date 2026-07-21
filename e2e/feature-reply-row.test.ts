import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
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
const FEATURE_NAME = "research-chat-tool-timestamps";
/** Matches the seed's first line, which is what the row should be showing. */
const FIRST_LINE = "PARA-00";
/** Only ever in the body, so its presence tells the row from the dialog. */
const LAST_LINE = "PARA-11";
/** A reply that needs no affordance, seeded alongside the long one. */
const SHORT_FEATURE = "short-feature";

let server: RunningServer;
let browser: Browser;

beforeAll(async () => {
  server = await startServer({
    configured: true,
    seed: (dataDir) => {
      seedFeatureReply(dataDir, { featureName: FEATURE_NAME, paragraphs: 12 });
      // Both cases into one instance. Booting a second server inside a test
      // races freePort() against the one already up, and a failure earlier in
      // the file then shows up here as an unrelated red.
      seedFeatureReply(dataDir, { featureName: SHORT_FEATURE, paragraphs: 0 });
    }
  });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  server?.cleanup();
});

async function openChat(): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  attachPageDiagnostics(page);
  await page.goto(server.baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.setItem("mandate.chat.drawerOpen.v1", "true"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText(FEATURE_NAME, { exact: false }).first().waitFor({ timeout: 15_000 });
  return page;
}

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
    const height = await page.evaluate((feature) => {
      const label = [...document.querySelectorAll("span")].find(
        (node) => node.textContent?.trim() === feature
      );
      const row = label?.closest("div.my-1") as HTMLElement | null;
      return row?.getBoundingClientRect().height ?? null;
    }, FEATURE_NAME);
    expect(height).not.toBeNull();
    expect(height!).toBeLessThan(80);
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

test("a reply short enough to read stays in the row", async () => {
  // One line, well under the inline limit: an affordance here would open onto
  // nothing the reader cannot already see.
  const page = await openChat();
  try {
    await page.getByText(SHORT_FEATURE, { exact: false }).first().waitFor({ timeout: 15_000 });
    expect(await visible(page, "Acknowledged.")).toBe(true);
    // The long reply above it still has one, so a zero here is this row's
    // doing rather than the affordance having gone missing everywhere.
    expect(await page.getByRole("button", { name: "View reply" }).count()).toBe(1);
  } finally {
    await page.close();
  }
});
