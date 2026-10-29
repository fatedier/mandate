import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { MandateStore } from "../src/server/app/store.js";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";

// Money in Activity, end to end: calls recorded with no cost are priced by
// the server's pass (every 5 s) from the saved price data, Activity shows
// what each cost and the total, and an Unpriced call's "Set a price" leads to
// its model's dialog, where a price set re-prices that call.

let server: RunningServer;
const browser = browserForFile();

/** Long enough for the first pricing pass after boot and one after a save
 *  (5 s apart), with room for a loaded machine. */
const TEST_TIMEOUT_MS = 45_000;
const WAIT_MS = 8_000;
const PRICED_WITHIN_MS = 15_000;

const GATEWAY = "https://gw.example.test/v1";
const PLAN = "https://plan.example.test/v1";

/** Four calls, one per way a cost is known: reported by the gateway, the
 *  list price of a model the price data knows, a model nothing prices, and
 *  a connection billed as a plan. */
const CALLS = [
  { id: "llm_price_reported", providerType: "openai-compatible", providerName: "gw", model: "acme-routed", baseURL: GATEWAY, input: 4_000, output: 300, reported: 8_100 },
  { id: "llm_price_list", providerType: "openai", providerName: "openai", model: "gpt-5.5", baseURL: "https://api.openai.com/v1", input: 100_000, output: 2_000, reported: null },
  { id: "llm_price_unpriced", providerType: "openai-compatible", providerName: "gw", model: "acme-large", baseURL: GATEWAY, input: 10_000, output: 1_000, reported: null },
  { id: "llm_price_plan", providerType: "openai-compatible", providerName: "team-plan", model: "plan-model", baseURL: PLAN, input: 20_000, output: 500, reported: null }
] as const;

function seed(dataDir: string): void {
  const configFile = path.join(dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as { models: { providers: Record<string, unknown> } };
  config.models.providers.gw = {
    type: "openai-compatible",
    baseURL: GATEWAY,
    apiKey: "not-a-real-key",
    models: [{ id: "acme-large", input: ["text"] }]
  };
  config.models.providers["team-plan"] = {
    type: "openai-compatible",
    baseURL: PLAN,
    apiKey: "not-a-real-key",
    billing: "plan",
    models: [{ id: "plan-model", input: ["text"] }]
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  // The saved copy of LiteLLM's list, as a download leaves it (sample rates):
  // nothing ships with Mandate, and nothing is downloaded under test.
  fs.mkdirSync(path.join(dataDir, "prices"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "prices", "litellm.json"), JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    entries: { "gpt-5.5": { provider: "openai", rates: { base: { input: 5, output: 30, cacheRead: 0.5 } } } }
  }));

  const store = new MandateStore(dataDir);
  try {
    const insert = store.db.prepare(`
      insert into llm_calls (
        id, purpose, scope_type, scope_id, provider, provider_name, model, base_url,
        metadata_json, input_tokens, output_tokens, total_tokens,
        reported_cost_micros, reported_cost_field,
        status, started_at, finished_at, latency_ms, ttft_ms, created_at, updated_at
      ) values (?, 'agent_wake_step', 'agent_thread', 'thread-e2e', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'succeeded', ?, ?, 1200, 300, ?, ?)
    `);
    const now = Date.now();
    CALLS.forEach((call, index) => {
      const startedAt = new Date(now - (index + 1) * 60_000).toISOString();
      const finishedAt = new Date(Date.parse(startedAt) + 1_200).toISOString();
      insert.run(
        call.id, call.providerType, call.providerName, call.model, call.baseURL,
        JSON.stringify({ providerName: call.providerName }),
        call.input, call.output, call.input + call.output,
        call.reported, call.reported === null ? null : "usage.cost",
        startedAt, finishedAt, startedAt, finishedAt
      );
    });
  } finally {
    store.db.close();
  }
}

beforeAll(async () => {
  server = await startServer({ configured: true, seed });
});

afterAll(async () => {
  server?.cleanup();
});

async function openPage(pathname: string, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  attachPageDiagnostics(page);
  page.setDefaultTimeout(WAIT_MS);
  await page.goto(`${server.baseUrl}${pathname}`);
  return page;
}

/** The Spend tile once the pass has priced every seeded call: Activity
 *  reads on load, so it is opened again until then. */
