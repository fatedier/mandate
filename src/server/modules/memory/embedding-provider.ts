import { embed } from "ai";
import type { Config, ProviderConfig } from "../../config.js";
import { createAiSdkEmbeddingModel } from "../llm/ai-sdk-model-factory.js";
import type { MemoryEmbedder } from "./local-provider.js";

type EmbedModel = Parameters<typeof embed>[0]["model"];

const EMBEDDING_PROVIDER_TYPES = new Set(["openai", "openai-compatible", "google"]);

export function createMemoryEmbedder(
  config: Config,
  options: { fetch?: typeof fetch } = {}
): MemoryEmbedder | null {
  const modelRef = config.memory.embedding.model.trim();
  if (!modelRef) return null;

  const resolved = resolveEmbeddingModel(config, modelRef);
  if (!resolved) return null;

  const model = createEmbeddingModel(resolved.providerName, resolved.provider, resolved.model, options);
  if (!model) return null;

  return {
    model: `${resolved.providerName}/${resolved.model}`,
    async embed(text: string) {
      const result = await embed({
        model,
        value: text,
        maxRetries: 1
      });
      return Array.from(result.embedding);
    }
  };
}

function createEmbeddingModel(
  providerName: string,
  provider: ProviderConfig,
  modelId: string,
  options: { fetch?: typeof fetch }
): EmbedModel | null {
  return createAiSdkEmbeddingModel({
    providerName,
    providerType: provider.type,
    model: modelId,
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    fetch: options.fetch
  });
}

function resolveEmbeddingModel(config: Config, modelRef: string): {
  providerName: string;
  provider: ProviderConfig;
  model: string;
} | null {
  const explicit = parseModelRef(modelRef);
  if (explicit) {
    const provider = config.models.providers[explicit.providerName];
    if (!provider || !EMBEDDING_PROVIDER_TYPES.has(provider.type)) return null;
    return { providerName: explicit.providerName, provider, model: explicit.model };
  }

  const model = modelRef.trim();
  if (!model) return null;
  for (const [providerName, provider] of Object.entries(config.models.providers)) {
    if (EMBEDDING_PROVIDER_TYPES.has(provider.type)) {
      return { providerName, provider, model };
    }
  }
  return null;
}

function parseModelRef(value: string) {
  const raw = value.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return null;
  const providerName = raw.slice(0, slash).trim();
  const model = raw.slice(slash + 1).trim();
  if (!providerName || !model) return null;
  return { providerName, model };
}
