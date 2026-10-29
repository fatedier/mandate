import { isRecord } from "../../../shared/guards.js";
import { isPrivateAddress } from "./private-address.js";
import type { ModelRates, RateSet, RateTier } from "./rates.js";

/** models.dev's catalog. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

export interface ModelsDevProvider {
  id: string;
  name: string;
  api: string;
  models: Array<{ id: string; rates: ModelRates }>;
}

/** The part of models.dev Mandate prices with: providers at a public base
 *  URL, and their models that have both an input and an output price, as
 *  core rates. Plans (coding or token plans, or providers whose every model is
 *  $0) are listed apart: their $0 is not a price, and neither is the list
 *  price of a pay-per-use API on the same host. */
export interface ModelsDevPrices {
  date: string;
  providers: ModelsDevProvider[];
  plans: Array<{ id: string; api: string }>;
}

/** models.dev names an AI SDK package instead of a base URL for some
 *  providers; these are the packages' default endpoints. */
const PACKAGE_BASE_URL: Record<string, string> = {
  "@ai-sdk/anthropic": "https://api.anthropic.com/v1",
  "@ai-sdk/openai": "https://api.openai.com/v1",
  "@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta",
  "@ai-sdk/mistral": "https://api.mistral.ai/v1",
  "@ai-sdk/groq": "https://api.groq.com/openai/v1",
  "@ai-sdk/xai": "https://api.x.ai/v1",
  "@ai-sdk/togetherai": "https://api.together.xyz/v1",
  "@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
  "@ai-sdk/cohere": "https://api.cohere.com/v2",
  "@ai-sdk/perplexity": "https://api.perplexity.ai",
  "@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
  "@ai-sdk/gateway": "https://ai-gateway.vercel.sh/v1"
};

const COST_KEYS = [
  ["input", "input"],
  ["output", "output"],
  ["cache_read", "cacheRead"],
  ["cache_write", "cacheWrite"]
] as const;

export function trimModelsDev(apiJson: unknown, date: string): ModelsDevPrices {
  const providers: ModelsDevProvider[] = [];
  const plans: Array<{ id: string; api: string }> = [];
  if (!isRecord(apiJson)) return { date, providers, plans };
  const seen: Array<ModelsDevProvider & { plan: boolean }> = [];
  for (const [key, raw] of Object.entries(apiJson)) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id : key;
    const api = typeof raw.api === "string" && raw.api.trim()
      ? raw.api.trim()
      : typeof raw.npm === "string" && Object.hasOwn(PACKAGE_BASE_URL, raw.npm) ? PACKAGE_BASE_URL[raw.npm]! : "";
    if (!api || isPrivateAddress(api)) continue;
    const name = typeof raw.name === "string" && raw.name ? raw.name : id;
    const models: ModelsDevProvider["models"] = [];
    let priced = 0;
    for (const [modelKey, rawModel] of Object.entries(isRecord(raw.models) ? raw.models : {})) {
      if (!isRecord(rawModel) || !isRecord(rawModel.cost)) continue;
      const rates = ratesOf(rawModel.cost);
      if (!rates) continue;
      priced += 1;
      if (rates.base.input === 0 && rates.base.output === 0) continue;
      models.push({ id: typeof rawModel.id === "string" && rawModel.id ? rawModel.id : modelKey, rates });
    }
    seen.push({ id, name, api, models, plan: /plan/i.test(id) || (priced > 0 && models.length === 0) });
  }
  // An address a pay-per-use provider also serves cannot say a call is on
  // the plan: such a plan is not listed, and its calls are priced as the
  // address's other provider is.
  const payPerUse = new Set(seen.filter((p) => !p.plan && p.models.length > 0).map((p) => normalizedBaseURL(p.api)));
  for (const { plan, ...provider } of seen) {
    if (plan) {
      if (!payPerUse.has(normalizedBaseURL(provider.api))) plans.push({ id: provider.id, api: provider.api });
      continue;
    }
    if (provider.models.length > 0) providers.push(provider);
  }
  return { date, providers, plans };
}

function rateSetOf(raw: Record<string, unknown>): Partial<RateSet> {
  const set: Partial<RateSet> = {};
  for (const [from, to] of COST_KEYS) {
    const value = rate(raw[from]);
    if (value !== undefined) set[to] = value;
  }
  return set;
}

/** A model's cost as core rates: its context tiers (above `size` input
 *  tokens) and `context_over_200k` as the long-context tier. */
function ratesOf(raw: Record<string, unknown>): ModelRates | null {
  const base = rateSetOf(raw);
  if (base.input === undefined || base.output === undefined) return null;
  const tiers: RateTier[] = [];
  for (const tier of Array.isArray(raw.tiers) ? raw.tiers : []) {
    if (!isRecord(tier) || !isRecord(tier.tier) || tier.tier.type !== "context") continue;
    const above = rate(tier.tier.size);
    const rates = rateSetOf(tier);
    if (above !== undefined && Object.keys(rates).length) tiers.push({ above, rates });
  }
  if (isRecord(raw.context_over_200k) && !tiers.some((t) => t.above === 200_000)) {
    const rates = rateSetOf(raw.context_over_200k);
    if (Object.keys(rates).length) tiers.push({ above: 200_000, rates });
  }
  tiers.sort((a, b) => a.above - b.above);
  return tiers.length ? { base: base as RateSet, tiers } : { base: base as RateSet };
}

function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Scheme, host and path of a base URL, without trailing slashes or a final
 *  `/v1`: the same endpoint is configured both ways. */
function normalizedBaseURL(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    const path = parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

export function sameBaseURL(a: string, b: string): boolean {
  const left = normalizedBaseURL(a);
  return left !== null && left === normalizedBaseURL(b);
}
