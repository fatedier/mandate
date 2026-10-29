import { isRecord } from "../../../shared/guards.js";
import { usdPerMillion, type ModelRates, type RateSet, type RateTier, type ServiceTierRates } from "./rates.js";

/** LiteLLM's price table (MIT, BerriAI). */
export const LITELLM_PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface LitellmEntry {
  /** LiteLLM's provider id (`openai`, `anthropic`, `gemini`, …). */
  provider: string;
  rates: ModelRates;
}

/** The part of LiteLLM's table Mandate prices with: chat models, core rates. */
export interface LitellmPrices {
  date: string;
  entries: Record<string, LitellmEntry>;
}

const FIELDS: Record<string, keyof RateSet> = {
  input_cost_per_token: "input",
  output_cost_per_token: "output",
  cache_read_input_token_cost: "cacheRead",
  cache_creation_input_token_cost: "cacheWrite",
  cache_creation_input_token_cost_above_1hr: "cacheWrite1h"
};

/** A core field in any of its forms: plain, above a number of thousand input
 *  tokens, and at flex or priority. Batch, ultrafast and the rest are left out. */
const FIELD = /^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost(?:_above_1hr)?)(?:_above_(\d+)k_tokens)?(?:_(flex|priority))?$/;

const MODES = new Set(["chat", "responses"]);

function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? usdPerMillion(value) : undefined;
}

function setOf(group: Map<number, Partial<RateSet>>, above: number): Partial<RateSet> {
  let set = group.get(above);
  if (!set) {
    set = {};
    group.set(above, set);
  }
  return set;
}

function tiersOf(group: Map<number, Partial<RateSet>>): RateTier[] {
  return [...group.entries()].filter(([above]) => above > 0).sort(([a], [b]) => a - b).map(([above, rates]) => ({ above, rates }));
}

function entryRates(raw: Record<string, unknown>): ModelRates | null {
  // Keyed by service tier ("" standard), then threshold (0: no tier).
  const groups = new Map<string, Map<number, Partial<RateSet>>>();
  for (const [key, value] of Object.entries(raw)) {
    const match = FIELD.exec(key);
    if (!match) continue;
    const r = rate(value);
    if (r === undefined) continue;
    const service = match[3] ?? "";
    let group = groups.get(service);
    if (!group) {
      group = new Map();
      groups.set(service, group);
    }
    setOf(group, match[2] ? Number(match[2]) * 1000 : 0)[FIELDS[match[1]!]!] = r;
  }
  const standard = groups.get("");
  const base = standard?.get(0);
  if (!base || base.input === undefined || base.output === undefined) return null;
  const rates: ModelRates = { base: base as RateSet };
  const tiers = standard ? tiersOf(standard) : [];
  if (tiers.length) rates.tiers = tiers;
  for (const service of ["flex", "priority"] as const) {
    const group = groups.get(service);
    if (!group) continue;
    const serviceRates: ServiceTierRates = { base: group.get(0) ?? {} };
    const serviceTiers = tiersOf(group);
    if (serviceTiers.length) serviceRates.tiers = serviceTiers;
    rates[service] = serviceRates;
  }
  return rates;
}

/** LiteLLM's table trimmed to chat models with an input and an output price,
 *  and to the core rates (USD per 1M tokens). */
export function trimLitellm(json: unknown, date: string): LitellmPrices {
  // No prototype: a key such as `__proto__` is an entry like any other.
  const entries = Object.create(null) as Record<string, LitellmEntry>;
  if (!isRecord(json)) return { date, entries };
  for (const [key, raw] of Object.entries(json)) {
    if (key === "sample_spec" || !isRecord(raw) || typeof raw.litellm_provider !== "string" || !MODES.has(String(raw.mode))) continue;
    const rates = entryRates(raw);
    if (rates) entries[key] = { provider: raw.litellm_provider, rates };
  }
  return { date, entries };
}

function own(prices: LitellmPrices, key: string): LitellmEntry | undefined {
  return Object.hasOwn(prices.entries, key) ? prices.entries[key] : undefined;
}

/** A model of a LiteLLM provider, by its id bare or under the provider's prefix. */
export function litellmEntry(prices: LitellmPrices, provider: string, model: string): (LitellmEntry & { key: string }) | null {
  for (const key of [model, `${provider}/${model}`]) {
    const entry = own(prices, key);
    if (entry && entry.provider === provider) return { ...entry, key };
  }
  return null;
}

/** $0 in and $0 out: a model free at its own provider's API, or a
 *  placeholder; never what a paid gateway's model looks like. */
export function isFreeEntry(entry: LitellmEntry): boolean {
  return entry.rates.base.input === 0 && entry.rates.base.output === 0;
}

/** How gateways name a vendor, where LiteLLM's provider id differs. */
const VENDOR_PROVIDER: Record<string, string> = { google: "gemini" };

/** What an id looks like by name alone, for the user to confirm: the whole id
 *  as a key, then the part after a `vendor/` prefix, then that part under the
 *  vendor's LiteLLM provider. */
export function litellmSuggestion(prices: LitellmPrices, model: string): (LitellmEntry & { key: string }) | null {
  const keys = [model];
  const slash = model.indexOf("/");
  if (slash > 0) {
    const vendor = model.slice(0, slash).toLowerCase();
    const rest = model.slice(slash + 1);
    const provider = Object.hasOwn(VENDOR_PROVIDER, vendor) ? VENDOR_PROVIDER[vendor]! : vendor;
    keys.push(rest, `${provider}/${rest}`);
  }
  for (const key of keys) {
    const entry = own(prices, key);
    if (entry && !isFreeEntry(entry)) return { ...entry, key };
  }
  return null;
}

const PROVIDER_NAMES: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google", "vertex_ai-language-models": "Google Vertex AI" };

export function litellmProviderName(provider: string): string {
  return Object.hasOwn(PROVIDER_NAMES, provider) ? PROVIDER_NAMES[provider]! : provider;
}
