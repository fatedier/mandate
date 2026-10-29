import { expect, test } from "bun:test";
import { createPriceCatalog, refKey, type PriceQuery, type TokenUsage } from "../src/server/modules/pricing/catalog.js";
import type { LitellmPrices } from "../src/server/modules/pricing/litellm.js";
import type { ModelsDevPrices } from "../src/server/modules/pricing/models-dev.js";

// Sample rates, per 1M tokens, in the trimmed forms the catalog reads.
const LITELLM: LitellmPrices = {
  date: "2026-10-21",
  entries: {
    "claude-test-1": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } } },
    "gpt-test-5": {
      provider: "openai",
      rates: {
        base: { input: 2, output: 10, cacheRead: 0.1 },
        tiers: [{ above: 272_000, rates: { input: 4, output: 15 } }],
        flex: { base: { input: 1, output: 5 } },
        priority: { base: { input: 4, output: 20 } }
      }
    },
    "gemini/gemini-test-2": { provider: "gemini", rates: { base: { input: 1.25, output: 10 } } },
    "deepseek/deepseek-test": { provider: "deepseek", rates: { base: { input: 0.28, output: 0.42, cacheRead: 0.028 } } },
    "gemini/gemini-free-test": { provider: "gemini", rates: { base: { input: 0, output: 0 } } }
  }
};

const MODELS_DEV: ModelsDevPrices = {
  date: "2026-10-22",
  providers: [
    {
      id: "fill", name: "Fill", api: "https://fill.example.test/v1",
      models: [
        { id: "m1", rates: { base: { input: 0.5, output: 1, cacheRead: 0.05, cacheWrite: 0.6 }, tiers: [{ above: 200_000, rates: { input: 1, output: 2 } }] } }
      ]
    },
    { id: "share-a", name: "Share A", api: "https://share.example.test/v1", models: [{ id: "a1", rates: { base: { input: 1, output: 1 } } }] },
    { id: "share-b", name: "Share B", api: "https://share.example.test/v1", models: [{ id: "b1", rates: { base: { input: 2, output: 2 } } }] }
  ],
  plans: [{ id: "fill-coding-plan", api: "https://plan.example.test/v1" }, { id: "anthropic-like-plan", api: "https://api.anthropic.com/coding/v1" }]
};

const c = createPriceCatalog({ litellm: LITELLM, modelsDev: MODELS_DEV });
const usage = (x: Partial<TokenUsage> = {}): TokenUsage => ({ input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...x });
const q = (model: string, baseURL: string, x: Partial<PriceQuery> = {}): PriceQuery => ({ model, baseURL, providerType: "openai-compatible", serviceTier: null, usage: usage(), ...x });

test("LiteLLM at Anthropic's own API, whatever the connection's type, with the 1-hour write", () => {
  const big = usage({ input: 1_000_000, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 });
  for (const providerType of ["anthropic", "openai-compatible"]) {
    const p = c.listPrice(q("claude-test-1", "https://api.anthropic.com/v1", { providerType, usage: big }))!;
    expect(p.usd).toBeCloseTo(8, 12);
    expect(p.ref).toEqual({ origin: "litellm", providerId: "anthropic", providerName: "Anthropic", modelId: "claude-test-1", dataDate: "2026-10-21" });
    expect(p.noCachePrice).toBe(false);
  }
});

test("LiteLLM at OpenAI's and Google's own APIs; Google's model by its prefixed key", () => {
  expect(c.listPrice(q("gpt-test-5", "https://api.openai.com/v1", { usage: usage({ input: 100_000 }) }))!.usd).toBeCloseTo(0.2, 12);
  const g = c.listPrice(q("gemini-test-2", "https://generativelanguage.googleapis.com/v1beta", { usage: usage({ input: 1_000_000 }) }))!;
  expect(g.usd).toBeCloseTo(1.25, 12);
  expect(g.ref).toMatchObject({ providerId: "gemini", providerName: "Google", modelId: "gemini/gemini-test-2" });
});

test("a Codex connection is priced as OpenAI's API", () => {
  expect(c.listPrice(q("gpt-test-5", "https://chatgpt.com/backend-api/codex", { providerType: "codex" }))!.ref.providerId).toBe("openai");
  expect(c.listPrice(q("gpt-test-5", "https://chatgpt.com/backend-api/codex"))).toBeNull();
});

