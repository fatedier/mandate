/**
 * Mandate's price arithmetic, for the core parameters only: input, output,
 * cache read, cache write, 1-hour cache write, a long-context tier, and flex
 * and priority rates. Nothing else (time of day, batch, audio, fees) is priced.
 */

export interface TokenUsage {
  /** The whole prompt, cached part included. */
  input: number;
  output: number;
  cacheRead: number;
  /** Every cache write, the 1-hour ones included. */
  cacheWrite: number;
  cacheWrite1h: number;
}

/** USD per 1M tokens. A missing cache rate is the input rate; a missing
 *  1-hour write rate is the cache write rate. */
export interface RateSet {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** Above `above` input tokens, the whole request takes these rates (the ones
 *  it names; the rest stay as they were). */
export interface RateTier {
  above: number;
  rates: Partial<RateSet>;
}

export interface ServiceTierRates {
  base: Partial<RateSet>;
  tiers?: RateTier[];
}

export interface ModelRates {
  base: RateSet;
  tiers?: RateTier[];
  flex?: ServiceTierRates;
  priority?: ServiceTierRates;
}

/** The tier a request of `input` tokens falls in: the highest threshold below it. */
function tierFor(tiers: RateTier[] | undefined, input: number): RateTier | undefined {
  let found: RateTier | undefined;
  for (const tier of tiers ?? []) {
    if (input > tier.above && (!found || tier.above > found.above)) found = tier;
  }
  return found;
}

/**
 * The rates a request is billed at: the standard rates, then its long-context
 * tier; at flex or priority, that tier's own rates over them. Above a standard
 * tier the service tier gives no rate for, the standard tier stands: its
 * long-context price is not known, and the standard one is the safer guess.
 */
export function effectiveRates(rates: ModelRates, input: number, serviceTier: string | null): RateSet {
  const tier = tierFor(rates.tiers, input);
  let result: RateSet = { ...rates.base, ...tier?.rates };
  const service = serviceTier === "flex" ? rates.flex : serviceTier === "priority" ? rates.priority : undefined;
  if (service) {
    // Its own rate for this request's tier: the one at the same threshold.
    const serviceTierRates = tier ? service.tiers?.find((t) => t.above === tier.above) : tierFor(service.tiers, input);
    if (!tier || serviceTierRates) result = { ...result, ...service.base, ...serviceTierRates?.rates };
  }
  return result;
}

const nonNegative = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** What a call's tokens cost at these rates; null when that is not a finite
 *  amount. Counts that cannot be true are cut to what can. */
export function priceUsage(rates: ModelRates, usage: TokenUsage, serviceTier: string | null): { usd: number; noCachePrice: boolean; rates: RateSet } | null {
  const r = effectiveRates(rates, nonNegative(usage.input), serviceTier);
  const parts = usageParts(r, usage);
  const usd = parts.uncachedInput + parts.cacheRead + parts.cacheWrite + parts.output;
  if (!Number.isFinite(usd)) return null;
  const counts = clampedCounts(usage);
  return {
    usd,
    noCachePrice: (counts.cacheRead > 0 && r.cacheRead === undefined) || (counts.cacheWrite > 0 && r.cacheWrite === undefined),
    rates: r
  };
}

/** Counts that cannot be true cut to what can: reads within the prompt,
 *  writes within the rest, 1-hour writes within the writes. */
function clampedCounts(usage: TokenUsage) {
  const input = nonNegative(usage.input);
  const cacheRead = Math.min(nonNegative(usage.cacheRead), input);
  const cacheWrite = Math.min(nonNegative(usage.cacheWrite), input - cacheRead);
  return { input, output: nonNegative(usage.output), cacheRead, cacheWrite, cacheWrite1h: Math.min(nonNegative(usage.cacheWrite1h), cacheWrite) };
}

/** What each kind of token cost at these (effective) rates, in USD: the parts
 *  `priceUsage` adds up. 1-hour writes are part of the cache write. */
export function usageParts(r: RateSet, usage: TokenUsage): { uncachedInput: number; cacheRead: number; cacheWrite: number; output: number } {
  const c = clampedCounts(usage);
  const readRate = r.cacheRead ?? r.input;
  const writeRate = r.cacheWrite ?? r.input;
  const write1hRate = r.cacheWrite1h ?? writeRate;
  return {
    uncachedInput: ((c.input - c.cacheRead - c.cacheWrite) * r.input) / 1_000_000,
    cacheRead: (c.cacheRead * readRate) / 1_000_000,
    cacheWrite: ((c.cacheWrite - c.cacheWrite1h) * writeRate + c.cacheWrite1h * write1hRate) / 1_000_000,
    output: (c.output * r.output) / 1_000_000
  };
}

/** A per-token rate as USD per 1M tokens, at 12 significant digits: 2.5e-6
 *  is 2.5, not 2.4999999999999996. */
export function usdPerMillion(perToken: number): number {
  return Number((perToken * 1_000_000).toPrecision(12));
}