async function pricedSpendTile(page: Page): Promise<string> {
  const deadline = Date.now() + PRICED_WITHIN_MS;
  for (;;) {
    const tile = page.locator('[data-slot="activity-total"]').first();
    await tile.waitFor();
    const text = (await tile.textContent()) ?? "";
    if (!text.includes("not priced yet") || Date.now() > deadline) return text;
    await page.waitForTimeout(500);
    await page.reload();
  }
}

/** A Logs row, by the call's model. */
function rowOf(page: Page, model: string) {
  return page.locator("[data-log-row]").filter({ has: page.locator("[data-log-model]", { hasText: new RegExp(`^${model}$`) }) });
}

/** A Logs row's amount. */
function costOf(page: Page, model: string) {
  return rowOf(page, model).locator("[data-log-cost]");
}

test("on a phone: the spend, an Unpriced call and its Set a price fit the screen", async () => {
  const page = await openPage("/activity", { width: 390, height: 844 });
  try {
    const tile = await pricedSpendTile(page);
    expect(tile).toContain("~$0.57");
    expect(tile).toContain("$0.0081 reported · 1 call unpriced · 1 included");
    expect(await pageOverflow(page)).toEqual([]);

    await page.goto(`${server.baseUrl}/activity?tab=logs`);
    expect((await costOf(page, "acme-large").textContent())?.trim()).toBe("Unpriced");
    expect(await pageOverflow(page)).toEqual([]);
    await rowOf(page, "acme-large").click();
    const cost = page.locator("[data-call-cost]");
    await cost.waitFor();
    expect(await cost.textContent()).toContain("No price for acme-large on gw");
    expect(await pageOverflow(page)).toEqual([]);

    await cost.getByRole("link", { name: "Set a price" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Your price" }).waitFor();
    expect(await dialog.textContent()).toContain("acme-large");
    await dialog.getByRole("radio", { name: "Your price" }).click();
    await dialog.locator('input[aria-label="1-hour cache write"]').waitFor();
    expect(await pageOverflow(page)).toEqual([]);
  } finally {
    await page.close();
  }
}, TEST_TIMEOUT_MS);

test("on a desktop: Activity shows each call's amount, and a price set for an Unpriced model re-prices its call", async () => {
  const page = await openPage("/activity", { width: 1440, height: 900 });
  try {
    const tile = await pricedSpendTile(page);
    expect(tile).toContain("~$0.57");
    expect(tile).toContain("$0.0081 reported · 1 call unpriced · 1 included");
    expect(await pageOverflow(page)).toEqual([]);

    await page.goto(`${server.baseUrl}/activity?tab=logs`);
    const amounts = async () => Object.fromEntries(await Promise.all(
      ["acme-routed", "gpt-5.5", "acme-large", "plan-model"].map(async (model) => [model, (await costOf(page, model).textContent())?.trim()])
    ));
    expect(await amounts()).toEqual({ "acme-routed": "$0.0081", "gpt-5.5": "~$0.56", "acme-large": "Unpriced", "plan-model": "Included" });
    expect(await pageOverflow(page)).toEqual([]);

    await rowOf(page, "acme-large").click();
    await page.locator("[data-call-cost]").getByRole("link", { name: "Set a price" }).click();
    expect(new URL(page.url()).searchParams.get("provider")).toBe("gw");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Your price" }).click();
    await dialog.locator('input[aria-label="Input"]').fill("3");
    await dialog.locator('input[aria-label="Output"]').fill("15");
    expect(await pageOverflow(page)).toEqual([]);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });

    // 10,000 in at $3 and 1,000 out at $15 per 1M.
    const deadline = Date.now() + PRICED_WITHIN_MS;
    let seen = "";
    for (;;) {
      await page.goto(`${server.baseUrl}/activity?tab=logs`);
      seen = (await costOf(page, "acme-large").textContent())?.trim() ?? "";
      if (seen !== "Unpriced" || Date.now() > deadline) break;
      await page.waitForTimeout(500);
    }
    expect(seen).toBe("~$0.0450");
    // The reported call on the same connection keeps what the gateway said.
    expect((await costOf(page, "acme-routed").textContent())?.trim()).toBe("$0.0081");
  } finally {
    await page.close();
  }
}, TEST_TIMEOUT_MS);
