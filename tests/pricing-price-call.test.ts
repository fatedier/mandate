import { expect, test } from "bun:test";
import type { CatalogPrice, PriceCatalog, PriceQuery, PriceRef } from "../src/server/modules/pricing/catalog.js";
import { priceCall, type CallForPricing, type ConnectionPricing } from "../src/server/modules/pricing/price-call.js";

const ref = (origin: PriceRef["origin"], providerId: string, modelId: string): PriceRef =>
  ({ origin, providerId, providerName: providerId, modelId, dataDate: "2026-10-21" });
const price = (usd: number, r: PriceRef, noCachePrice = false): CatalogPrice => ({ usd, ref: r, noCachePrice, rates: { input: 1, output: 1 } });

/** A catalog that answers from fixed prices and records what it was asked. */
function fakeCatalog(answers: { list?: CatalogPrice | null; catalog?: CatalogPrice | null; name?: CatalogPrice | null; as?: CatalogPrice | null; your?: number | null; planAt?: string } = {}) {
  const calls: Array<{ method: string; q?: Partial<PriceQuery> }> = [];
  const catalog = {
    listPrice: (q: PriceQuery) => { calls.push({ method: "list", q }); return answers.list ?? null; },
    catalogPrice: (q: PriceQuery) => { calls.push({ method: "catalog", q }); return answers.catalog ?? null; },
    namePrice: (q: PriceQuery) => { calls.push({ method: "name", q }); return answers.name ?? null; },
    priceAs: () => { calls.push({ method: "as" }); return answers.as ?? null; },
    yourPrice: () => { calls.push({ method: "your" }); return answers.your === null ? null : price(answers.your ?? 0.001, ref("your-price", "your-price", "")); },
    isPlanProvider: (baseURL: string) => answers.planAt === baseURL
  } as unknown as PriceCatalog;
  return { catalog, calls };
}

const call = (x: Partial<CallForPricing> = {}): CallForPricing => ({
  providerType: "openai-compatible",
  baseURL: "https://gw.example.test/v1",
  model: "gpt-6.1-sol",
  startedAt: "2026-10-21T12:00:00.000Z",
  status: "succeeded",
  ttftMs: 800,
  usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
  serviceTier: null,
  reportedMicros: null,
  ...x
});

const LIST = price(0.01, ref("litellm", "openai", "gpt-6.1-sol"));
const FILL = price(0.005, ref("models.dev", "fill", "gpt-6.1-sol"));
const AS = price(0.02, ref("litellm", "openai", "gpt-6.1-sol"));

test("plan → included, with the API-price reference", () => {
  const { catalog } = fakeCatalog({ list: price(0.002, ref("litellm", "openai", "gpt-6.1-sol")) });
  expect(priceCall(call(), { billing: "plan" }, catalog)).toMatchObject({ source: "included", micros: null, apiMicros: 2_000 });
});

test("free has no amount", () => {
  const { catalog } = fakeCatalog({ list: LIST });
  expect(priceCall(call({ reportedMicros: 4_200 }), { billing: "free" }, catalog)).toMatchObject({ source: "free", micros: null, apiMicros: null });
});

test("your price beats a reported cost", () => {
  const { catalog } = fakeCatalog({ your: 0.003 });
  const connection: ConnectionPricing = { billing: "usage", price: { input: 1, output: 1 } };
  expect(priceCall(call({ reportedMicros: 4_200 }), connection, catalog)).toMatchObject({ source: "your_price", micros: 3_000 });
});

test("a reported cost beats price as", () => {
  const { catalog } = fakeCatalog({ as: AS, list: LIST });
  const connection: ConnectionPricing = { billing: "usage", price: { as: "litellm:gpt-6.1-sol" } };
  expect(priceCall(call({ reportedMicros: 4_200 }), connection, catalog)).toMatchObject({ source: "reported", micros: 4_200, ref: null });
});

test("price as when nothing was reported", () => {
  const { catalog } = fakeCatalog({ as: AS, list: LIST });
  const connection: ConnectionPricing = { billing: "usage", price: { as: "litellm:gpt-6.1-sol" } };
  expect(priceCall(call(), connection, catalog)).toMatchObject({ source: "price_as", micros: 20_000, ref: AS.ref });
});

