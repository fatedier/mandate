import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";

// Picking one day on the Overview, in a real browser whose clock is in
// Shanghai: the bars are Shanghai's dates, a bar picks its day, the chip
// steps and clears it, and the log opened from it lists that day's calls.
// Invented threads and hosts; sample rates.

let server: RunningServer;
const browser = browserForFile();
const WAIT_MS = 8_000;
const TEST_TIMEOUT_MS = 20_000;
const ZONE = "Asia/Shanghai";
const DAY = 86_400_000;
const CLAUDE = "anthropic/claude-e2e";
const ref = JSON.stringify({ origin: "litellm", providerId: "anthropic", providerName: "anthropic", modelId: "claude-e2e", dataDate: new Date().toISOString().slice(0, 10) });

/** UTC midnight `back` days ago, plus `hours`: an instant whose Shanghai date
 *  is the next UTC date once `hours` passes 16. */
const at = (back: number, hours: number) => new Date(Date.parse(`${new Date(Date.now() - back * DAY).toISOString().slice(0, 10)}T00:00:00.000Z`) + hours * 3_600_000).toISOString();
const shanghaiDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** Three days back, three calls (the late one is the next date in
 *  Shanghai), and one a day back: $3, $4 and $3 on three Shanghai dates. */
const CALLS = [
  { id: "llm_pick_a", at: at(3, 2), micros: 1_000_000 },
  { id: "llm_pick_b", at: at(3, 8), micros: 2_000_000 },
  { id: "llm_pick_late", at: at(3, 17.5), micros: 4_000_000 },
  { id: "llm_pick_c", at: at(1, 6), micros: 3_000_000 }
];

function seed(dataDir: string): void {
  fs.mkdirSync(path.join(dataDir, "prices"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "prices", "litellm.json"), JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    entries: { "claude-e2e": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } } } }
  }));
  const store = new MandateStore(dataDir);
  try {
    store.db.prepare("insert into agent_threads (id, scope, title, created_at, updated_at) values ('thr-pick', 'manager', 'Invented manager', ?, ?)").run(at(4, 0), at(4, 0));
    const insert = store.db.prepare(`
      insert into llm_calls (id, purpose, scope_type, scope_id, provider, provider_name, model, base_url, request_hash, response_hash, metadata_json,
        input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, status, started_at, finished_at, latency_ms,
        created_at, updated_at, cost_source, cost_micros, cost_ref)
      values (?, 'agent_wake_step', 'agent_thread', 'thr-pick', 'anthropic', 'gw', ?, 'https://gw.example.test/v1', 'req', 'res', '{"providerName":"gw"}',
        1000, 100, 1100, 0, 0, 'succeeded', ?, ?, 2000, ?, ?, 'list', ?, ?)
    `);
    for (const c of CALLS) insert.run(c.id, CLAUDE, c.at, c.at, c.at, c.at, c.micros, ref);
  } finally {
    store.db.close();
  }
}

beforeAll(async () => {
  server = await startServer({ configured: true, seed });
});

afterAll(() => {
  server?.cleanup();
});

async function open(viewport: { width: number; height: number }, phone = false): Promise<Page> {
  const page = await browser.newPage({ viewport, timezoneId: ZONE, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  attachPageDiagnostics(page);
  page.setDefaultTimeout(WAIT_MS);
  await page.goto(`${server.baseUrl}/activity`);
  await page.locator("[data-spend-day]").first().waitFor();
  return page;
}

const spendFigure = (page: Page) => page.locator('[data-slot="activity-total"]').first().locator("div").first().textContent();
/** The spend figure once it reads `text`: the day's answer arrives after the click. */
async function spendReads(page: Page, text: string): Promise<string | null> {
  await page.waitForFunction((want) => document.querySelector('[data-slot="activity-total"] div')?.textContent === want, text).catch(() => {});
  return spendFigure(page);
}
const picked = (page: Page) => new URL(page.url()).searchParams.get("day");

test("the bars are the reader's dates, a bar picks its day, and the chip steps and clears it", async () => {
  const page = await open({ width: 1280, height: 1000 });
  try {
    const lateDate = shanghaiDate(CALLS[2]!.at);
    const firstDate = shanghaiDate(CALLS[0]!.at);
    // The late call is a date of its own in Shanghai, with its own spend.
    await page.locator(`[data-spend-day="${lateDate}"]`).click();
    await page.locator('[data-slot="activity-day-chip"]').waitFor();
    expect(picked(page)).toBe(lateDate);
    expect(await spendReads(page, "~$4.00")).toBe("~$4.00");
    expect(await page.locator(`[data-spend-day="${lateDate}"]`).getAttribute("aria-pressed")).toBe("true");

    await page.getByRole("button", { name: "Previous day" }).click();
    expect(picked(page)).toBe(firstDate);
    expect(await spendReads(page, "~$3.00")).toBe("~$3.00");

    await page.getByRole("button", { name: "Show all 30 days" }).click();
    await page.locator('[data-slot="activity-day-chip"]').waitFor({ state: "detached" });
    expect(picked(page)).toBe(null);
    expect(await page.locator('[data-slot="activity-day-chip"]').count()).toBe(0);
    expect(await spendReads(page, "~$10.00")).toBe("~$10.00");
  } finally {
    await page.close();
  }
}, TEST_TIMEOUT_MS);

test("the log opened from a picked day lists that day's calls, cut in the reader's zone", async () => {
  const page = await open({ width: 1280, height: 1000 });
  try {
    const lateDate = shanghaiDate(CALLS[2]!.at);
    await page.locator(`[data-spend-day="${lateDate}"]`).click();
    await page.locator('[data-slot="activity-day-chip"]').waitFor();
    await page.getByRole("link", { name: /Open logs/ }).click();
    await page.locator("[data-log-row]").first().waitFor();
    expect(new URL(page.url()).searchParams.get("day")).toBe(lateDate);
    expect(await page.locator("[data-log-row]").count()).toBe(1);
  } finally {
    await page.close();
  }
}, TEST_TIMEOUT_MS);

test("on a phone a tap picks the day, and nothing scrolls sideways", async () => {
  const page = await open({ width: 390, height: 844 }, true);
  try {
    const date = shanghaiDate(CALLS[3]!.at);
    await page.locator(`[data-spend-day="${date}"]`).tap();
    await page.locator('[data-slot="activity-day-chip"]').waitFor();
    expect(picked(page)).toBe(date);
    expect(await spendReads(page, "~$3.00")).toBe("~$3.00");
    expect(await pageOverflow(page)).toEqual([]);
  } finally {
    await page.close();
  }
}, TEST_TIMEOUT_MS);
