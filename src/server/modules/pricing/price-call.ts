import type { CostNote, CostSource, ModelPriceSetting, ProviderBilling } from "../../../shared/api/pricing.js";
import type { CatalogPrice, PriceCatalog, PriceRef, TokenUsage } from "./catalog.js";

export interface CallForPricing {
  providerType: string;
  baseURL: string;
  model: string;
  startedAt: string;
  status: string;
  ttftMs: number | null;
  usage: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    cacheWrite1h: number | null;
  };
  serviceTier: string | null;
  reportedMicros: number | null;
}

export interface ConnectionPricing {
  billing: ProviderBilling;
  price?: ModelPriceSetting;
}

export interface PricedCall {
  source: CostSource;
  micros: number | null;
  /** For an Included call: what it would cost at API prices, when known. */
  apiMicros: number | null;
  ref: PriceRef | null;
  note: CostNote | null;
}

/** USD to whole micro-dollars. The product is rounded to 12 significant digits
 *  first: a float like 31.4999999… micro-dollars is 31.5 and rounds up. */
const roundMicros = (value: number) => Math.round(Number(value.toPrecision(12)));
const micros = (usd: number) => roundMicros(usd * 1_000_000);

/**
 * A call's amount and where it came from, in the order the user chose: a plan
 * or free connection first; then your price, the cost the gateway reported,
 * Price as, LiteLLM's list price for OpenAI's, Anthropic's and Google's own
 * APIs (and Codex), models.dev at the connection's URL, the price of the
 * model's name, and
 * otherwise Unpriced (always, without a price of the user's, at a plan's
 * address). A call without usage is Unpriced only when the provider
 * had started answering (it was probably billed); never answered, it has no
 * amount at all.
 */
export function priceCall(call: CallForPricing, connection: ConnectionPricing | null, catalog: PriceCatalog): PricedCall {
  const billing = connection?.billing ?? "usage";
  const setting = connection?.price;
  const hasUsage = call.usage.input !== null || call.usage.output !== null;
  const usage: TokenUsage = {
    input: call.usage.input ?? 0,
    output: call.usage.output ?? 0,
    cacheRead: call.usage.cacheRead ?? 0,
    cacheWrite: call.usage.cacheWrite ?? 0,
    cacheWrite1h: call.usage.cacheWrite1h ?? 0
  };
  // Prices are today's: the call's start time does not choose a rate.
  const moment = { serviceTier: call.serviceTier, usage };
  const query = { ...moment, model: call.model, baseURL: call.baseURL, providerType: call.providerType };
  const fromSetting = (): { price: CatalogPrice; source: CostSource } | null => {
    if (!setting) return null;
    if ("as" in setting) {
      const price = catalog.priceAs(setting.as, moment);
      return price ? { price, source: "price_as" } : null;
    }
    const yours = catalog.yourPrice(setting, moment);
    return yours ? { price: yours, source: "your_price" } : null;
  };
  const listed = () => catalog.listPrice(query) ?? catalog.catalogPrice(query) ?? catalog.namePrice(query);

  if (billing === "free") return { source: "free", micros: null, apiMicros: null, ref: null, note: null };
  if (billing === "plan") {
    const reference = hasUsage ? (fromSetting()?.price ?? listed()) : null;
    return { source: "included", micros: null, apiMicros: reference ? micros(reference.usd) : null, ref: reference?.ref ?? null, note: null };
  }
  const reported = (): PricedCall => ({ source: "reported", micros: roundMicros(call.reportedMicros!), apiMicros: null, ref: null, note: null });
  if (!hasUsage) {
    // A charge the gateway reported needs no token counts.
    if (call.reportedMicros !== null) return reported();
    if (call.status !== "failed") return { source: "unpriced", micros: null, apiMicros: null, ref: null, note: null };
    return call.ttftMs === null
      ? { source: "none", micros: null, apiMicros: null, ref: null, note: null }
      : { source: "unpriced", micros: null, apiMicros: null, ref: null, note: "failed_no_usage" };
  }

  const priced = (price: CatalogPrice, source: CostSource): PricedCall =>
    ({ source, micros: micros(price.usd), apiMicros: null, ref: price.ref, note: price.noCachePrice ? "no_cache_price" : null });

  if (setting && !("as" in setting)) {
    // The user's own rates decide, even when they give no amount.
    const yours = catalog.yourPrice(setting, moment);
    return yours ? priced(yours, "your_price") : { source: "unpriced", micros: null, apiMicros: null, ref: null, note: null };
  }
  if (call.reportedMicros !== null) return reported();
  const asPrice = setting ? fromSetting() : null;
  if (asPrice) return priced(asPrice.price, asPrice.source);
  // A plan's address: what it costs is the plan, not the list price of the
  // API on the same host. Unpriced until the user says how it bills.
  if (call.baseURL && catalog.isPlanProvider(call.baseURL)) return { source: "unpriced", micros: null, apiMicros: null, ref: null, note: null };
  const list = catalog.listPrice(query);
  if (list) return priced(list, "list");
  const fill = catalog.catalogPrice(query);
  if (fill) return priced(fill, "catalog");
  // Last, the price of the model's name (the part after any prefix), as the
  // list it came from prices it.
  const named = catalog.namePrice(query);
  if (named) return priced(named, named.ref.origin === "litellm" ? "list" : "catalog");
  return { source: "unpriced", micros: null, apiMicros: null, ref: null, note: null };
}
