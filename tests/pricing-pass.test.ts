import { expect, test } from "bun:test";
import type { ProviderConfig } from "../src/server/config/types.js";
import { createPriceCatalog, type PriceCatalog } from "../src/server/modules/pricing/catalog.js";
import type { ModelsDevPrices } from "../src/server/modules/pricing/models-dev.js";
import { PricingPass } from "../src/server/modules/pricing/pricing-pass.js";
import { tempDir } from "./helpers/temp.js";
import { testStore } from "./helpers/test-store.js";

const FILL = "https://fill.example.test/v1";

function catalogWith(date: string, models: ModelsDevPrices["providers"][number]["models"]): PriceCatalog {
  return createPriceCatalog({
    litellm: null,
    modelsDev: { date, plans: [], providers: [{ id: "fill", name: "Fill", api: FILL, models }] }
  });
}

const BASE_CATALOG = catalogWith("2026-10-22", [{ id: "m1", rates: { base: { input: 1, output: 2 } } }]);

/** Now, as the pass reads it: its 30 days back, and each tick's time spent. */
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function setup(providers: Record<string, ProviderConfig>, options: { batchSize?: number; clearBatchesPerTick?: number; clearWindow?: number; now?: () => number } = {}, readiness: { ready?: () => boolean; ensure?: () => void } = {}) {
  const store = testStore(tempDir("md-pricing-pass-"));
  let catalog = BASE_CATALOG;
  let current = providers;
  const pass = new PricingPass({
    db: store.db,
    data: { catalog: () => catalog, ...readiness },
    providers: () => current,
    now: () => NOW,
    ...options
  });
  let seq = 0;
  const insert = (row: { model?: string; providerName?: string; metadataName?: string; status?: string; startedAt?: string; input?: number | null; output?: number | null; ttft?: number | null; baseURL?: string; provider?: string; reported?: number | null }) => {
    seq += 1;
    const id = `llm_${String(seq).padStart(6, "0")}`;
    const at = row.startedAt ?? new Date(Date.UTC(2026, 9, 21, 0, 0, seq)).toISOString();
    store.db.prepare(`insert into llm_calls (id, purpose, provider, model, base_url, provider_name, metadata_json, status, started_at, created_at, updated_at,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ttft_ms, reported_cost_micros)
      values (?, 'agent_wake_step', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`).run(
      id, row.provider ?? "openai-compatible", row.model ?? "m1", row.baseURL ?? FILL, row.providerName ?? "fill",
      row.metadataName ? JSON.stringify({ providerName: row.metadataName }) : null,
      row.status ?? "succeeded", at, at, at, row.input === undefined ? 1_000_000 : row.input, row.output === undefined ? 0 : row.output,
      row.ttft === undefined ? 500 : row.ttft, row.reported ?? null);
    return id;
  };
  const read = (id: string) => store.db.prepare("select provider_name, cost_micros, cost_source, cost_api_micros, cost_ref, cost_note from llm_calls where id = ?").get(id) as Record<string, unknown>;
  const pending = () => (store.db.prepare("select count(*) n from llm_calls where cost_source is null").get() as { n: number }).n;
  /** The calls written from here on, by id: a trigger notes each update. */
  const watchWrites = () => {
    store.db.exec("create temp table if not exists written (id text)");
    store.db.exec("delete from temp.written");
    store.db.exec("create temp trigger if not exists note_write after update on llm_calls begin insert into written values (new.id); end");
    return () => (store.db.prepare("select id from temp.written").all() as Array<{ id: string }>).map((r) => r.id);
  };
  const jobs = () => (store.db.prepare("select key from pricing_seen where key not like 'conn:%' and key != 'data:version' order by key").all() as Array<{ key: string }>).map((r) => r.key);
  return {
    store, pass, insert, read, pending, watchWrites, jobs,
    setCatalog: (next: PriceCatalog) => { catalog = next; },
    setProviders: (next: Record<string, ProviderConfig>) => { current = next; }
  };
}

const fill = (extra: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ type: "openai-compatible", baseURL: FILL, apiKey: "", models: [{ id: "m1", input: ["text"] }], ...extra });

test("prices new rows, newest first, a batch per tick", () => {
  const s = setup({ fill: fill() }, { batchSize: 2 });
  const [a, b, c] = [s.insert({}), s.insert({}), s.insert({})];
  s.pass.tick();
  expect([s.read(a).cost_source, s.read(b).cost_source, s.read(c).cost_source]).toEqual([null, "catalog", "catalog"]);
  s.pass.tick();
  expect(s.read(a)).toMatchObject({ cost_source: "catalog", cost_micros: 1_000_000, cost_note: null });
  expect(JSON.parse(s.read(a).cost_ref as string)).toMatchObject({ origin: "models.dev", providerId: "fill", modelId: "m1", dataDate: "2026-10-22" });
});

