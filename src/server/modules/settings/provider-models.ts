import type { ProviderModelCatalogItem } from "../../../shared/api-contracts.js";
import {
  CODEX_BUILTIN_MODEL_IDS,
  DEFAULT_MODEL_INPUTS,
  type ModelInputType
} from "../../../shared/settings.js";
import type { ProviderConfig } from "../../config.js";
import type { HttpClient } from "../../platform/http/http-client.js";
import { logError } from "../../platform/logger.js";
import { errorText } from "../../../shared/error-text.js";
import { anthropicApiBase } from "../llm/anthropic-base-url.js";
import { kiloApisOfListing, type KiloApi } from "../../config/kilo-model-apis.js";

export interface ProviderModelsResult {
  providerType: string;
  source: "builtin" | "configured" | "live";
  models: ProviderModelCatalogItem[];
  /** How many models the provider itself listed (live only). */
  listedCount?: number;
  /** Why a live listing that was attempted failed; the result then falls
   *  back to the configured models. */
  failure?: ListingFailure;
  /** A Kilo listing's per-model API tags (models not on Chat), for the
   *  registry; never sent to the client. */
  kiloApis?: ReadonlyMap<string, KiloApi>;
}

interface ListingFailure {
  message: string;
  httpStatus?: number;
}

interface FetchProviderModelsDeps {
  httpClient?: HttpClient;
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * The provider's model catalog. Three sources, in order of preference:
 * codex ships a builtin list; anything with a key is asked live over its
 * models API; when that can't happen (no key, no client, fetch/parse
 * failure) the catalog degrades to the models already configured — the
 * add-model UI then leans on its custom-id entry.
 */
export async function fetchProviderModels(
  provider: ProviderConfig,
  deps: FetchProviderModelsDeps = {}
): Promise<ProviderModelsResult> {
  if (provider.type === "codex") {
    return {
      providerType: provider.type,
      source: "builtin",
      models: providerModelsWithBuiltins(provider).map(toCatalogItem)
    };
  }

  const listing = await fetchLiveModels(provider, deps.httpClient);
  if (!listing.ok) {
    return {
      providerType: provider.type,
      source: "configured",
      models: provider.models.map(toCatalogItem),
      ...(listing.failure ? { failure: listing.failure } : {})
    };
  }
  const live = listing.entries;

  // Configured entries win on capability values (the user's toggles) and stay
  // present when the API no longer lists them; they keep the listing's
  // declaration so the editor can say what the list says.
  const byId = new Map<string, ProviderModelCatalogItem>();
  for (const entry of live) byId.set(entry.id, liveCatalogItem(entry));
  for (const model of provider.models) {
    const declared = byId.get(model.id)?.declared;
    byId.set(model.id, { ...toCatalogItem(model), ...(declared ? { declared } : {}) });
  }
  return {
    providerType: provider.type,
    source: "live",
    models: Array.from(byId.values()),
    listedCount: live.length,
    ...(listing.kiloApis ? { kiloApis: listing.kiloApis } : {})
  };
}

interface LiveModelEntry {
  id: string;
  inputModalities?: string[];
  supportedParameters?: string[];
  contextLength?: number;
}

/** The request parameters that mean "this model reasons" in an
 *  OpenRouter-shaped `supported_parameters`. */
const REASONING_PARAMETERS = ["reasoning", "include_reasoning", "reasoning_effort"];

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

/** The listed models; or no attempt (no key, no client, no URL); or why
 *  the attempt failed. */
type LiveListing =
  | { ok: true; entries: LiveModelEntry[]; kiloApis?: ReadonlyMap<string, KiloApi> }
  | { ok: false; failure?: ListingFailure };

const UNREADABLE: ListingFailure = { message: "The provider's model list could not be read." };

async function fetchLiveModels(
  provider: ProviderConfig,
  httpClient: HttpClient | undefined
): Promise<LiveListing> {
  const url = modelsUrl(provider);
  if (!httpClient || !provider.apiKey || !url) return { ok: false };
  try {
    const res = await httpClient.fetch(url, {
      method: "GET",
      headers: modelsHeaders(provider),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, failure: await refusal(res) };
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      return { ok: false, failure: UNREADABLE };
    }
    const entries = provider.type === "google" ? googleEntries(payload) : openAiShapedEntries(payload);
    if (!entries) return { ok: false, failure: UNREADABLE };
    const kiloApis = provider.type === "kilo" ? kiloApisOfListing(payload) : null;
    return { ok: true, entries, ...(kiloApis ? { kiloApis } : {}) };
  } catch (err) {
    logError("provider-models", err, `live model listing failed for ${provider.type}`);
    return { ok: false, failure: { message: oneLine(errorText(err)) } };
  }
}

/** A refused listing, in the provider's own words where it gave some. Markup
 *  (a gateway's HTML page for a wrong path, whatever its content type) is not
 *  words: the status alone. */
async function refusal(res: Response): Promise<ListingFailure> {
  const body = await res.text().catch(() => "");
  let detail = body.trimStart().startsWith("<") ? "" : body;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const error = json?.error;
    const nested = error && typeof error === "object" ? (error as Record<string, unknown>).message : undefined;
    const said = [nested, error, json?.message].find((value): value is string => typeof value === "string");
    if (said) detail = said;
  } catch {
    // not JSON: the body text as it came
  }
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  return { message: oneLine(detail.trim() ? `${status}: ${detail}` : status), httpStatus: res.status };
}