test("list, then catalog, then unpriced", () => {
  expect(priceCall(call(), null, fakeCatalog({ list: LIST, catalog: FILL }).catalog)).toMatchObject({ source: "list", micros: 10_000 });
  expect(priceCall(call(), null, fakeCatalog({ catalog: FILL }).catalog)).toMatchObject({ source: "catalog", micros: 5_000 });
  expect(priceCall(call(), null, fakeCatalog().catalog)).toMatchObject({ source: "unpriced", micros: null, note: null });
});

test("the list lookup gets the call's connection type, address, tier and tokens, for a plan's reference too", () => {
  for (const connection of [null, { billing: "plan" } as const]) {
    const { catalog, calls } = fakeCatalog({ list: LIST });
    priceCall(call({ providerType: "codex", baseURL: "https://chatgpt.com/backend-api/codex", serviceTier: "flex", usage: { input: 5000, output: 7, cacheRead: 4000, cacheWrite: 900, cacheWrite1h: 600 } }), connection, catalog);
    expect(calls.find((c) => c.method === "list")!.q).toEqual({
      model: "gpt-6.1-sol", baseURL: "https://chatgpt.com/backend-api/codex", providerType: "codex", serviceTier: "flex",
      usage: { input: 5000, output: 7, cacheRead: 4000, cacheWrite: 900, cacheWrite1h: 600 }
    });
  }
});

test("failed with no usage after the provider answered is unpriced", () => {
  const empty = { input: null, output: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null };
  const { catalog } = fakeCatalog({ list: LIST });
  expect(priceCall(call({ status: "failed", ttftMs: 1200, usage: empty }), null, catalog)).toMatchObject({ source: "unpriced", micros: null, note: "failed_no_usage" });
});

test("failed with no usage and no answer has no amount", () => {
  const empty = { input: null, output: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null };
  const { catalog } = fakeCatalog({ list: LIST });
  expect(priceCall(call({ status: "failed", ttftMs: null, usage: empty }), null, catalog)).toMatchObject({ source: "none", micros: null });
});

test("a failed call priced on the usage it had", () => {
  const { catalog } = fakeCatalog({ list: LIST });
  expect(priceCall(call({ status: "failed", usage: { input: 5000, output: null, cacheRead: 4000, cacheWrite: null, cacheWrite1h: null } }), null, catalog)).toMatchObject({ source: "list" });
});

test("no cache price is noted", () => {
  const { catalog } = fakeCatalog({ catalog: price(0.005, ref("models.dev", "fill", "m"), true) });
  expect(priceCall(call(), null, catalog)).toMatchObject({ source: "catalog", note: "no_cache_price" });
});

test("included with no reference shows no amount", () => {
  expect(priceCall(call(), { billing: "plan" }, fakeCatalog().catalog)).toMatchObject({ source: "included", micros: null, apiMicros: null, ref: null });
});

test("the included reference prefers your price, then price as", () => {
  const your = priceCall(call(), { billing: "plan", price: { input: 1, output: 1 } }, fakeCatalog({ your: 0.004, list: LIST }).catalog);
  expect(your).toMatchObject({ source: "included", apiMicros: 4_000 });
  const as = priceCall(call(), { billing: "plan", price: { as: "litellm:gpt-6.1-sol" } }, fakeCatalog({ as: AS, list: LIST }).catalog);
  expect(as).toMatchObject({ source: "included", apiMicros: 20_000 });
});

test("amounts round to whole micro-dollars", () => {
  expect(priceCall(call(), null, fakeCatalog({ list: price(0.0000014, LIST.ref) }).catalog).micros).toBe(1);
});

test("a succeeded call without usage is unpriced without the failure note", () => {
  const empty = { input: null, output: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null };
  expect(priceCall(call({ usage: empty }), null, fakeCatalog({ list: LIST }).catalog)).toMatchObject({ source: "unpriced", note: null });
});