test("calls wait while the price data is on its way, and ask for it; priced once a download has been tried", () => {
  let ready = false;
  let asked = 0;
  const s = setup({ fill: fill() }, {}, { ready: () => ready, ensure: () => { asked += 1; } });
  const id = s.insert({});
  s.pass.tick();
  expect(s.read(id).cost_source).toBeNull();
  expect(asked).toBe(1);
  ready = true;
  s.pass.tick();
  expect(s.read(id).cost_source).toBe("catalog");
});

test("calls to price ask for missing price data even when pricing need not wait (an earlier try failed)", () => {
  let asked = 0;
  const s = setup({ fill: fill() }, {}, { ready: () => true, ensure: () => { asked += 1; } });
  const id = s.insert({});
  s.pass.tick();
  expect(asked).toBe(1);
  expect(s.read(id).cost_source).toBe("catalog");
});

test("with nothing to price, no price data is asked for", () => {
  let asked = 0;
  const s = setup({ fill: fill() }, {}, { ready: () => false, ensure: () => { asked += 1; } });
  s.pass.tick();
  expect(asked).toBe(0);
});

test("a call on an unknown connection is priced as Automatic", () => {
  const s = setup({});
  const id = s.insert({ providerName: "gone" });
  s.pass.tick();
  expect(s.read(id)).toMatchObject({ cost_source: "catalog" });
});

test("a call on a connection no longer there is billed as its type bills by default: Codex stays Included", () => {
  const CODEX = "https://chatgpt.com/backend-api/codex";
  const codex: ProviderConfig = { type: "codex", baseURL: CODEX, apiKey: "", models: [{ id: "gpt-5.5", input: ["text"] }] };
  const s = setup({ codex });
  const kept = s.insert({ providerName: "codex", provider: "codex", baseURL: CODEX, model: "gpt-5.5" });
  const never = s.insert({ providerName: "signed-out", provider: "codex", baseURL: CODEX, model: "gpt-5.5" });
  s.pass.tick();
  expect(s.read(kept).cost_source).toBe("included");
  expect(s.read(never).cost_source).toBe("included");
  s.setProviders({});
  for (let i = 0; i < 3; i += 1) s.pass.tick();
  expect(s.read(kept)).toMatchObject({ cost_source: "included", cost_micros: null });
});

test("re-price clears in bounded batches across ticks", () => {
  const s = setup({ fill: fill() }, { batchSize: 100, clearBatchesPerTick: 2, clearWindow: 100 });
  for (let i = 0; i < 500; i += 1) s.insert({});
  for (let i = 0; i < 5; i += 1) s.pass.tick();
  expect(s.pending()).toBe(0);
  s.setProviders({ fill: fill({ models: [{ id: "m1", input: ["text"], price: { input: 5, output: 5 } }] }) });
  s.pass.tick();
  // Two clearing batches this tick, then a pricing batch over what was cleared.
  const sources = s.store.db.prepare("select cost_source, count(*) n from llm_calls group by cost_source").all() as Array<{ cost_source: string | null; n: number }>;
  const bySource = Object.fromEntries(sources.map((r) => [String(r.cost_source), r.n]));
  expect((bySource.your_price ?? 0) + (bySource.null ?? 0)).toBeLessThanOrEqual(200);
  for (let i = 0; i < 20; i += 1) s.pass.tick();
  expect(s.store.db.prepare("select count(*) n from llm_calls where cost_source = 'your_price' and cost_micros = 5000000").get()).toEqual({ n: 500 });
});

test("a call under a provider with no Settings connection is no connection's: a settings change leaves its price", () => {
  const s = setup({ fill: fill() });
  const id = s.insert({ providerName: "openai-compatible" });
  s.pass.tick();
  expect(s.read(id).cost_source).toBe("catalog");
  s.setProviders({ fill: fill({ billing: "plan" }) });
  s.pass.tick();
  s.pass.tick();
  expect(s.read(id).cost_source).toBe("catalog");
});

test("unpriced rows are retried after a data change, priced rows are not", () => {
  const s = setup({ fill: fill() });
  const unknown = s.insert({ model: "zz", startedAt: daysAgo(2) });
  const known = s.insert({ startedAt: daysAgo(2) });
  s.pass.tick();
  expect(s.read(unknown).cost_source).toBe("unpriced");
  s.setCatalog(catalogWith("2026-10-23", [{ id: "m1", rates: { base: { input: 9, output: 9 } } }, { id: "zz", rates: { base: { input: 3, output: 3 } } }]));
  s.pass.tick();
  s.pass.tick();
  expect(s.read(unknown)).toMatchObject({ cost_source: "catalog", cost_micros: 3_000_000 });
  expect(s.read(known)).toMatchObject({ cost_source: "catalog", cost_micros: 1_000_000 });
});

