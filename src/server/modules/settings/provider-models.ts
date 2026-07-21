import type { ProviderModelCatalogItem } from "../../../shared/api-contracts.js";
import {
  CODEX_BUILTIN_MODEL_IDS,
  type ModelInputType
} from "../../../shared/settings.js";
import type { ProviderConfig } from "../../config.js";
import type { HttpClient } from "../../platform/http/http-client.js";
import { logError } from "../../platform/logger.js";

export interface ProviderModelsResult {
  providerType: string;
  source: "builtin" | "configured" | "live";
  models: ProviderModelCatalogItem[];
}

export interface FetchProviderModelsDeps {
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

  const live = await fetchLiveModelIds(provider, deps.httpClient);
  if (live === null) {
    return {
      providerType: provider.type,
      source: "configured",
      models: provider.models.map(toCatalogItem)
    };
  }

  // Configured entries win on capability details (the user may have marked
  // image input or reasoning support the listing API doesn't expose), and
  // stay present even when the API no longer lists them.
  const byId = new Map<string, ProviderModelCatalogItem>();
  for (const id of live) {
    byId.set(id, {
      id,
      name: id,
      input: ["text"],
      contextLength: null,
      outputModalities: [],
      supportedParameters: []
    });
  }
  for (const model of provider.models) {
    byId.set(model.id, toCatalogItem(model));
  }
  return {
    providerType: provider.type,
    source: "live",
    models: Array.from(byId.values())
  };
}

/** Returns the listed model ids, or null when live listing is unavailable. */
async function fetchLiveModelIds(
  provider: ProviderConfig,
  httpClient: HttpClient | undefined
): Promise<string[] | null> {
  if (!httpClient || !provider.apiKey || !modelsUrl(provider)) return null;
  try {
    const res = await httpClient.fetch(modelsUrl(provider)!, {
      method: "GET",
      headers: modelsHeaders(provider),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(payload?.data)) return null;
    const ids = payload.data
      .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
      .filter((id) => id.length > 0);
    return ids;
  } catch (err) {
    logError("provider-models", err, `live model listing failed for ${provider.type}`);
    return null;
  }
}

function modelsUrl(provider: ProviderConfig): string | null {
  if (provider.type === "anthropic") {
    const base = trimSlash(provider.baseURL || "https://api.anthropic.com");
    const versioned = base.endsWith("/v1") ? base : `${base}/v1`;
    return `${versioned}/models?limit=1000`;
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
  return { authorization: `Bearer ${provider.apiKey}` };
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
  const models: ProviderConfig["models"] = CODEX_BUILTIN_MODEL_IDS.map((id) => ({
    id,
    input: ["text", "image"] as ModelInputType[],
    supportsReasoning: true
  }));
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
