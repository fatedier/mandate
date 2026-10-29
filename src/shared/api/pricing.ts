/** Per-1M-token USD rates of a catalog model, as shown beside a match. A
 *  cache rate is null when the price list has none (those tokens are then
 *  priced at the input rate; a 1-hour write at the cache write rate). */
export interface PriceRates {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  cacheWrite1h: number | null;
}

/** A price the user typed for a model, USD per 1M tokens. */
export interface CustomPriceSetting {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
}

/** Where a call's amount came from. `none`: a failed call the provider never
 *  answered — nothing to count. */
export type CostSource = "reported" | "your_price" | "price_as" | "list" | "catalog" | "included" | "free" | "unpriced" | "none";

export type CostNote = "no_cache_price" | "failed_no_usage";

/** A model's price setting: a catalog model's price (`as` is its key,
 *  `litellm:<key>` or `models.dev:<provider>/<model>`), or the user's own.
 *  Absent: Automatic. */
export type ModelPriceSetting = { as: string } | CustomPriceSetting;

/** How a provider connection charges: per use, through a plan, or not at all. */
export type ProviderBilling = "usage" | "plan" | "free";

/** What a call cost and where that came from; null on a call not priced yet. */
export interface CallCostDto {
  source: CostSource;
  micros: number | null;
  /** An Included call's cost at API prices, when known. */
  apiMicros: number | null;
  /** The price list's provider and model it was priced as (list, catalog,
   *  price as, or an Included call's reference). */
  priceProvider: string | null;
  priceModel: string | null;
  /** Which price list that came from. */
  priceOrigin: "litellm" | "models.dev" | null;
  /** The date of the price data used. */
  dataDate: string | null;
  /** The connection that reported the cost, for a reported one. */
  reportedBy: string | null;
  note: CostNote | null;
}

/** A catalog model, as Settings shows a match, a suggestion or a search hit. */
export interface PriceMatchDto {
  /** The key a Price as setting stores. */
  ref: string;
  label: string;
  origin: "litellm" | "models.dev";
  rates: PriceRates;
  dataDate: string | null;
}

export interface PriceMatchResponse {
  found: PriceMatchDto | null;
  suggestion: PriceMatchDto | null;
}

export interface ProviderPricingResponse {
  /** The connection's address looks like a plan's: Settings suggests billing it so. */
  planSuggested: boolean;
  models: Record<string, PriceMatchResponse>;
}

export interface PriceCatalogResponse {
  results: PriceMatchDto[];
}

export interface PricingStatusResponse {
  autoUpdate: boolean;
  litellmDate: string | null;
  modelsDevDate: string | null;
}
