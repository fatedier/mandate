import type { CustomPriceSetting, PriceRates } from "../../../shared/api/pricing.js";
import { isFreeEntry, litellmEntry, litellmProviderName, litellmSuggestion, type LitellmEntry, type LitellmPrices } from "./litellm.js";
import { normalizedBaseURL, sameBaseURL, type ModelsDevPrices } from "./models-dev.js";
import { OPENROUTER_API, openRouterEntry, type OpenRouterEntry, type OpenRouterPrices } from "./openrouter.js";
import { isPrivateAddress } from "./private-address.js";
import { sha256 } from "../../platform/crypto/hash.js";
import { priceUsage, type ModelRates, type RateSet, type TokenUsage } from "./rates.js";

export type { TokenUsage } from "./rates.js";

export interface PriceQuery {
  model: string;
  baseURL: string;
  /** The connection's type: a Codex connection is priced as OpenAI's API. */
  providerType: string;
  serviceTier: string | null;
  usage: TokenUsage;
}

type PricingMoment = Pick<PriceQuery, "serviceTier" | "usage">;

export interface PriceRef {
  origin: "litellm" | "models.dev" | "openrouter" | "your-price";
  providerId: string;
  providerName: string;
  /** The model's key in its price list (LiteLLM's key, models.dev's id, or
   *  OpenRouter's id). */
  modelId: string;
  dataDate: string | null;
}

export interface CatalogPrice {
  usd: number;
  ref: PriceRef;
  /** Cache tokens were counted at the input price for want of a cache price. */
  noCachePrice: boolean;
  /** The rates the request was billed at. */
  rates: RateSet;
}

export type CustomPrice = CustomPriceSetting;

export interface PriceMatch {
  ref: PriceRef;
  label: string;
  rates: PriceRates;
}

export interface PriceCatalog {
  /** LiteLLM, for OpenAI's, Anthropic's and Google's own APIs and Codex. */
  listPrice(q: PriceQuery): CatalogPrice | null;
  /** models.dev, for a provider at this exact base URL. */
  catalogPrice(q: PriceQuery): CatalogPrice | null;
  /** By the model's name (the price of the name after any prefix), for a
   *  connection no list knows by its address; never at a local
   *  or private address. */
  namePrice(q: PriceQuery): CatalogPrice | null;
  priceAs(key: string, q: PricingMoment): CatalogPrice | null;
  /** Null when the rates give no amount. */
  yourPrice(price: CustomPrice, q: PricingMoment): CatalogPrice | null;
  /** What Automatic finds for a model on a connection. */
  match(model: string, baseURL: string, providerType: string): PriceMatch | null;
  /** A guess by name, for the user to confirm; never used to price. */
  suggest(model: string): PriceMatch | null;
  search(query: string, limit: number): PriceMatch[];
  isPlanProvider(baseURL: string): boolean;
  dataInfo(): { litellmDate: string | null; modelsDevDate: string | null; openrouterDate: string | null; version: string };
  /** The lists it prices from: another thread builds the same catalog from them. */
  sources(): PriceSources;
}

/** The price lists a catalog is built from. */
export interface PriceSources {
  litellm: LitellmPrices | null;
  modelsDev: ModelsDevPrices | null;
  openrouter?: OpenRouterPrices | null;
}

export function refKey(ref: Pick<PriceRef, "origin" | "providerId" | "modelId">): string {
  return ref.origin === "litellm" || ref.origin === "openrouter" ? `${ref.origin}:${ref.modelId}` : `${ref.origin}:${ref.providerId}/${ref.modelId}`;
}

type ParsedKey = { origin: "litellm"; key: string } | { origin: "openrouter"; key: string } | { origin: "models.dev"; providerId: string; modelId: string };