test("a running call is left for later", () => {
  const s = setup({ fill: fill() });
  const id = s.insert({ status: "running", input: null, output: null });
  s.pass.tick();
  expect(s.read(id).cost_source).toBeNull();
});

test("a row that cannot be priced does not stop the pass", () => {
  const s = setup({ fill: fill() });
  const throwing: PriceCatalog = {
    ...BASE_CATALOG,
    listPrice: (q) => { if (q.model === "boom") throw new Error("boom"); return BASE_CATALOG.listPrice(q); }
  };
  s.setCatalog(throwing);
  const broken = s.insert({ model: "boom" });
  const fine = s.insert({});
  const oddDate = s.insert({ startedAt: "not a date" });
  s.pass.tick();
  expect(s.read(broken).cost_source).toBe("unpriced");
  expect(s.read(fine).cost_source).toBe("catalog");
  // An unreadable start time prices at the undated rate.
  expect(s.read(oddDate).cost_source).toBe("catalog");
});

test("the first tick records the settings without clearing anything", () => {
  const s = setup({ fill: fill() });
  const id = s.insert({});
  s.store.db.prepare("update llm_calls set cost_source = 'list', cost_micros = 7 where id = ?").run(id);
  s.pass.tick();
  expect(s.read(id)).toMatchObject({ cost_source: "list", cost_micros: 7 });
});

test("a clear batch scans a bounded window of rows, not until it finds enough", () => {
  const s = setup({ fill: fill(), other: fill({ baseURL: "https://other.example.test/v1" }) }, { batchSize: 1000, clearBatchesPerTick: 2, clearWindow: 100 });
  for (let i = 0; i < 1000; i += 1) s.insert({ providerName: "other", baseURL: "https://other.example.test/v1" });
  const targets = Array.from({ length: 10 }, () => s.insert({}));
  s.pass.tick();
  s.setProviders({ fill: fill({ billing: "free" }), other: fill({ baseURL: "https://other.example.test/v1" }) });
  s.pass.tick();
  // Two windows of 100 rows reach nowhere near the last ten.
  expect(targets.map((id) => s.read(id).cost_source)).toEqual(Array(10).fill("catalog"));
  for (let i = 0; i < 6; i += 1) s.pass.tick();
  expect(targets.map((id) => s.read(id).cost_source)).toEqual(Array(10).fill("free"));
});

test("a connection named like an object property is looked up as a name", () => {
  const s = setup({ constructor: fill(), fill: fill() });
  const named = s.insert({ providerName: "constructor" });
  s.pass.tick();
  s.setProviders({ fill: fill() });
  const plain = s.insert({});
  const gone = s.insert({ providerName: "constructor" });
  s.pass.tick();
  s.pass.tick();
  expect([s.read(named).cost_source, s.read(plain).cost_source, s.read(gone).cost_source]).toEqual(["catalog", "catalog", "catalog"]);
});

test("a model id like an object property keeps its price in the fingerprint", () => {
  const s = setup({ fill: fill({ models: [{ id: "__proto__", input: ["text"], price: { input: 1, output: 1 } }] }) });
  const id = s.insert({ model: "__proto__" });
  s.pass.tick();
  expect(s.read(id)).toMatchObject({ cost_source: "your_price", cost_micros: 1_000_000 });
  s.setProviders({ fill: fill({ models: [{ id: "__proto__", input: ["text"], price: { input: 7, output: 1 } }] }) });
  s.pass.tick();
  s.pass.tick();
  expect(s.read(id)).toMatchObject({ cost_source: "your_price", cost_micros: 7_000_000 });
});

test("unreadable pricing state is redone from the start, not skipped", () => {
  const s = setup({ fill: fill({ models: [{ id: "m1", input: ["text"], price: { input: 2, output: 2 } }] }) });
  const id = s.insert({});
  s.pass.tick();
  expect(s.read(id)).toMatchObject({ cost_source: "your_price", cost_micros: 2_000_000 });
  // A clear whose progress cannot be read, and a fingerprint in another shape.
  s.store.db.prepare("insert into pricing_seen (key, value) values (?, '1')").run(`clear:${JSON.stringify({ name: "fill", type: "openai-compatible", baseURL: FILL })}`);
  s.store.db.prepare("update pricing_seen set value = ? where key = 'conn:fill'").run(JSON.stringify({ type: "openai-compatible", baseURL: FILL, billing: "usage", prices: { m1: { input: 2, output: 2 } } }));
  s.setProviders({ fill: fill({ models: [{ id: "m1", input: ["text"], price: { input: 9, output: 9 } }] }) });
  for (let i = 0; i < 3; i += 1) s.pass.tick();
  expect(s.read(id)).toMatchObject({ cost_source: "your_price", cost_micros: 9_000_000 });
  expect(s.store.db.prepare("select count(*) n from pricing_seen where key like 'clear:%'").get()).toEqual({ n: 0 });
});