test("the list price is never looked up by name on another host, whatever the connection's type", () => {
  for (const [model, baseURL, providerType] of [
    ["openai/gpt-test-5", "https://gw.example.test/v1", "openai-compatible"],
    ["gpt-test-5", "https://gw.example.test/v1", "openai-compatible"],
    ["gpt-test-5", "https://proxy.example.test/v1", "openai"],
    ["claude-test-1", "https://proxy.example.test/v1", "anthropic"],
    // Only the host itself: not one that begins or ends like it.
    ["gpt-test-5", "https://api.openai.com.proxy.example.test/v1", "openai"],
    ["gpt-test-5", "https://eu.api.openai.com/v1", "openai"],
    ["gpt-test-5", "not a url", "openai"]
  ] as const) {
    expect(c.listPrice(q(model, baseURL, { providerType }))).toBeNull();
  }
  expect(c.catalogPrice(q("gpt-test-5", "https://gw.example.test/v1"))).toBeNull();
});

test("by name: the id, then the part after its prefix, then that part under the vendor; models.dev by a prefix naming its provider", () => {
  const at = (model: string, baseURL = "https://gw.example.test/v1") => c.namePrice(q(model, baseURL, { usage: usage({ input: 100_000 }) }));
  expect(at("openai/gpt-test-5")).toMatchObject({ usd: expect.closeTo(0.2, 12), ref: { origin: "litellm", modelId: "gpt-test-5" } });
  // Whatever the prefix, it is priced as the name after it.
  expect(at("codex/gpt-test-5")!.ref.modelId).toBe("gpt-test-5");
  expect(at("deepseek/deepseek-test")!.ref.modelId).toBe("deepseek/deepseek-test");
  expect(at("google/gemini-test-2")!.ref.modelId).toBe("gemini/gemini-test-2");
  expect(at("gpt-test-5")!.ref.modelId).toBe("gpt-test-5");
  expect(at("fill/m1")!.ref).toMatchObject({ origin: "models.dev", providerId: "fill", modelId: "m1" });
  expect(at("acme/nothing")).toBeNull();
  // A $0 entry is not a price for a model by name.
  expect(at("gemini/gemini-free-test")).toBeNull();
});

test("what Automatic finds on a gateway is the price by name; at a plan's address, nothing", () => {
  expect(c.match("openai/gpt-test-5", "https://gw.example.test/v1", "openai-compatible")!.label).toBe("OpenAI gpt-test-5");
  expect(c.match("openai/gpt-test-5", "https://plan.example.test/v1", "openai-compatible")).toBeNull();
  expect(c.match("openai/gpt-test-5", "https://plan.example.test/v1/", "openai-compatible")).toBeNull();
  expect(c.match("openai/gpt-test-5", "http://127.0.0.1:11434/v1", "openai-compatible")).toBeNull();
});

test("a host spelled with a capital, a trailing dot or user info is still that host", () => {
  for (const baseURL of ["https://API.OpenAI.com/v1", "https://api.openai.com./v1", "https://user:secret@api.openai.com/v1"]) {
    expect(c.listPrice(q("gpt-test-5", baseURL))).not.toBeNull();
  }
});

test("a model of another LiteLLM provider is not found at this one's API", () => {
  expect(c.listPrice(q("claude-test-1", "https://api.openai.com/v1"))).toBeNull();
  expect(c.listPrice(q("deepseek-test", "https://api.openai.com/v1"))).toBeNull();
});

test("flex and priority at their rates; the long-context tier for the whole request", () => {
  const at = (serviceTier: string | null, input = 100_000) => c.listPrice(q("gpt-test-5", "https://api.openai.com/v1", { serviceTier, usage: usage({ input }) }))!.usd;
  expect(at("flex")).toBeCloseTo(0.1, 12);
  expect(at("priority")).toBeCloseTo(0.4, 12);
  expect(at("default")).toBeCloseTo(0.2, 12);
  expect(at(null, 300_000)).toBeCloseTo(1.2, 12);
  // Flex has no long-context rate of its own: above the tier, the standard tier.
  expect(at("flex", 300_000)).toBeCloseTo(1.2, 12);
});

