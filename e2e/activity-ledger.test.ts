import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { browserForFile } from "./helpers/browser.js";
import { attachPageDiagnostics } from "./helpers/page-diagnostics.js";
import { pageOverflow } from "./helpers/page-overflow.js";
import { startServer, type RunningServer } from "./helpers/server.js";
import { MandateStore } from "../src/server/app/store.js";

// The ledger's layouts and its path from the Overview to Logs, in a real
// browser against the built server. Invented threads and hosts; sample rates.

let server: RunningServer;
const browser = browserForFile();
const TEST_TIMEOUT_MS = 20_000;
const WAIT_MS = 8_000;

const MIN = 60_000;
const CLAUDE = "anthropic/claude-e2e";
const GPT = "openai/gpt-e2e";
const ref = (modelId: string, providerId: string) =>
  JSON.stringify({ origin: "litellm", providerId, providerName: providerId, modelId, dataDate: new Date().toISOString().slice(0, 10) });

interface Seeded {
  id: string;
  purpose?: string;
  scopeType?: string;
  thread?: string;
  model?: string;
  /** Minutes after the first call. */
  at: number;
  input?: number;
  read?: number;
  write?: number;
  micros?: number;
  wake?: string;
}

/** Three Cache expired calls, one Miss, one rebuild after a compaction, one
 *  GPT call not reused, a dream run: every verdict and section has a row. */
const CALLS: Seeded[] = [
  { id: "llm_led_m1_0", thread: "thr-release", at: 0, write: 100_000, micros: 520_000, wake: "wk-user" },
  { id: "llm_led_m1_1", thread: "thr-release", at: 10, input: 110_000, write: 110_000, micros: 580_000, wake: "wk-report" },
  { id: "llm_led_m1_2", thread: "thr-release", at: 12, input: 112_000, write: 112_000, micros: 590_000, wake: "wk-report" },
  { id: "llm_led_m1_c", purpose: "agent_compression", thread: "thr-release", at: 13, micros: 60_000 },
  { id: "llm_led_m1_3", thread: "thr-release", at: 14, write: 100_000, micros: 520_000, wake: "wk-report" },
  { id: "llm_led_m1_4", thread: "thr-release", at: 60, write: 100_000, micros: 520_000, wake: "wk-check" },
  { id: "llm_led_m2_0", thread: "thr-research", at: 0, write: 90_000, micros: 470_000, wake: "wk-alarm" },
  { id: "llm_led_m2_1", thread: "thr-research", at: 30, write: 95_000, micros: 495_000, wake: "wk-alarm" },
  { id: "llm_led_w_0", thread: "thr-worker", model: GPT, at: 0, read: 0, micros: 200_000, wake: "wk-watch" },
  { id: "llm_led_w_1", thread: "thr-worker", model: GPT, at: 120, read: 0, micros: 200_000, wake: "wk-watch" },
  { id: "llm_led_dream", purpose: "memory_dream", scopeType: "memory", thread: "global", model: GPT, at: 5, micros: 90_000 }
];

/** The managers' steps (By agent → Managers lists these and no others). */
const MANAGER_STEPS = CALLS.filter((c) => (c.thread === "thr-release" || c.thread === "thr-research") && (c.purpose ?? "agent_wake_step") === "agent_wake_step").length;
const EXPIRED_CALLS = 3;