/** One line of at most 200 characters. */
function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** An OpenAI-shaped list (`data[]`): OpenAI, Anthropic, gateways. */
function openAiShapedEntries(payload: unknown): LiveModelEntry[] | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data.flatMap((raw): LiveModelEntry[] => {
    const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) return [];
    const architecture = entry.architecture && typeof entry.architecture === "object"
      ? entry.architecture as Record<string, unknown>
      : {};
    const inputModalities = stringArray(architecture.input_modalities);
    const supportedParameters = stringArray(entry.supported_parameters);
    return [{
      id,
      ...(inputModalities ? { inputModalities } : {}),
      ...(supportedParameters ? { supportedParameters } : {}),
      ...(typeof entry.context_length === "number" ? { contextLength: entry.context_length } : {})
    }];
  });
}

/** Google's list (`models[]`, names as `models/<id>`): only the models that
 *  generate content; `thinking` declares reasoning when it is given. */
function googleEntries(payload: unknown): LiveModelEntry[] | null {
  const models = (payload as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  return models.flatMap((raw): LiveModelEntry[] => {
    const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const id = name.replace(/^models\//, "");
    if (!id || !stringArray(entry.supportedGenerationMethods)?.includes("generateContent")) return [];
    return [{
      id,
      ...(typeof entry.thinking === "boolean" ? { supportedParameters: entry.thinking ? ["reasoning"] : [] } : {}),
      ...(typeof entry.inputTokenLimit === "number" ? { contextLength: entry.inputTokenLimit } : {})
    }];
  });
}

/** A listed model: on unless its list declares otherwise. */
function liveCatalogItem(entry: LiveModelEntry): ProviderModelCatalogItem {
  const declared: { image?: boolean; reasoning?: boolean } = {};
  if (entry.inputModalities) declared.image = entry.inputModalities.includes("image");
  if (entry.supportedParameters) {
    declared.reasoning = REASONING_PARAMETERS.some((p) => entry.supportedParameters!.includes(p));
  }
  return {
    id: entry.id,
    name: entry.id,
    input: declared.image === false ? ["text"] : [...DEFAULT_MODEL_INPUTS],
    ...(declared.reasoning === false ? { supportsReasoning: false } : {}),
    ...(Object.keys(declared).length > 0 ? { declared } : {}),
    contextLength: entry.contextLength ?? null,
    outputModalities: [],
    supportedParameters: entry.supportedParameters ?? []
  };
}

function modelsUrl(provider: ProviderConfig): string | null {
  if (provider.type === "anthropic") return `${anthropicApiBase(provider.baseURL)}/models?limit=1000`;
  // Google pages at most 1000 models; one page holds them all.
  if (provider.type === "google") {
    const base = trimSlash(provider.baseURL);
    return base ? `${base}/models?pageSize=1000` : null;
  }
  // OpenAI-compatible (openai, kilo, gateways): the configured base already
  // carries its version segment by convention.
  const base = trimSlash(provider.baseURL);
  if (!base) return null;
  return `${base}/models`;
}

function modelsHeaders(provider: ProviderConfig): Record<string, string> {
  if (provider.type === "anthropic") {
    return { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" };
  }
  if (provider.type === "google") return { "x-goog-api-key": provider.apiKey };
  // Kilo lists by organisation, as Kilo's own client asks for it.
  const organization = provider.type === "kilo" ? provider.organizationId?.trim() : "";
  return { authorization: `Bearer ${provider.apiKey}`, ...(organization ? { "X-KiloCode-OrganizationId": organization } : {}) };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function toCatalogItem(model: ProviderConfig["models"][number]): ProviderModelCatalogItem {
  return {
    id: model.id,
    name: model.id,
    input: normalizeModelInputs(model.input),
    ...(typeof model.supportsReasoning === "boolean"
      ? { supportsReasoning: model.supportsReasoning }
      : {}),
    contextLength: null,
    outputModalities: [],
    supportedParameters: []
  };
}

export function providerModelsWithBuiltins(
  provider: Pick<ProviderConfig, "type" | "models">
): ProviderConfig["models"] {
  if (provider.type !== "codex") return provider.models;
  // A price or cache lifetime set on a built-in model is kept with it.
  const entryOf = (id: string) => provider.models.find((model) => model.id === id);
  const models: ProviderConfig["models"] = CODEX_BUILTIN_MODEL_IDS.map((id) => {
    const entry = entryOf(id);
    return {
      id, input: ["text", "image"] as ModelInputType[], supportsReasoning: true,
      ...(entry?.price ? { price: entry.price } : {}),
      ...(entry?.cacheLifetimeMinutes !== undefined ? { cacheLifetimeMinutes: entry.cacheLifetimeMinutes } : {})
    };
  });
  const seen = new Set(models.map((model) => model.id));
  for (const model of provider.models) {
    if (seen.has(model.id)) continue;
    models.push(model);
    seen.add(model.id);
  }
  return models;
}

function normalizeModelInputs(input: readonly ModelInputType[] = []): ModelInputType[] {
  return Array.from(new Set<ModelInputType>(["text", ...input]));
}