test("models.dev at its own URL, with its tier; never at a private address", () => {
  const p = c.catalogPrice(q("m1", "https://fill.example.test/", { usage: usage({ input: 300_000 }) }))!;
  expect(p.usd).toBeCloseTo(0.3, 12);
  expect(p.ref).toEqual({ origin: "models.dev", providerId: "fill", providerName: "Fill", modelId: "m1", dataDate: "2026-10-22" });
  const local = createPriceCatalog({ litellm: null, modelsDev: { ...MODELS_DEV, providers: [{ id: "local", name: "Local", api: "http://127.0.0.1:1234/v1", models: [{ id: "l", rates: { base: { input: 1, output: 1 } } }] }] } });
  expect(local.catalogPrice(q("l", "http://127.0.0.1:1234/v1"))).toBeNull();
});

test("models.dev providers sharing an endpoint are all searched for the model", () => {
  expect(c.catalogPrice(q("b1", "https://share.example.test/v1"))!.ref.providerId).toBe("share-b");
  expect(c.catalogPrice(q("a1", "https://share.example.test/v1"))!.ref.providerId).toBe("share-a");
});

test("Price as a catalog model, by its key, from either list", () => {
  const moment = { serviceTier: null, usage: usage({ input: 100_000 }) };
  const listed = c.listPrice(q("claude-test-1", "https://api.anthropic.com/v1"))!;
  const key = refKey(listed.ref);
  expect(key).toBe("litellm:claude-test-1");
  expect(c.priceAs(key, moment)!.usd).toBeCloseTo(0.4, 12);
  expect(c.priceAs("litellm:gemini/gemini-test-2", moment)!.usd).toBeCloseTo(0.125, 12);
  expect(refKey({ origin: "models.dev", providerId: "fill", modelId: "m1" })).toBe("models.dev:fill/m1");
  expect(c.priceAs("models.dev:fill/m1", moment)!.usd).toBeCloseTo(0.05, 12);
  for (const bad of ["litellm:", "litellm:nothing", "litellm:__proto__", "models.dev:fill/", "models.dev:/m1", "models.dev:nobody/m1", "genai-prices:anthropic/claude-test-1", "nothing"]) {
    expect(c.priceAs(bad, moment)).toBeNull();
  }
});

test("Your price, cache rates falling back to the input rate; rates that give no amount give none", () => {
  const moment = { serviceTier: "flex", usage: usage({ input: 1_000_000, cacheRead: 1_000_000 }) };
  const p = c.yourPrice({ input: 3, output: 15 }, moment)!;
  expect(p.usd).toBeCloseTo(3, 12);
  expect(p.ref.origin).toBe("your-price");
  expect(p.noCachePrice).toBe(true);
  expect(c.yourPrice({ input: 3, output: 15, cacheRead: 0.3 }, moment)!.usd).toBeCloseTo(0.3, 12);
  expect(c.yourPrice({ input: -1, output: 1 }, moment)).toBeNull();
  expect(c.yourPrice({ input: 1e308, output: 1e308 }, { serviceTier: null, usage: usage({ input: 1e20 }) })).toBeNull();
});

test("match reports what Automatic finds, with per-1M rates and a label", () => {
  const m = c.match("claude-test-1", "https://api.anthropic.com", "anthropic")!;
  expect(m.label).toBe("Anthropic claude-test-1");
  expect(m.rates).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 });
  expect(c.match("gemini-test-2", "https://generativelanguage.googleapis.com/v1beta", "google")!.label).toBe("Google gemini-test-2");
  expect(c.match("gpt-test-5", "https://chatgpt.com/backend-api/codex", "codex")!.ref.providerId).toBe("openai");
  expect(c.match("m1", "https://fill.example.test/v1", "openai-compatible")!.ref.origin).toBe("models.dev");
  expect(c.match("m1", "https://plan.example.test/v1", "openai-compatible")).toBeNull();
  // A plan on a host whose API LiteLLM prices: the plan, not the API's price.
  expect(c.match("claude-test-1", "https://api.anthropic.com/coding/v1", "anthropic")).toBeNull();
  expect(c.match("claude-test-1", "https://api.anthropic.com/v1", "anthropic")).not.toBeNull();
});