function seed(dataDir: string): void {
  fs.mkdirSync(path.join(dataDir, "prices"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "prices", "litellm.json"), JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    entries: {
      "claude-e2e": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } } },
      "gpt-e2e": { provider: "openai", rates: { base: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } } }
    }
  }));
  const store = new MandateStore(dataDir);
  try {
    const base = Date.now() - 2 * 24 * 60 * MIN;
    const iso = (minutes: number) => new Date(base + minutes * MIN).toISOString();
    const thread = store.db.prepare("insert into agent_threads (id, scope, title, created_at, updated_at, archived_at) values (?, ?, ?, ?, ?, ?)");
    thread.run("thr-release", "manager", "Invented release", iso(0), iso(0), iso(200));
    thread.run("thr-research", "manager", "Invented research", iso(0), iso(0), iso(200));
    thread.run("thr-worker", "worker", "Invented worker", iso(0), iso(0), iso(200));
    const wake = store.db.prepare("insert into agent_wakes (id, thread_id, reason, status, started_at, finished_at) values (?, ?, ?, 'finished', ?, ?)");
    for (const [id, threadId, reason] of [
      ["wk-user", "thr-release", "user"], ["wk-report", "thr-release", "worker-report"], ["wk-check", "thr-release", "work-item-heartbeat"],
      ["wk-alarm", "thr-research", "alarm"], ["wk-watch", "thr-worker", "watch"]
    ] as const) wake.run(id, threadId, reason, iso(0), iso(1));
    store.db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at, finished_at) values ('dream-e2e', 'schedule', 'succeeded', 'user', ?, ?)").run(iso(5), iso(6));
    const insert = store.db.prepare(`
      insert into llm_calls (id, purpose, scope_type, scope_id, provider, provider_name, model, base_url, request_hash, response_hash, metadata_json,
        input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, status, started_at, finished_at, latency_ms,
        created_at, updated_at, cost_source, cost_micros, cost_ref)
      values (?, ?, ?, ?, ?, 'gw', ?, 'https://gw.example.test/v1', 'req', 'res', ?, ?, 500, ?, ?, ?, 'succeeded', ?, ?, 2000, ?, ?, 'list', ?, ?)
    `);
    for (const c of CALLS) {
      const model = c.model ?? CLAUDE;
      const input = c.input ?? 100_000;
      insert.run(
        // Claude through the Anthropic protocol, where Mandate marks its cache.
        c.id, c.purpose ?? "agent_wake_step", c.scopeType ?? "agent_thread", c.thread ?? "thr-release", model === CLAUDE ? "anthropic" : "openai-compatible", model,
        JSON.stringify(c.wake ? { providerName: "gw", wakeId: c.wake } : { providerName: "gw" }),
        input, input + 500, c.read ?? 0, c.write ?? 0, iso(c.at), iso(c.at), iso(c.at), iso(c.at),
        c.micros ?? 100_000, model === CLAUDE ? ref("claude-e2e", "anthropic") : ref("gpt-e2e", "openai")
      );
    }
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

async function open(search: string, viewport: { width: number; height: number }): Promise<Page> {
  const page = await browser.newPage({ viewport });
  attachPageDiagnostics(page);
  page.setDefaultTimeout(WAIT_MS);
  await page.goto(`${server.baseUrl}/activity${search}`);
  return page;
}

const titles = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll('[role="tabpanel"] [data-slot="section-title"]')].map((n) => n.textContent ?? ""));

