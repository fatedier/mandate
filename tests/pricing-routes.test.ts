import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { LlmCallDetailResponse } from "../src/shared/api-contracts.js";
import type { PriceCatalogResponse, PriceMatchResponse, PricingStatusResponse, ProviderPricingResponse } from "../src/shared/api/pricing.js";
import { activityModule } from "../src/server/modules/activity/module.js";
import { pricingModule } from "../src/server/modules/pricing/module.js";
import { createPriceCatalog } from "../src/server/modules/pricing/catalog.js";
import type { AppDeps } from "../src/server/app/deps.js";
import type { Config, ProviderConfig } from "../src/server/config/types.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";

const { upgradeWebSocket } = createBunWebSocket();
// Sample rates, in the trimmed forms the catalog reads.
const catalog = createPriceCatalog({
  litellm: {
    date: "2026-10-15",
    entries: {
      "gpt-6.1-sol": { provider: "openai", rates: { base: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } } },
      "claude-opus-5-5": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } } }
    }
  },
  modelsDev: {
    date: "2026-10-22",
    providers: [{ id: "fill", name: "Fill", api: "https://fill.example.test/v1", models: [{ id: "m1", rates: { base: { input: 1, output: 2 } } }] }],
    plans: [{ id: "a-coding-plan", api: "https://plan.example.test/v1" }, { id: "anthropic-like-plan", api: "https://api.anthropic.com/coding/v1" }]
  }
});

const providers: Record<string, ProviderConfig> = {
  gw: { type: "openai-compatible", baseURL: "https://gw.example.test/v1", apiKey: "", models: [{ id: "openai/gpt-6.1-sol", input: ["text"] }, { id: "nothing-like-it", input: ["text"] }] },
  claude: { type: "anthropic", baseURL: "https://api.anthropic.com/v1", apiKey: "", models: [{ id: "claude-opus-5-5", input: ["text"] }] },
  plan: { type: "openai-compatible", baseURL: "https://plan.example.test/v1", apiKey: "", models: [] },
  // A plan served on a host whose pay-per-use API LiteLLM prices.
  coding: { type: "anthropic", baseURL: "https://api.anthropic.com/coding/v1", apiKey: "", models: [{ id: "claude-opus-5-5", input: ["text"] }] }
};

let ensured = 0;
function app() {
  ensured = 0;
  const env = freshStoresEnv();
  const hono = new Hono();
  const deps = stub<AppDeps>({
    store: env.store,
    config: stub<Config>({ models: stub<Config["models"]>({ providers, prices: { autoUpdate: false } }) }),
    priceData: { catalog: () => catalog, ensure: () => { ensured += 1; } }
  });
  pricingModule.mountRoutes?.(hono, { deps, upgradeWebSocket });
  activityModule.mountRoutes?.(hono, { deps, upgradeWebSocket });
  return { hono, env };
}

test("providers/:name returns what Automatic finds, a suggestion where it finds nothing, and the plan hint", async () => {
  const { hono } = app();
  const gw = await (await hono.request("/api/pricing/providers/gw")).json() as ProviderPricingResponse;
  expect(gw.planSuggested).toBe(false);
  // Found by the name after its prefix, so nothing to suggest.
  expect(gw.models["openai/gpt-6.1-sol"]!.found).toMatchObject({ ref: "litellm:gpt-6.1-sol", label: "OpenAI gpt-6.1-sol", origin: "litellm" });
  expect(gw.models["openai/gpt-6.1-sol"]!.suggestion).toBeNull();
  expect(gw.models["nothing-like-it"]).toEqual({ found: null, suggestion: null });
  const claude = await (await hono.request("/api/pricing/providers/claude")).json() as ProviderPricingResponse;
  expect(claude.models["claude-opus-5-5"]!.found).toMatchObject({ ref: "litellm:claude-opus-5-5", rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }, dataDate: "2026-10-15" });
  expect(claude.models["claude-opus-5-5"]!.suggestion).toBeNull();
  expect(((await (await hono.request("/api/pricing/providers/plan")).json()) as ProviderPricingResponse).planSuggested).toBe(true);
  expect((await hono.request("/api/pricing/providers/missing")).status).toBe(404);
});

test("match prices a model id that is not saved yet", async () => {
  const { hono } = app();
  const r = await (await hono.request("/api/pricing/match?provider=claude&model=claude-opus-5-5")).json() as PriceMatchResponse;
  expect(r.found!.ref).toBe("litellm:claude-opus-5-5");
  expect((await hono.request("/api/pricing/match?provider=missing&model=x")).status).toBe(404);
});

test("catalog search", async () => {
  const { hono } = app();
  const r = await (await hono.request("/api/pricing/catalog?q=fill%20m1")).json() as PriceCatalogResponse;
  expect(r.results.map((x) => x.ref)).toContain("models.dev:fill/m1");
  expect(((await (await hono.request("/api/pricing/catalog?q=")).json()) as PriceCatalogResponse).results).toEqual([]);
});