function parseRefKey(key: string): ParsedKey | null {
  if (key.startsWith("litellm:")) {
    const rest = key.slice("litellm:".length);
    return rest ? { origin: "litellm", key: rest } : null;
  }
  if (key.startsWith("openrouter:")) {
    const rest = key.slice("openrouter:".length);
    return rest ? { origin: "openrouter", key: rest } : null;
  }
  if (!key.startsWith("models.dev:")) return null;
  const rest = key.slice("models.dev:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { origin: "models.dev", providerId: rest.slice(0, slash), modelId: rest.slice(slash + 1) };
}

/** The hosts whose own API LiteLLM prices, by LiteLLM's provider id. */
const API_HOSTS: Record<string, string> = {
  "api.openai.com": "openai",
  "api.anthropic.com": "anthropic",
  "generativelanguage.googleapis.com": "gemini"
};

/** The LiteLLM provider a connection is priced as: Codex is OpenAI's models;
 *  otherwise only a connection at one of those hosts, exactly. */
function litellmProviderOf(providerType: string, baseURL: string): string | null {
  if (providerType === "codex") return "openai";
  try {
    const host = new URL(baseURL.trim()).hostname.toLowerCase().replace(/\.$/, "");
    return Object.hasOwn(API_HOSTS, host) ? API_HOSTS[host]! : null;
  } catch {
    return null;
  }
}

function toPriceRates(r: RateSet): PriceRates {
  return { input: r.input, output: r.output, cacheRead: r.cacheRead ?? null, cacheWrite: r.cacheWrite ?? null, cacheWrite1h: r.cacheWrite1h ?? null };
}

/** A model's name in a label: a LiteLLM key without its provider's prefix. */
function shownModel(ref: PriceRef): string {
  return ref.origin === "litellm" && ref.modelId.startsWith(`${ref.providerId}/`) ? ref.modelId.slice(ref.providerId.length + 1) : ref.modelId;
}

const PROBE: TokenUsage = { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };

export function createPriceCatalog(input: PriceSources): PriceCatalog {
  const { litellm, modelsDev } = input;
  const openrouter = input.openrouter ?? null;

  const priced = (rates: ModelRates, q: PricingMoment, ref: PriceRef): CatalogPrice | null => {
    const r = priceUsage(rates, q.usage, q.serviceTier);
    return r ? { usd: r.usd, ref, noCachePrice: r.noCachePrice, rates: r.rates } : null;
  };

  const fromLitellm = (entry: LitellmEntry & { key: string }, q: PricingMoment): CatalogPrice | null =>
    priced(entry.rates, q, { origin: "litellm", providerId: entry.provider, providerName: litellmProviderName(entry.provider), modelId: entry.key, dataDate: litellm?.date ?? null });

  // models.dev's providers by their address, read once. A window's calls are
  // looked up one by one, and comparing each call's address with every
  // provider's parsed both again for every call.
  const providersAt = new Map<string, ModelsDevPrices["providers"]>();
  for (const provider of modelsDev?.providers ?? []) {
    const address = normalizedBaseURL(provider.api);
    if (address === null) continue;
    const there = providersAt.get(address);
    if (there) there.push(provider);
    else providersAt.set(address, [provider]);
  }

  const modelsDevModel = (providerId: string, modelId: string) => {
    const provider = modelsDev?.providers.find((p) => p.id === providerId);
    const model = provider?.models.find((m) => m.id === modelId);
    return provider && model ? { provider, model } : null;
  };

  const fromModelsDev = (found: NonNullable<ReturnType<typeof modelsDevModel>>, q: PricingMoment): CatalogPrice | null =>
    priced(found.model.rates, q, { origin: "models.dev", providerId: found.provider.id, providerName: found.provider.name, modelId: found.model.id, dataDate: modelsDev?.date ?? null });

  const fromOpenRouter = (id: string, entry: OpenRouterEntry, q: PricingMoment): CatalogPrice | null =>
    priced(entry.rates, q, { origin: "openrouter", providerId: "openrouter", providerName: "OpenRouter", modelId: id, dataDate: openrouter?.date ?? null });

  /** OpenRouter's model of this id, exactly; by name never a $0 one. */
  const openRouterModel = (id: string, freeToo: boolean) => {
    const entry = openrouter ? openRouterEntry(openrouter, id) : null;
    return entry && (freeToo || entry.rates.base.input > 0 || entry.rates.base.output > 0) ? entry : null;
  };

  const toMatch = (price: CatalogPrice | null): PriceMatch | null =>
    price ? { ref: price.ref, label: `${price.ref.providerName} ${shownModel(price.ref)}`, rates: toPriceRates(price.rates) } : null;

  const probe = (model: string, baseURL: string, providerType: string): PriceQuery => ({ model, baseURL, providerType, serviceTier: null, usage: PROBE });

  /** A model by its name: LiteLLM (the whole id, the part after a prefix,
   *  that part under the vendor; never a $0 entry), then a prefix that names
   *  a models.dev provider, then OpenRouter's model of the whole id. Last, so
   *  what the first two price stays theirs. A $0 OpenRouter model only at
   *  OpenRouter's own address (`atOpenRouter`), where it is free. */
  const byName = (model: string, q: PricingMoment, atOpenRouter = false): CatalogPrice | null => {
    const listed = litellm ? litellmSuggestion(litellm, model) : null;
    if (listed) return fromLitellm(listed, q);
    const slash = model.indexOf("/");
    if (slash > 0) {
      const found = modelsDevModel(model.slice(0, slash), model.slice(slash + 1));
      if (found) return fromModelsDev(found, q);
    }
    const routed = openRouterModel(model, atOpenRouter);
    return routed ? fromOpenRouter(model, routed, q) : null;
  };

  let version: string | null = null;
  const catalog: PriceCatalog = {
    listPrice(q) {
      const provider = litellmProviderOf(q.providerType, q.baseURL);
      const entry = provider && litellm ? litellmEntry(litellm, provider, q.model) : null;
      return entry ? fromLitellm(entry, q) : null;
    },

    catalogPrice(q) {
      if (isPrivateAddress(q.baseURL)) return null;
      const address = normalizedBaseURL(q.baseURL);
      // Several providers can share one endpoint: the one that has the model.
      const provider = address === null ? undefined : providersAt.get(address)?.find((p) => p.models.some((m) => m.id === q.model));
      const model = provider?.models.find((m) => m.id === q.model);
      return provider && model ? fromModelsDev({ provider, model }, q) : null;
    },

    namePrice(q) {
      // At OpenRouter's own address a model's name is its OpenRouter id:
      // models.dev's copy of its list leaves out the ones that answer other
      // than in text, and OpenRouter's own list has them.
      return isPrivateAddress(q.baseURL) ? null : byName(q.model, q, sameBaseURL(OPENROUTER_API, q.baseURL));
    },

    priceAs(key, q) {
      const parsed = parseRefKey(key);
      if (!parsed) return null;
      if (parsed.origin === "litellm") {
        const entry = litellm && Object.hasOwn(litellm.entries, parsed.key) ? litellm.entries[parsed.key]! : null;
        return entry ? fromLitellm({ ...entry, key: parsed.key }, q) : null;
      }
      if (parsed.origin === "openrouter") {
        const entry = openRouterModel(parsed.key, true);
        return entry ? fromOpenRouter(parsed.key, entry, q) : null;
      }
      const found = modelsDevModel(parsed.providerId, parsed.modelId);
      return found ? fromModelsDev(found, q) : null;
    },

    yourPrice(price, q) {
      const base: RateSet = { input: price.input, output: price.output };
      if (price.cacheRead !== undefined) base.cacheRead = price.cacheRead;
      if (price.cacheWrite !== undefined) base.cacheWrite = price.cacheWrite;
      if (price.cacheWrite1h !== undefined) base.cacheWrite1h = price.cacheWrite1h;
      if (Object.values(base).some((rate) => !Number.isFinite(rate) || rate < 0)) return null;
      return priced({ base }, { ...q, serviceTier: null }, { origin: "your-price", providerId: "your-price", providerName: "Your price", modelId: "", dataDate: null });
    },

    match(model, baseURL, providerType) {
      // As pricing does: a plan's address is not priced automatically.
      if (baseURL && catalog.isPlanProvider(baseURL)) return null;
      const q = probe(model, baseURL, providerType);
      return toMatch(catalog.listPrice(q) ?? catalog.catalogPrice(q) ?? catalog.namePrice(q));
    },

    suggest(model) {
      return toMatch(byName(model, { serviceTier: null, usage: PROBE }));
    },

    search(query, limit) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const hit = (text: string) => words.every((word) => text.includes(word));
      const q = { serviceTier: null, usage: PROBE };
      const results: PriceMatch[] = [];
      for (const [key, entry] of Object.entries(litellm?.entries ?? {})) {
        if (results.length >= limit) return results;
        // A $0 entry is not a price to pick for a model that costs money.
        if (isFreeEntry(entry) || !hit(`${litellmProviderName(entry.provider)} ${entry.provider} ${key}`.toLowerCase())) continue;
        const matched = toMatch(fromLitellm({ ...entry, key }, q));
        if (matched) results.push(matched);
      }
      for (const provider of modelsDev?.providers ?? []) {
        for (const model of provider.models) {
          if (results.length >= limit) return results;
          if (!hit(`${provider.name} ${provider.id} ${model.id}`.toLowerCase())) continue;
          const matched = toMatch(fromModelsDev({ provider, model }, q));
          if (matched) results.push(matched);
        }
      }
      for (const id of Object.keys(openrouter?.entries ?? {})) {
        if (results.length >= limit) return results;
        const entry = openRouterModel(id, false);
        if (!entry || !hit(`openrouter ${id}`.toLowerCase())) continue;
        const matched = toMatch(fromOpenRouter(id, entry, q));
        if (matched) results.push(matched);
      }
      return results;
    },

    isPlanProvider(baseURL) {
      return modelsDev?.plans.some((plan) => sameBaseURL(plan.api, baseURL)) ?? false;
    },

    sources() {
      return { litellm, modelsDev, openrouter };
    },

    dataInfo() {
      // What each list says, not the day it came: a second change the same day
      // is new data for the calls still Unpriced, and the same lists fetched
      // again are not. The last parts name the rules: a change to how calls
      // are priced is new data too (nousage: a failed call with no usage has
      // no amount, not Unpriced).
      version ??= `${contentStamp(litellm)}+${contentStamp(modelsDev)}+${contentStamp(openrouter)}+byname+nousage`;
      return { litellmDate: litellm?.date ?? null, modelsDevDate: modelsDev?.date ?? null, openrouterDate: openrouter?.date ?? null, version };
    }
  };
  return catalog;
}

/** A list's prices as a short stamp, its download day left out and its
 *  keys in one order (a key moved upstream is no new price); "none" without one. */
function contentStamp(list: { date: string } | null): string {
  if (!list) return "none";
  const { date: _date, ...prices } = list;
  const sorted = (_key: string, value: unknown) => (value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value);
  return sha256(JSON.stringify(prices, sorted)).slice(0, 12);
}