describe("the Overview at every width", () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 600, height: 900 }, { width: 390, height: 844 }]) {
    test(`at ${viewport.width}px: the sections in order, nothing scrolls sideways, nothing leaves its panel`, async () => {
      const page = await open("", viewport);
      try {
        await page.getByText("What woke the agents").waitFor();
        expect(await titles(page)).toEqual(["Spend", "By agent", "Cache", "What the spend is made of", "What woke the agents"]);
        expect(await pageOverflow(page)).toEqual([]);
        const escaped = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-slot="section-panel"]')].flatMap((panel) => {
          const box = panel.getBoundingClientRect();
          return [...panel.querySelectorAll<HTMLElement>("*")]
            .filter((el) => el.getClientRects().length > 0 && el.getBoundingClientRect().right > box.right + 0.5)
            .map((el) => `${el.tagName} ${el.textContent?.slice(0, 30)}`);
        }));
        expect(escaped).toEqual([]);
        // Who sits in its own column wide, under Why narrow.
        const who = await page.evaluate(() => {
          const visible = (sel: string) => [...document.querySelectorAll(sel)].some((el) => el.getClientRects().length > 0);
          return { column: visible('[data-wake-who="column"]'), inline: visible('[data-wake-who="inline"]') };
        });
        expect(who).toEqual(viewport.width >= 1000 ? { column: true, inline: false } : { column: false, inline: true });
        // Wake names keep room to be read.
        const nameWidths = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-wake-row] > span:first-child")]
          .filter((el) => el.getClientRects().length > 0).map((el) => el.getBoundingClientRect().width));
        expect(nameWidths.every((w) => w >= 100)).toBe(true);
      } finally {
        await page.close();
      }
    }, TEST_TIMEOUT_MS);
  }

  test("spend bars stand in proportion to their days' spend", async () => {
    const page = await open("?days=7", { width: 1440, height: 900 });
    try {
      await page.locator("[data-spend-bar]").first().waitFor();
      const bars = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-spend-day]")].map((day) => ({
        height: day.querySelector<HTMLElement>("[data-spend-bar]")!.getBoundingClientRect().height,
        plot: day.getBoundingClientRect().height,
        style: day.querySelector<HTMLElement>("[data-spend-bar]")!.style.height
      })).filter((b) => b.height > 0));
      expect(bars.length).toBeGreaterThan(0);
      for (const bar of bars) expect(Math.abs(bar.height - (parseFloat(bar.style) / 100) * bar.plot)).toBeLessThan(1.5);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe("from the Overview to Logs", () => {
  test("Show these calls opens the Cache expired view with the Overview's count, and lists that many", async () => {
    const page = await open("?days=7", { width: 1280, height: 900 });
    try {
      // The Overview's own figure: the Calls cell beside the Cache expired verdict.
      await page.locator('[data-cache-row="expired"]').waitFor();
      const overviewCount = Number((await page.locator('[data-cache-row="expired"] + span').textContent())?.replace(/,/g, ""));
      expect(overviewCount).toBe(EXPIRED_CALLS);
      await page.getByRole("link", { name: "Show these calls" }).click();
      await page.locator("#activity-panel-logs").waitFor({ state: "visible" });
      const params = new URL(page.url()).searchParams;
      expect([params.get("tab"), params.get("view"), params.get("days")]).toEqual(["logs", "expired", "7"]);
      // Logs says, and lists, the Overview's number.
      await page.getByText(`Cache expired · last 7 days · ${overviewCount} calls`).waitFor();
      await page.locator("[data-log-row]").first().waitFor();
      expect(await page.locator("[data-log-row]").count()).toBe(overviewCount);
      expect(await page.locator("[data-log-verdict-chip]").allTextContents()).toEqual(Array(overviewCount).fill("Cache expired"));
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("a By agent row opens the log filtered to that agent, with its chip", async () => {
    const page = await open("", { width: 1280, height: 900 });
    try {
      await page.getByRole("link", { name: "Managers", exact: true }).click();
      await page.locator("#activity-panel-logs").waitFor({ state: "visible" });
      await page.getByRole("button", { name: "agent: Managers" }).waitFor();
      await page.locator("[data-log-row]").first().waitFor();
      expect(await page.locator("[data-log-row]").count()).toBe(MANAGER_STEPS);
      expect(await page.locator("[data-log-thread]").allTextContents()).toEqual(
        expect.arrayContaining(["Manager · Invented release", "Manager · Invented research"])
      );
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);

  test("a call opened from Cache expired explains its verdict and splits its cost; closing it moves no row", async () => {
    const page = await open("?tab=logs&view=expired&days=7", { width: 1280, height: 900 });
    try {
      await page.locator("[data-log-row]").first().waitFor();
      const before = await page.locator("[data-log-row]").evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().top)));
      await page.locator("[data-log-row]").first().click();
      const verdict = page.locator("[data-call-verdict]");
      await verdict.waitFor();
      expect(await verdict.textContent()).toContain("Claude keeps a cache for 5 minutes");
      expect(await page.locator("[data-cost-split-row]").count()).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await verdict.waitFor({ state: "detached" });
      const after = await page.locator("[data-log-row]").evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().top)));
      expect(after).toEqual(before);
    } finally {
      await page.close();
    }
  }, TEST_TIMEOUT_MS);
});