test("status", async () => {
  const { hono } = app();
  expect(await (await hono.request("/api/pricing/status")).json() as PricingStatusResponse).toEqual({ autoUpdate: false, litellmDate: "2026-10-15", modelsDevDate: "2026-10-22" });
});

test("an unpriced call's detail carries a suggestion; a priced one does not", async () => {
  const { hono, env } = app();
  const at = new Date().toISOString();
  for (const [id, source] of [["u", "unpriced"], ["p", "list"]] as const) {
    env.store.db.prepare(`insert into llm_calls (id, purpose, provider, model, status, started_at, created_at, updated_at, cost_source)
      values (?, 'agent_wake_step', 'openai-compatible', 'openai/gpt-6.1-sol', 'succeeded', ?, ?, ?, ?)`).run(id, at, at, at, source);
  }
  const unpriced = await (await hono.request("/api/activity/calls/u")).json() as Extract<LlmCallDetailResponse, { call: unknown }>;
  expect(unpriced.call.priceSuggestion).toMatchObject({ ref: "litellm:gpt-6.1-sol" });
  const priced = await (await hono.request("/api/activity/calls/p")).json() as Extract<LlmCallDetailResponse, { call: unknown }>;
  expect(priced.call.priceSuggestion).toBeNull();
});

test("at a plan's address on a host LiteLLM prices, Automatic finds nothing and suggests nothing; the plan hint shows", async () => {
  const { hono } = app();
  const coding = await (await hono.request("/api/pricing/providers/coding")).json() as ProviderPricingResponse;
  expect(coding.planSuggested).toBe(true);
  expect(coding.models["claude-opus-5-5"]).toEqual({ found: null, suggestion: null });
  // The same model at the API's own address is found as before.
  const claude = await (await hono.request("/api/pricing/providers/claude")).json() as ProviderPricingResponse;
  expect(claude.models["claude-opus-5-5"]!.found).not.toBeNull();
});

test("an unpriced call at a plan's address offers no list price to take", async () => {
  const { hono, env } = app();
  const at = new Date().toISOString();
  env.store.db.prepare(`insert into llm_calls (id, purpose, provider, model, base_url, status, started_at, created_at, updated_at, cost_source)
    values ('c', 'agent_wake_step', 'anthropic', 'claude-opus-5-5', 'https://api.anthropic.com/coding/v1', 'succeeded', ?, ?, ?, 'unpriced')`).run(at, at, at);
  const detail = await (await hono.request("/api/activity/calls/c")).json() as Extract<LlmCallDetailResponse, { call: unknown }>;
  expect(detail.call.priceSuggestion).toBeNull();
});

test("Settings asking about prices asks for the price data when it is missing", async () => {
  const { hono } = app();
  for (const path of ["/api/pricing/status", "/api/pricing/catalog?q=opus", "/api/pricing/match?provider=claude&model=claude-opus-5-5", "/api/pricing/providers/claude"]) {
    const before = ensured;
    await hono.request(path);
    expect(ensured).toBe(before + 1);
  }
});

test("Settings asking while the first download is on its way waits for it, up to 15 s, and gets the data it brings", async () => {
  const env = freshStoresEnv();
  const hono = new Hono();
  let current = createPriceCatalog({ litellm: null, modelsDev: null });
  let finish: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => { finish = resolve; });
  const waits: number[] = [];
  const deps = stub<AppDeps>({
    store: env.store,
    config: stub<Config>({ models: stub<Config["models"]>({ providers, prices: { autoUpdate: true } }) }),
    priceData: {
      catalog: () => current,
      ensure: () => {},
      whenSettled: async (timeoutMs: number) => { waits.push(timeoutMs); await inFlight; }
    }
  });
  pricingModule.mountRoutes?.(hono, { deps, upgradeWebSocket });
  let answered = false;
  const lifted: number[] = [];
  const server = { timeout: (_request: Request, seconds: number) => { lifted.push(seconds); } };
  const answer = Promise.resolve(hono.request("/api/pricing/status", undefined, { server })).then((res) => { answered = true; return res; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(answered).toBe(false);
  expect(waits).toStrictEqual([15_000]);
  // Lifted before the wait, not after it: Bun's own 10 s would cut it short.
  expect(lifted).toStrictEqual([20]);
  current = catalog;
  finish();
  expect(await (await answer).json() as PricingStatusResponse).toMatchObject({ litellmDate: "2026-10-15", modelsDevDate: "2026-10-22" });
});

test("a price route that may wait for a download lifts the server's idle timeout for itself, past its wait", async () => {
  const { hono } = app();
  const lifted: number[] = [];
  const server = { timeout: (_request: Request, seconds: number) => { lifted.push(seconds); } };
  for (const path of ["/api/pricing/status", "/api/pricing/catalog?q=opus", "/api/pricing/match?provider=claude&model=claude-opus-5-5", "/api/pricing/providers/claude"]) {
    lifted.length = 0;
    await hono.request(path, undefined, { server });
    expect(lifted).toHaveLength(1);
    // Bun closes a silent request after 10 s; the wait is up to 15 s.
    expect(lifted[0]!).toBeGreaterThan(15);
  }
});
