import { expect, test } from "bun:test";
import type { ProviderConfig } from "../src/server/config/types.js";
import { ratesForStoredCall, splitStoredAmount, type StoredCostRow } from "../src/server/modules/pricing/call-rates.js";
import { createPriceCatalog } from "../src/server/modules/pricing/catalog.js";
import { connectionFor } from "../src/server/modules/pricing/pricing-pass.js";

// Sample rates, per 1M tokens.
const catalog = createPriceCatalog({
  litellm: {
    date: "2026-01-02",
    entries: Object.assign(Object.create(null), {
      "claude-test": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } } },
      "gpt-test": { provider: "openai", rates: { base: { input: 2, output: 10, cacheRead: 0.1 }, tiers: [{ above: 272_000, rates: { input: 4, output: 15, cacheRead: 0.2 } }] } }
    })
  },
  modelsDev: null
});

const GW = "https://gw.example.test/v1";
const provider = (models: ProviderConfig["models"]): ProviderConfig => ({ type: "openai-compatible", baseURL: GW, apiKey: "", models });
const providers: Record<string, ProviderConfig> = {
  gw: provider([{ id: "m", input: ["text"], price: { input: 1, output: 2, cacheRead: 0.1 } }, { id: "aliased", input: ["text"], price: { as: "litellm:gpt-test" } }])
};

const litellmRef = (modelId: string, providerId = "anthropic") => JSON.stringify({ origin: "litellm", providerId, providerName: "Anthropic", modelId, dataDate: "2026-01-02" });
const yourRef = JSON.stringify({ origin: "your-price", providerId: "your-price", providerName: "Your price", modelId: "", dataDate: null });

function row(o: Partial<StoredCostRow> = {}): StoredCostRow {
  return {
    providerName: "gw", provider: "openai-compatible", baseURL: GW, model: "claude-test",
    costSource: "list", costRef: litellmRef("claude-test"), costMicros: 1_000,
    inputTokens: 100_000, outputTokens: 2_000, cacheReadTokens: 20_000, cacheWriteTokens: 70_000, cacheWrite1hTokens: 0,
    serviceTier: null, ...o
  };
}

test("rates for a list-priced call come from its ref", () => {
  expect(ratesForStoredCall(row(), catalog, providers)).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 });
  for (const costSource of ["catalog", "price_as", "included"]) {
    expect(ratesForStoredCall(row({ costSource }), catalog, providers)?.input).toBe(4);
  }
});

test("a long-context tier applies at the call's input", () => {
  const gpt = { model: "gpt-test", costRef: litellmRef("gpt-test", "openai") };
  expect(ratesForStoredCall(row({ ...gpt, inputTokens: 300_000 }), catalog, providers)).toEqual({ input: 4, output: 15, cacheRead: 0.2 });
  expect(ratesForStoredCall(row({ ...gpt, inputTokens: 100_000 }), catalog, providers)).toEqual({ input: 2, output: 10, cacheRead: 0.1 });
});

test("your price rates come from the connection's model setting", () => {
  const yours = { model: "m", costSource: "your_price", costRef: yourRef };
  expect(ratesForStoredCall(row(yours), catalog, providers)).toEqual({ input: 1, output: 2, cacheRead: 0.1 });
});

test("no rates for reported, free, unpriced, a bad ref, or no catalog", () => {
  expect(ratesForStoredCall(row({ costSource: "reported", costRef: null }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row({ costSource: "free", costRef: null }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row({ costSource: "unpriced", costRef: null }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row({ costSource: null }), catalog, providers)).toBeNull();
  // The source decides: a reported or free amount was not computed from any ref it may carry.
  expect(ratesForStoredCall(row({ costSource: "reported" }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row({ costSource: "free" }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row({ costRef: "{not json" }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row({ costRef: JSON.stringify(["x"]) }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row({ costRef: litellmRef("gone-from-the-list") }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row(), null, providers)).toBeNull();
  // Your price on a connection that is gone, or whose setting is now Price as.
  expect(ratesForStoredCall(row({ model: "m", costSource: "your_price", costRef: yourRef, providerName: "gone" }), catalog, providers)).toBeNull();
  expect(ratesForStoredCall(row({ model: "aliased", costSource: "your_price", costRef: yourRef }), catalog, providers)).toBeNull();
});

test("the split counts tokens as the price did, 1-hour writes at their rate", () => {
  const rates = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 };
  // 10k uncached × 4 + 20k read × 0.2 + (50k × 5 + 20k × 8) + 2k out × 20 = 494,000 micros.
  expect(splitStoredAmount(row({ costMicros: 494_000, cacheWrite1hTokens: 20_000 }), rates))
    .toEqual({ uncachedInput: 40_000, cacheRead: 4_000, cacheWrite: 410_000, output: 40_000 });
});

test("the split adds up to the stored amount", () => {
  const split = splitStoredAmount(row({ costMicros: 1_000_001 }), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })!;
  expect(split.uncachedInput + split.cacheRead + split.cacheWrite + split.output).toBe(1_000_001);
  expect(split.cacheWrite).toBeGreaterThan(split.output);
  // Counts that cannot be true are cut as the price cuts them.
  const clamped = splitStoredAmount(row({ costMicros: 200_000, inputTokens: 50_000, cacheReadTokens: 80_000, cacheWriteTokens: 10_000, outputTokens: 0 }), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })!;
  expect(clamped).toEqual({ uncachedInput: 0, cacheRead: 200_000, cacheWrite: 0, output: 0 });
});

test("rounding leftovers go to the largest part, so the parts still add up", () => {
  // Three equal parts of 100 micros round to 33 each; the leftover 1 goes to one of them.
  const split = splitStoredAmount(row({ costMicros: 100, inputTokens: 3_000, cacheReadTokens: 1_000, cacheWriteTokens: 1_000, outputTokens: 0 }), { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })!;
  expect(split.uncachedInput + split.cacheRead + split.cacheWrite + split.output).toBe(100);
  expect([split.uncachedInput, split.cacheRead, split.cacheWrite].sort()).toEqual([33, 33, 34]);
});

test("a tiny amount is shared out without any part going negative", () => {
  // Four parts of half a micro-dollar each, 2 micros in all.
  const split = splitStoredAmount(row({ costMicros: 2, inputTokens: 150, cacheReadTokens: 50, cacheWriteTokens: 50, outputTokens: 50 }), { input: 0.01, output: 0.01, cacheRead: 0.01, cacheWrite: 0.01 })!;
  const parts = [split.uncachedInput, split.cacheRead, split.cacheWrite, split.output];
  expect(parts.every((p) => p >= 0)).toBe(true);
  expect(parts.reduce((a, b) => a + b, 0)).toBe(2);
});

test("nothing to split: no amount, or rates that price nothing", () => {
  expect(splitStoredAmount(row({ costMicros: null }), { input: 4, output: 20 })).toBeNull();
  expect(splitStoredAmount(row({ costMicros: 500 }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
});

test("a call's connection is the one it was recorded under, never one guessed from its address", () => {
  expect(connectionFor({ providerName: "gw" }, providers)).toBe(providers.gw);
  expect(connectionFor({ providerName: null }, providers)).toBeUndefined();
  expect(connectionFor({ providerName: "gone" }, providers)).toBeUndefined();
  expect(connectionFor({ providerName: "toString" }, providers)).toBeUndefined();
});
