import { isRecord } from "../../../shared/guards.js";
import { usdPerMillion, type ModelRates, type RateSet } from "./rates.js";

/** OpenRouter's public model list, every output type: its default lists only
 *  models that answer in text, and a model that answers otherwise (a
 *  decision model) is priced per token all the same. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models?output_modalities=all";

/** OpenRouter's own address, where its list is a connection's own prices. */
export const OPENROUTER_API = "https://openrouter.ai/api/v1";

export interface OpenRouterEntry {
  rates: ModelRates;
}

/** The part of OpenRouter's list Mandate prices with: each model by its id,
 *  its core rates (USD per 1M tokens). */
export interface OpenRouterPrices {
  date: string;
  entries: Record<string, OpenRouterEntry>;
}

const FIELDS: Record<string, keyof RateSet> = {
  prompt: "input",
  completion: "output",
  input_cache_read: "cacheRead",
  input_cache_write: "cacheWrite"
};

/** A price per token, as OpenRouter writes it (a decimal string); a negative
 *  one (a router's, which depends on the model it picks) is no price. */
function rate(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? usdPerMillion(n) : undefined;
}

/** OpenRouter's list trimmed to the models with an input and an output price,
 *  and to the core rates. */
export function trimOpenRouter(json: unknown, date: string): OpenRouterPrices {
  // No prototype: an id such as `__proto__` is a model like any other.
  const entries = Object.create(null) as Record<string, OpenRouterEntry>;
  const models = isRecord(json) && Array.isArray(json.data) ? json.data : [];
  for (const model of models) {
    if (!isRecord(model) || typeof model.id !== "string" || !model.id || !isRecord(model.pricing)) continue;
    const base: Partial<RateSet> = {};
    for (const [field, key] of Object.entries(FIELDS)) {
      const r = rate(model.pricing[field]);
      if (r !== undefined) base[key] = r;
    }
    if (base.input === undefined || base.output === undefined) continue;
    entries[model.id] = { rates: { base: base as RateSet } };
  }
  return { date, entries };
}

/** A model by its id, exactly. */
export function openRouterEntry(prices: OpenRouterPrices, model: string): OpenRouterEntry | null {
  return Object.hasOwn(prices.entries, model) ? prices.entries[model]! : null;
}