const WITH_ZZ = () => catalogWith("2026-10-23", [{ id: "m1", rates: { base: { input: 1, output: 2 } } }, { id: "zz", rates: { base: { input: 3, output: 3 } } }]);

// A data change prices again the Unpriced calls of the last 30 days, where
// they are: older ones stay as they were, and so do priced ones.
test("after a data change, Unpriced calls of the last 30 days are priced again in place; older ones are left", () => {
  const s = setup({ fill: fill() });
  const recent = s.insert({ model: "zz", startedAt: daysAgo(29) });
  const old = s.insert({ model: "zz", startedAt: daysAgo(31) });
  const known = s.insert({ startedAt: daysAgo(1) });
  s.pass.tick();
  expect([s.read(recent).cost_source, s.read(old).cost_source, s.read(known).cost_source]).toEqual(["unpriced", "unpriced", "catalog"]);
  s.setCatalog(WITH_ZZ());
  for (let i = 0; i < 3; i += 1) s.pass.tick();
  expect(s.read(recent)).toMatchObject({ cost_source: "catalog", cost_micros: 3_000_000 });
  expect(s.read(old).cost_source).toBe("unpriced");
  expect(s.read(known)).toMatchObject({ cost_source: "catalog", cost_micros: 1_000_000 });
  expect(s.jobs()).toStrictEqual([]);
});

test("a data change writes only the calls whose price it changes, and never clears one first", () => {
  const s = setup({ fill: fill() });
  const stays = Array.from({ length: 5 }, () => s.insert({ model: "yy", startedAt: daysAgo(3) }));
  const gets = s.insert({ model: "zz", startedAt: daysAgo(3) });
  s.pass.tick();
  const written = s.watchWrites();
  s.setCatalog(WITH_ZZ());
  for (let i = 0; i < 3; i += 1) s.pass.tick();
  expect(written()).toEqual([gets]);
  expect(stays.map((id) => s.read(id).cost_source)).toEqual(Array(5).fill("unpriced"));
  expect(s.pending()).toBe(0);
});

test("a data change reads the Unpriced calls alone, however many priced calls there are", () => {
  // Windows of 10 rows: a sweep of the 2,000 rows would take tens of ticks.
  const s = setup({ fill: fill() }, { clearWindow: 10, clearBatchesPerTick: 1 });
  for (let i = 0; i < 2_000; i += 1) s.insert({ startedAt: daysAgo(2) });
  const unknown = s.insert({ model: "zz", startedAt: daysAgo(2) });
  for (let i = 0; i < 5; i += 1) s.pass.tick();
  expect(s.pending()).toBe(0);
  s.setCatalog(WITH_ZZ());
  s.pass.tick();
  expect(s.read(unknown).cost_source).toBe("catalog");
  expect(s.jobs()).toStrictEqual([]);
});

test("a tick stops when its time is spent, and the rest waits for the next", () => {
  // Every reading of the clock is 30 ms later: a tick's 50 ms are spent at once.
  let clock = NOW;
  const s = setup({ fill: fill() }, { batchSize: 100, clearWindow: 5, clearBatchesPerTick: 100, now: () => (clock += 30) });
  const calls = Array.from({ length: 20 }, () => s.insert({ startedAt: daysAgo(1) }));
  s.pass.tick();
  // New calls: a few priced, not all of the batch.
  const priced = () => calls.filter((id) => s.read(id).cost_source !== null).length;
  expect(priced()).toBeGreaterThan(0);
  expect(priced()).toBeLessThan(20);
  for (let i = 0; i < 40; i += 1) s.pass.tick();
  expect(priced()).toBe(20);
  // A settings change's clear: one window a tick, then the rest.
  s.setProviders({ fill: fill({ billing: "free" }) });
  s.pass.tick();
  expect(calls.filter((id) => s.read(id).cost_source === "free").length).toBeLessThan(20);
  for (let i = 0; i < 60; i += 1) s.pass.tick();
  expect(calls.map((id) => s.read(id).cost_source)).toEqual(Array(20).fill("free"));
});