test("a suggestion by name: LiteLLM first, then a prefix naming a models.dev provider", () => {
  expect(c.suggest("openai/gpt-test-5")!.ref).toMatchObject({ origin: "litellm", modelId: "gpt-test-5" });
  expect(c.suggest("deepseek/deepseek-test")!.label).toBe("deepseek deepseek-test");
  expect(c.suggest("google/gemini-test-2")!.ref.modelId).toBe("gemini/gemini-test-2");
  expect(c.suggest("fill/m1")!.ref).toMatchObject({ origin: "models.dev", providerId: "fill", modelId: "m1" });
  expect(c.suggest("acme/nothing")).toBeNull();
  expect(c.suggest("nothing")).toBeNull();
});

test("search finds models of both lists by provider and id, up to the limit", () => {
  expect(c.search("claude", 10).map((m) => m.ref)).toEqual([expect.objectContaining({ origin: "litellm", modelId: "claude-test-1" })]);
  expect(c.search("google gemini", 10).map((m) => m.label)).toEqual(["Google gemini-test-2"]);
  expect(c.search("fill m1", 10).map((m) => m.ref.origin)).toEqual(["models.dev"]);
  expect(c.search("test", 2)).toHaveLength(2);
  expect(c.search("  ", 10)).toEqual([]);
});

test("data info names each list's date; with neither, nothing prices", () => {
  expect(c.dataInfo()).toMatchObject({ litellmDate: "2026-10-21", modelsDevDate: "2026-10-22" });
  expect(c.dataInfo().version).toMatch(/^[0-9a-z]+\+[0-9a-z]+\+byname$/);
  const empty = createPriceCatalog({ litellm: null, modelsDev: null });
  expect(empty.dataInfo()).toEqual({ litellmDate: null, modelsDevDate: null, version: "none+none+byname" });
  expect(empty.namePrice(q("openai/gpt-test-5", "https://gw.example.test/v1"))).toBeNull();
  expect(empty.listPrice(q("gpt-test-5", "https://api.openai.com/v1"))).toBeNull();
  expect(empty.catalogPrice(q("m1", "https://fill.example.test/v1"))).toBeNull();
  expect(empty.isPlanProvider("https://plan.example.test/v1")).toBe(false);
  expect(empty.search("test", 5)).toEqual([]);
  expect(empty.suggest("openai/gpt-test-5")).toBeNull();
});

test("a model priced $0 in and $0 out is priced $0 at its own API, but not offered by search", () => {
  expect(c.listPrice(q("gemini-free-test", "https://generativelanguage.googleapis.com/v1beta", { usage: usage({ input: 1_000_000 }) }))!.usd).toBe(0);
  expect(c.search("gemini", 10).map((m) => m.label)).toEqual(["Google gemini-test-2"]);
});

test("the data version follows what the lists say: a second change the same day is a new version, the same content again is not", () => {
  const changed = createPriceCatalog({ litellm: { ...LITELLM, entries: { ...LITELLM.entries, "gpt-test-new": LITELLM.entries[Object.keys(LITELLM.entries)[0]!]! } }, modelsDev: MODELS_DEV });
  expect(changed.dataInfo().version).not.toBe(c.dataInfo().version);
  // The same lists downloaded again on another day: nothing new to price with.
  const again = createPriceCatalog({ litellm: { ...LITELLM, date: "2026-10-25" }, modelsDev: { ...MODELS_DEV, date: "2026-10-25" } });
  expect(again.dataInfo().version).toBe(c.dataInfo().version);
  // The same prices written in another order (a key moved upstream): nothing new.
  const reordered = createPriceCatalog({
    litellm: { date: LITELLM.date, entries: Object.fromEntries(Object.entries(LITELLM.entries).reverse().map(([key, entry]) => [key, { rates: { ...entry.rates, base: Object.fromEntries(Object.entries(entry.rates.base).reverse()) }, provider: entry.provider }])) as LitellmPrices["entries"] },
    modelsDev: MODELS_DEV
  });
  expect(reordered.dataInfo().version).toBe(c.dataInfo().version);
});