test("rounding survives floating-point error at a half micro-dollar", () => {
  // 45 tokens at $0.70/1M is 31.5 micro-dollars; the float product lands just under.
  expect(priceCall(call(), null, fakeCatalog({ list: price(0.00003149999999999999, LIST.ref) }).catalog).micros).toBe(32);
});

test("a reported amount is a whole number of micro-dollars", () => {
  expect(priceCall(call({ reportedMicros: 1.4 }), null, fakeCatalog().catalog).micros).toBe(1);
});

test("a reported charge counts even without token counts", () => {
  const empty = { input: null, output: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null };
  expect(priceCall(call({ usage: empty, reportedMicros: 4_200 }), null, fakeCatalog().catalog)).toMatchObject({ source: "reported", micros: 4_200 });
});

test("a reported amount at a half micro-dollar rounds like a computed one", () => {
  expect(priceCall(call({ reportedMicros: (45 * 0.7 / 1_000_000) * 1_000_000 }), null, fakeCatalog().catalog).micros).toBe(32);
});

test("a plan's address billed as Pay per use: no list price, Unpriced until the user says how it bills", () => {
  const PLAN = "https://plan.example.test/api/coding/v4";
  const { catalog } = fakeCatalog({ list: LIST, catalog: FILL, planAt: PLAN });
  expect(priceCall(call({ baseURL: PLAN }), { billing: "usage" }, catalog)).toMatchObject({ source: "unpriced", micros: null });
  expect(priceCall(call({ baseURL: PLAN }), null, catalog)).toMatchObject({ source: "unpriced" });
  // What the user said still counts: on a plan, Included with the list price as its reference.
  expect(priceCall(call({ baseURL: PLAN }), { billing: "plan" }, catalog)).toMatchObject({ source: "included", apiMicros: 10_000 });
  expect(priceCall(call({ baseURL: PLAN }), { billing: "usage", price: { input: 1, output: 1 } }, catalog).source).toBe("your_price");
  expect(priceCall(call({ baseURL: PLAN, reportedMicros: 300 }), { billing: "usage" }, catalog).source).toBe("reported");
  // Any other address is priced as before.
  expect(priceCall(call(), { billing: "usage" }, catalog).source).toBe("list");
});

test("a price of the user's that gives no amount leaves the call Unpriced; on a plan the list price is the reference", () => {
  const { catalog } = fakeCatalog({ list: LIST, your: null });
  expect(priceCall(call(), { billing: "usage", price: { input: 1, output: 1 } }, catalog)).toMatchObject({ source: "unpriced", micros: null });
  expect(priceCall(call(), { billing: "plan", price: { input: 1, output: 1 } }, catalog)).toMatchObject({ source: "included", apiMicros: 10_000 });
});

test("with no list or models.dev price, the price by name: a list price from LiteLLM, a catalog price from models.dev", () => {
  const byLitellm = price(0.003, ref("litellm", "anthropic", "claude-opus-5-5"));
  expect(priceCall(call(), { billing: "usage" }, fakeCatalog({ name: byLitellm }).catalog)).toMatchObject({ source: "list", micros: 3_000, ref: byLitellm.ref });
  const byModelsDev = price(0.004, ref("models.dev", "fill", "m1"));
  expect(priceCall(call(), null, fakeCatalog({ name: byModelsDev }).catalog)).toMatchObject({ source: "catalog", micros: 4_000 });
  // The list price and models.dev at the URL come first.
  expect(priceCall(call(), null, fakeCatalog({ list: LIST, name: byLitellm }).catalog).micros).toBe(10_000);
  expect(priceCall(call(), null, fakeCatalog({ catalog: FILL, name: byLitellm }).catalog).micros).toBe(5_000);
  // A plan's address is still not priced, by name either.
  const PLAN = "https://plan.example.test/v1";
  const plan = fakeCatalog({ name: byLitellm, planAt: PLAN });
  expect(priceCall(call({ baseURL: PLAN }), null, plan.catalog).source).toBe("unpriced");
  // On a plan connection the price by name is the Included reference.
  expect(priceCall(call(), { billing: "plan" }, fakeCatalog({ name: byLitellm }).catalog)).toMatchObject({ source: "included", apiMicros: 3_000 });
});
