import { expect, test } from "bun:test";
import { priceUsage, usdPerMillion, type ModelRates, type TokenUsage } from "../src/server/modules/pricing/rates.js";

const usage = (u: Partial<TokenUsage> = {}): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...u });
const usd = (rates: ModelRates, u: Partial<TokenUsage>, tier: string | null = null) => priceUsage(rates, usage(u), tier)!.usd;

test("input and output at their rates per 1M tokens", () => {
  const r = priceUsage({ base: { input: 2, output: 10 } }, usage({ input: 1_000_000, output: 100_000 }), null)!;
  expect(r.usd).toBeCloseTo(3, 12);
  expect(r.noCachePrice).toBe(false);
});

test("cache reads, cache writes and 1-hour writes each at their own rate; the input counts the cached part", () => {
  const rates: ModelRates = { base: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 } };
  // 400k uncached at $2, 400k read at $0.20, 150k 5-minute writes at $2.50, 50k 1-hour writes at $4.
  expect(usd(rates, { input: 1_000_000, cacheRead: 400_000, cacheWrite: 200_000, cacheWrite1h: 50_000 })).toBeCloseTo(0.8 + 0.08 + 0.375 + 0.2, 12);
});

test("no cache rates: cache tokens at the input rate, and the call says so", () => {
  const r = priceUsage({ base: { input: 2, output: 10 } }, usage({ input: 1_000_000, cacheRead: 400_000, cacheWrite: 200_000 }), null)!;
  expect(r.usd).toBeCloseTo(2, 12);
  expect(r.noCachePrice).toBe(true);
  expect(priceUsage({ base: { input: 2, output: 10, cacheRead: 0.2 } }, usage({ input: 1_000_000, cacheWrite: 200_000 }), null)!.noCachePrice).toBe(true);
  expect(priceUsage({ base: { input: 2, output: 10, cacheWrite: 2.5 } }, usage({ input: 1_000_000, cacheRead: 200_000 }), null)!.noCachePrice).toBe(true);
  expect(priceUsage({ base: { input: 2, output: 10 } }, usage({ input: 1_000_000 }), null)!.noCachePrice).toBe(false);
});

test("no 1-hour rate: 1-hour writes at the cache write rate", () => {
  const r = priceUsage({ base: { input: 2, output: 10, cacheWrite: 2.5 } }, usage({ input: 1_000_000, cacheWrite: 200_000, cacheWrite1h: 100_000 }), null)!;
  expect(r.usd).toBeCloseTo(1.6 + 0.5, 12);
  expect(r.noCachePrice).toBe(false);
});

test("a long-context tier prices the whole request, from one token above its threshold", () => {
  const rates: ModelRates = { base: { input: 2, output: 10 }, tiers: [{ above: 272_000, rates: { input: 4, output: 15 } }] };
  expect(usd(rates, { input: 272_000, output: 1_000 })).toBeCloseTo(0.544 + 0.01, 12);
  expect(usd(rates, { input: 272_001, output: 1_000 })).toBeCloseTo(4 * 0.272001 + 0.015, 12);
});

test("of several tiers, the highest one below the input applies; a tier keeps the rates it does not name", () => {
  for (const tiers of [[{ above: 400_000, rates: { input: 6 } }, { above: 200_000, rates: { input: 4 } }], [{ above: 200_000, rates: { input: 4 } }, { above: 400_000, rates: { input: 6 } }]]) {
    const rates: ModelRates = { base: { input: 2, output: 10, cacheRead: 0.2 }, tiers };
    expect(usd(rates, { input: 300_000, output: 100_000 })).toBeCloseTo(1.2 + 1, 12);
    expect(usd(rates, { input: 500_000, cacheRead: 100_000 })).toBeCloseTo(6 * 0.4 + 0.02, 12);
  }
});

test("flex and priority rates for a call made at that tier; the rates they do not name stay standard", () => {
  const rates: ModelRates = { base: { input: 2, output: 10 }, flex: { base: { input: 1 } }, priority: { base: { input: 4, output: 20 } } };
  expect(usd(rates, { input: 1_000_000, output: 100_000 }, "flex")).toBeCloseTo(1 + 1, 12);
  expect(usd(rates, { input: 1_000_000, output: 100_000 }, "priority")).toBeCloseTo(4 + 2, 12);
  for (const tier of ["default", "auto", "scale", "standard", null]) {
    expect(usd(rates, { input: 1_000_000, output: 100_000 }, tier)).toBeCloseTo(2 + 1, 12);
  }
});

test("a tier with a long-context rate of its own uses it; without one, above the standard tier the standard tier applies", () => {
  const tiers = [{ above: 272_000, rates: { input: 4, output: 15 } }];
  const own: ModelRates = { base: { input: 2, output: 10 }, tiers, flex: { base: { input: 1, output: 5 }, tiers: [{ above: 272_000, rates: { input: 2, output: 7.5 } }] } };
  expect(usd(own, { input: 300_000 }, "flex")).toBeCloseTo(0.6, 12);
  const none: ModelRates = { base: { input: 2, output: 10 }, tiers, flex: { base: { input: 1, output: 5 } } };
  expect(usd(none, { input: 300_000 }, "flex")).toBeCloseTo(1.2, 12);
  expect(usd(none, { input: 100_000 }, "flex")).toBeCloseTo(0.1, 12);
  // The service tier's long-context rate is for its own threshold: above a
  // higher standard tier it has none for, the standard tier stands.
  const two: ModelRates = {
    base: { input: 2, output: 10 },
    tiers: [{ above: 200_000, rates: { input: 4, output: 15 } }, { above: 400_000, rates: { input: 6, output: 20 } }],
    flex: { base: { input: 1, output: 5 }, tiers: [{ above: 200_000, rates: { input: 2, output: 7.5 } }] }
  };
  expect(usd(two, { input: 500_000, output: 100_000 }, "flex")).toBeCloseTo(3 + 2, 12);
  expect(usd(two, { input: 300_000, output: 100_000 }, "flex")).toBeCloseTo(0.6 + 0.75, 12);
  // A long-context rate only the service tier has still applies above its threshold.
  const flexOnly: ModelRates = { base: { input: 2, output: 10 }, flex: { base: { input: 1, output: 5 }, tiers: [{ above: 272_000, rates: { input: 2 } }] } };
  expect(usd(flexOnly, { input: 300_000 }, "flex")).toBeCloseTo(0.6, 12);
  expect(usd(flexOnly, { input: 100_000 }, "flex")).toBeCloseTo(0.1, 12);
});

test("counts that cannot be true are cut to what can: more cached than the prompt, more 1-hour than all writes", () => {
  const rates: ModelRates = { base: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 } };
  expect(usd(rates, { input: 100, cacheRead: 500 })).toBeCloseTo(100 * 0.2 / 1e6, 15);
  expect(usd(rates, { input: 100, cacheWrite: 50, cacheWrite1h: 80 })).toBeCloseTo((50 * 2 + 50 * 4) / 1e6, 15);
  expect(usd(rates, { input: -5, output: -5 })).toBe(0);
});

test("rates that give no finite amount give none", () => {
  expect(priceUsage({ base: { input: 1e308, output: 1e308 } }, usage({ input: 1e20 }), null)).toBeNull();
  expect(priceUsage({ base: { input: Number.NaN, output: 1 } }, usage({ input: 1 }), null)).toBeNull();
});

test("per-token rates as per-1M, without float noise", () => {
  expect(usdPerMillion(2.5e-6)).toBe(2.5);
  expect(usdPerMillion(1.1e-7)).toBe(0.11);
  expect(usdPerMillion(2.8e-8)).toBe(0.028);
});
