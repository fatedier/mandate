import type { Config, JsonObject, MemoryConfig, ProviderConfig } from "./types.js";

export function mergeConfig(base: Config, override: JsonObject): Config {
  const agent = isObject(override.agent) ? override.agent : {};
  const memory = isObject(override.memory) ? override.memory : {};
  const voice = isObject(override.voice) ? override.voice : {};
  const retention = isObject(override.retention) ? override.retention : {};
  return {
    ...base,
    ...override,
    models: mergeModelsConfig(base.models, override.models),
    agent: {
      ...base.agent,
      ...agent
    } as Config["agent"],
    memory: mergeMemoryConfig(base.memory, memory),
    voice: {
      ...base.voice,
      ...voice
    } as Config["voice"],
    retention: {
      ...base.retention,
      ...retention
    } as Config["retention"],
    // Read as the file has it; loadConfig keeps only what fits the shape.
    webSearch: (isObject(override.webSearch) ? override.webSearch : base.webSearch) as Config["webSearch"],
    notifications: (isObject(override.notifications) ? override.notifications : base.notifications) as Config["notifications"]
  };
}

function mergeModelsConfig(base: Config["models"], override: unknown): Config["models"] {
  const overrideConfig = isObject(override) ? override : {};
  const providers = { ...base.providers };
  const overrideProviders = isObject(overrideConfig.providers) ? overrideConfig.providers : {};
  for (const [provider, cfg] of Object.entries(overrideProviders)) {
    const existing = providers[provider] ?? { type: "", baseURL: "", apiKey: "" };
    providers[provider] = {
      ...existing,
      ...(isObject(cfg) ? cfg : {})
    } as ProviderConfig;
  }
  const defaults = isObject(overrideConfig.default) ? overrideConfig.default : {};
  return {
    ...base,
    ...overrideConfig,
    default: {
      ...base.default,
      ...defaults
    } as Config["models"]["default"],
    providers
  };
}

function mergeMemoryConfig(base: MemoryConfig, override: JsonObject): MemoryConfig {
  const embedding = isObject(override.embedding) ? override.embedding : {};
  const dream = isObject(override.dream) ? override.dream : {};
  return {
    embedding: {
      ...base.embedding,
      ...embedding
    } as MemoryConfig["embedding"],
    dream: {
      ...base.dream,
      ...dream
    } as MemoryConfig["dream"]
  } as MemoryConfig;
}

/** The file's contents with every key set to null left out: null is a key
 *  the file does not set (an item of a list stays as it is). */
export function withoutNulls(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null) continue;
    out[key] = isObject(item) ? withoutNulls(item) : item;
  }
  return out;
}

export function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