// The Activity slices are worked out again after a price change: not while
// the pass still has old calls to write prices into, a batch of them
// putting slices out of date again at every tick.
test("the pass is idle once nothing is queued and no finished call waits for a price", () => {
  const s = setup({ fill: fill() }, { batchSize: 1, clearBatchesPerTick: 1, clearWindow: 2 });
  const ids = Array.from({ length: 5 }, () => s.insert({}));
  // Finished calls wait for their first price.
  expect(s.pass.idle()).toBe(false);
  for (let i = 0; i < 5; i += 1) s.pass.tick();
  expect([s.pending(), s.pass.idle()]).toEqual([0, true]);
  // A call still running waits for nothing.
  s.insert({ status: "running" });
  expect(s.pass.idle()).toBe(true);

  // A connection's billing changes: its calls are cleared a window a tick,
  // and priced again one a tick, some of them after the last window.
  s.setProviders({ fill: fill({ billing: "free" }) });
  s.pass.tick();
  expect(s.jobs().length).toBe(1);
  expect(s.pass.idle()).toBe(false);
  let ticks = 1;
  while (!s.pass.idle() && ticks < 30) {
    s.pass.tick();
    ticks += 1;
  }
  expect(ticks).toBeGreaterThan(3);
  expect(s.jobs()).toEqual([]);
  expect(ids.map((id) => s.read(id).cost_source)).toEqual(Array(5).fill("free"));
});

test("the pass is not idle while a clear has windows left, though every call so far has its price", () => {
  const s = setup({ fill: fill() }, { batchSize: 100, clearBatchesPerTick: 1, clearWindow: 2 });
  for (let i = 0; i < 6; i += 1) s.insert({});
  s.pass.tick();
  s.setProviders({ fill: fill({ billing: "free" }) });
  // The first window is cleared and priced again within the tick; two windows are left.
  s.pass.tick();
  expect([s.pending(), s.jobs().length]).toEqual([0, 1]);
  expect(s.pass.idle()).toBe(false);
  s.pass.tick();
  s.pass.tick();
  expect([s.pending(), s.jobs().length, s.pass.idle()]).toEqual([0, 0, true]);
});

test("the pass is not idle while the Unpriced calls wait for new price data to be priced again", () => {
  let ready = true;
  const s = setup({ fill: fill() }, {}, { ready: () => ready });
  s.insert({ model: "zz" });
  s.pass.tick();
  expect(s.pass.idle()).toBe(true);
  // New data on its way: the re-price is queued and waits for it.
  ready = false;
  s.setCatalog(catalogWith("2026-10-23", [{ id: "m1", rates: { base: { input: 1, output: 2 } } }, { id: "zz", rates: { base: { input: 3, output: 3 } } }]));
  s.pass.tick();
  expect(s.jobs()).toEqual(["reprice:unpriced"]);
  expect(s.pass.idle()).toBe(false);
  ready = true;
  s.pass.tick();
  expect([s.jobs(), s.pass.idle()]).toEqual([[], true]);
});

// A change of settings queues its work at the pass's next tick: until then
// nothing is queued, and the pass is still not idle.
test("the pass is not idle until a tick has looked at the settings in use", () => {
  const s = setup({ fill: fill() });
  s.insert({});
  // Before its first tick it has looked at nothing: what a restart left queued is not known yet.
  s.store.db.prepare("update llm_calls set cost_source = 'catalog'").run();
  expect(s.pass.idle()).toBe(false);
  s.pass.tick();
  expect(s.pass.idle()).toBe(true);

  // A connection's billing changes: not idle at once, before the tick that queues the clear.
  s.setProviders({ fill: fill({ billing: "free" }) });
  expect([s.jobs(), s.pass.idle()]).toEqual([[], false]);
  s.pass.tick();
  s.pass.tick();
  expect([s.jobs(), s.pending(), s.pass.idle()]).toEqual([[], 0, true]);

  // Price data that says something new: the same.
  s.setCatalog(catalogWith("2026-10-23", [{ id: "m1", rates: { base: { input: 1, output: 2 } } }, { id: "zz", rates: { base: { input: 3, output: 3 } } }]));
  expect(s.pass.idle()).toBe(false);
  s.pass.tick();
  expect(s.pass.idle()).toBe(true);

  // A connection added or taken away too.
  s.setProviders({ fill: fill({ billing: "free" }), other: fill({ baseURL: "https://other.example.test/v1" }) });
  expect(s.pass.idle()).toBe(false);
  s.pass.tick();
  expect(s.pass.idle()).toBe(true);
});
