import type { ProviderConfig } from "../../config/types.js";
import { isRecord } from "../../../shared/guards.js";
import { refKey, type PriceCatalog, type PriceRef } from "./catalog.js";
import { connectionFor } from "./pricing-pass.js";
import { usageParts, type RateSet, type TokenUsage } from "./rates.js";

/** The stored columns of a priced call that its rates and split are read from. */
export interface StoredCostRow {
  providerName: string | null;
  provider: string;
  baseURL: string | null;
  model: string | null;
  costSource: string | null;
  costRef: string | null;
  costMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  serviceTier: string | null;
}

export interface TokenSplit {
  uncachedInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Sources whose stored ref names the rates the amount was computed with. */
const RATED_SOURCES = new Set(["list", "catalog", "price_as", "your_price", "included"]);

function usageOf(row: StoredCostRow): TokenUsage {
  return {
    input: row.inputTokens ?? 0,
    output: row.outputTokens ?? 0,
    cacheRead: row.cacheReadTokens ?? 0,
    cacheWrite: row.cacheWriteTokens ?? 0,
    cacheWrite1h: row.cacheWrite1hTokens ?? 0
  };
}

/** Parsed once per distinct text: thousands of calls share a handful of refs. */
const refs = new Map<string, Pick<PriceRef, "origin" | "providerId" | "modelId"> | null>();

function readRef(text: string | null): Pick<PriceRef, "origin" | "providerId" | "modelId"> | null {
  if (!text) return null;
  if (refs.has(text)) return refs.get(text)!;
  const ref = parseRef(text);
  if (refs.size > 1000) refs.clear();
  refs.set(text, ref);
  return ref;
}

function parseRef(text: string): Pick<PriceRef, "origin" | "providerId" | "modelId"> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || typeof value.origin !== "string" || typeof value.providerId !== "string" || typeof value.modelId !== "string") return null;
    if (value.origin !== "litellm" && value.origin !== "models.dev" && value.origin !== "openrouter" && value.origin !== "your-price") return null;
    return { origin: value.origin, providerId: value.providerId, modelId: value.modelId };
  } catch {
    return null;
  }
}

/**
 * The rates a stored amount was computed with, looked up again: a price
 * list's entry by the call's ref, or the user's own price on its connection;
 * the long-context tier and service tier for its tokens applied. Null for an
 * amount with no rates behind it (reported, free, unpriced) or rates that are
 * no longer to be found.
 */
export function ratesForStoredCall(row: StoredCostRow, catalog: PriceCatalog | null, providers: Record<string, ProviderConfig>): RateSet | null {
  if (!catalog || !row.costSource || !RATED_SOURCES.has(row.costSource)) return null;
  const ref = readRef(row.costRef);
  if (!ref) return null;
  const moment = { serviceTier: row.serviceTier, usage: usageOf(row) };
  if (ref.origin === "your-price") {
    const connection = connectionFor(row, providers);
    const setting = connection?.models.find((m) => m.id === row.model)?.price;
    if (!setting || "as" in setting) return null;
    return catalog.yourPrice(setting, moment)?.rates ?? null;
  }
  return catalog.priceAs(refKey(ref), moment)?.rates ?? null;
}

/**
 * A stored amount split by kind of token: each part at the rates as the
 * price counts it, then scaled so the parts add up to the amount exactly in
 * whole micro-dollars — each part rounded down, and the micro-dollars left
 * over given one each to the parts with the largest remainders, so no part
 * goes negative. Null when there is no amount, or the rates price none of the
 * tokens.
 */
export function splitStoredAmount(row: StoredCostRow, rates: RateSet): TokenSplit | null {
  const amount = row.costMicros;
  if (amount === null || !Number.isFinite(amount) || amount < 0) return null;
  const parts = usageParts(rates, usageOf(row));
  const total = parts.uncachedInput + parts.cacheRead + parts.cacheWrite + parts.output;
  if (!(total > 0)) return null;
  const keys = ["uncachedInput", "cacheRead", "cacheWrite", "output"] as const;
  const split: TokenSplit = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const remainders = keys.map((key) => {
    const exact = (parts[key] / total) * Math.round(amount);
    split[key] = Math.floor(exact);
    return { key, rest: exact - split[key] };
  });
  let left = Math.round(amount) - keys.reduce((sum, key) => sum + split[key], 0);
  for (const { key } of remainders.sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    split[key] += 1;
    left -= 1;
  }
  return split;
}

/**
 * The rates a gateway-reported amount is shared out by: those the call would
 * have been priced at without the report (your price or Price as on its
 * connection, else the list for its model, as pricing looks them up), looked
 * up now. The amount stays the gateway's; the rates only say which part of
 * it each kind of token took. Null for any other source, or a model no price
 * names.
 */
export function ratesForReportedCall(row: StoredCostRow, catalog: PriceCatalog | null, providers: Record<string, ProviderConfig>): RateSet | null {
  if (!catalog || row.costSource !== "reported" || !row.model) return null;
  const moment = { serviceTier: row.serviceTier, usage: usageOf(row) };
  const setting = connectionFor(row, providers)?.models.find((m) => m.id === row.model)?.price;
  // As priceCall decides: your own rates, even when they give nothing; Price
  // as when its entry is still there, else the lists.
  if (setting && !("as" in setting)) return catalog.yourPrice(setting, moment)?.rates ?? null;
  const as = setting ? catalog.priceAs(setting.as, moment) : null;
  if (as) return as.rates;
  const query = { ...moment, model: row.model, baseURL: row.baseURL ?? "", providerType: row.provider };
  return (catalog.listPrice(query) ?? catalog.catalogPrice(query) ?? catalog.namePrice(query))?.rates ?? null;
}

/** The rates a stored amount is read by: its own for an amount priced from
 *  them, the shared-out ones for a reported amount. */
export function ratesForCall(row: StoredCostRow, catalog: PriceCatalog | null, providers: Record<string, ProviderConfig>): RateSet | null {
  return row.costSource === "reported" ? ratesForReportedCall(row, catalog, providers) : ratesForStoredCall(row, catalog, providers);
}

/** What an amount at these rates is to be scaled by to be the stored one: 1
 *  for an amount priced from them; for a reported amount, what the gateway
 *  charged over what the rates give for the call's tokens (null when they give
 *  nothing). */
export function storedScale(row: StoredCostRow, rates: RateSet): number | null {
  if (row.costSource !== "reported") return 1;
  const parts = usageParts(rates, usageOf(row));
  const total = parts.uncachedInput + parts.cacheRead + parts.cacheWrite + parts.output;
  const amount = row.costMicros;
  if (!(total > 0) || amount === null || !Number.isFinite(amount) || amount < 0) return null;
  // The parts are in dollars, the amount in micro-dollars.
  return amount / (total * 1_000_000);
}
