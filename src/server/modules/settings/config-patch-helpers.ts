import { MODEL_PROTOCOL_VALUES, SETTINGS_NUMBER_LIMITS, parseModelPriceSetting } from "../../../shared/settings.js";
import {
  VOICE_PROVIDER_TYPES,
  isJsonObject,
  isValidProviderName,
  normalizeCodexServiceTier,
  normalizeModelInputs,
  normalizeReasoningEffort,
  REASONING_EFFORTS,
  type JsonObject
} from "./config-normalizers.js";

export function sectionFor(root: JsonObject, key: string): JsonObject {
  const existing = root[key];
  const section = isJsonObject(existing) ? { ...existing } : {};
  root[key] = section;
  return section;
}

// The rule every setter below follows: a key the patch leaves out is kept;
// null — and "" where `emptyClears` — removes it; anything else is what
// `convert` makes of it, which removes it too when that is undefined.
function patchKey(
  target: JsonObject,
  source: JsonObject,
  key: string,
  convert: (value: unknown) => unknown,
  emptyClears = false
) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  const next = value === null || (emptyClears && value === "") ? undefined : convert(value);
  if (next === undefined) delete target[key];
  else target[key] = next;
}

export function setString(target: JsonObject, source: JsonObject, key: string) {
  patchKey(target, source, key, (value) => {
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    return value.trim();
  });
}

export function setBoolean(target: JsonObject, source: JsonObject, key: string) {
  patchKey(target, source, key, (value) => {
    if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    return value;
  });
}

export function setCodexServiceTier(target: JsonObject, source: JsonObject) {
  patchKey(target, source, "serviceTier", (value) => {
    if (typeof value !== "string") throw new Error("serviceTier must be a string");
    return normalizeCodexServiceTier(value) || undefined;
  }, true);
}

export function setModelRef(target: JsonObject, source: JsonObject, key: string) {
  patchKey(target, source, key, (value) => {
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    const trimmed = value.trim();
    if (!isModelRef(trimmed)) throw new Error(`${key} must use provider/model`);
    return trimmed;
  }, true);
}

export function setAgentModelSelection(target: JsonObject, source: JsonObject, key: string) {
  patchKey(target, source, key, (value) => normalizeAgentModelSelection(value, key), true);
}

export function setAgentModelSelectionArray(target: JsonObject, source: JsonObject, key: string) {
  patchKey(target, source, key, (value) => {
    if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
    const refs: JsonObject[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      const selection = normalizeAgentModelSelection(item, `${key} entries`);
      const model = String(selection.model);
      if (seen.has(model)) continue;
      refs.push(selection);
      seen.add(model);
    }
    return refs;
  });
}

export function setProviderModels(target: JsonObject, source: JsonObject) {
  patchKey(target, source, "models", providerModels);
}

function providerModels(value: unknown): JsonObject[] | undefined {
  if (!Array.isArray(value)) throw new Error("models must be an array");
  const models: JsonObject[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isJsonObject(entry)) throw new Error("models entries must be objects");
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) throw new Error("models[].id must be a non-empty string");
    if (seen.has(id)) throw new Error(`duplicate model id: ${id}`);
    const input = normalizeModelInputs(entry.input);
    if (
      Object.hasOwn(entry, "supportsReasoning") &&
      entry.supportsReasoning !== null &&
      typeof entry.supportsReasoning !== "boolean"
    ) {
      throw new Error("models[].supportsReasoning must be a boolean");
    }
    if (
      Object.hasOwn(entry, "protocol") &&
      entry.protocol !== null &&
      !(typeof entry.protocol === "string" && (MODEL_PROTOCOL_VALUES as readonly string[]).includes(entry.protocol))
    ) {
      throw new Error("models[].protocol must be responses, chat or messages");
    }
    if (Object.hasOwn(entry, "kind") && entry.kind !== null && entry.kind !== "decision") {
      throw new Error("models[].kind must be decision");
    }
    const lifetime = entry.cacheLifetimeMinutes;
    const lifetimeLimits = SETTINGS_NUMBER_LIMITS.models.cacheLifetimeMinutes;
    if (
      lifetime !== undefined && lifetime !== null &&
      !(typeof lifetime === "number" && Number.isInteger(lifetime) && lifetime >= lifetimeLimits.min && lifetime <= lifetimeLimits.max)
    ) {
      throw new Error(`models[].cacheLifetimeMinutes must be whole minutes from ${lifetimeLimits.min} to ${lifetimeLimits.max}`);
    }
    const price = Object.hasOwn(entry, "price") && entry.price !== null ? parseModelPriceSetting(entry.price) : null;
    if (price && !price.ok) {
      throw new Error("models[].price must be { as: \"litellm:<model>\" } or { as: \"models.dev:<provider>/<model>\" } or input and output prices, each a number of USD per 1M tokens, 0 or more");
    }
    models.push({
      id,
      input,
      ...(typeof entry.supportsReasoning === "boolean"
        ? { supportsReasoning: entry.supportsReasoning }
        : {}),
      // "responses" is the default, kept as nothing.
      ...(entry.protocol === "chat" || entry.protocol === "messages" ? { protocol: entry.protocol } : {}),
      ...(entry.kind === "decision" ? { kind: "decision" } : {}),
      ...(price?.ok ? { price: price.value as unknown as JsonObject } : {}),
      ...(typeof lifetime === "number" ? { cacheLifetimeMinutes: lifetime } : {})
    });
    seen.add(id);
  }
  return models.length > 0 ? models : undefined;
}

function normalizeAgentModelSelection(value: unknown, label: string): JsonObject {
  if (typeof value === "string") {
    const model = value.trim();
    if (!model) throw new Error(`${label} must use provider/model`);
    if (!isModelRef(model)) throw new Error(`${label} must use provider/model`);
    return { model, reasoningEffort: "provider-default" };
  }
  if (!isJsonObject(value)) throw new Error(`${label} must be a model selection`);
  const rawModel = value.model;
  if (typeof rawModel !== "string") throw new Error(`${label}.model must be a string`);
  const model = rawModel.trim();
  if (!model) throw new Error(`${label}.model must use provider/model`);
  if (!isModelRef(model)) throw new Error(`${label}.model must use provider/model`);
  if (
    Object.hasOwn(value, "reasoningEffort") &&
    value.reasoningEffort !== null &&
    typeof value.reasoningEffort !== "string"
  ) {
    throw new Error(`${label}.reasoningEffort must be a string`);
  }
  if (
    typeof value.reasoningEffort === "string" &&
    !REASONING_EFFORTS.has(value.reasoningEffort.trim().toLowerCase())
  ) {
    throw new Error(`${label}.reasoningEffort is not supported`);
  }
  return {
    model,
    reasoningEffort: normalizeReasoningEffort(value.reasoningEffort)
  };
}

export function setEnum(target: JsonObject, source: JsonObject, key: string, allowed: ReadonlySet<string>) {
  patchKey(target, source, key, (value) => {
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    const normalized = value.trim().toLowerCase();
    if (!allowed.has(normalized)) throw new Error(`${key} is not supported`);
    return normalized;
  });
}

export function setVoiceProvider(target: JsonObject, source: JsonObject, key: string) {
  patchKey(target, source, key, (value) => {
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
    const trimmed = value.trim();
    const type = trimmed.toLowerCase();
    if (VOICE_PROVIDER_TYPES.has(type)) return type;
    if (!isValidProviderName(trimmed)) throw new Error(`${key} is invalid`);
    return trimmed;
  });
}

export function setPositiveNumber(
  target: JsonObject,
  source: JsonObject,
  key: string,
  opts: { min: number; max?: number; integer: boolean }
) {
  patchKey(target, source, key, (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < opts.min) {
      throw new Error(`${key} must be at least ${opts.min}`);
    }
    if (opts.max !== undefined && number > opts.max) {
      throw new Error(`${key} must be at most ${opts.max}`);
    }
    return opts.integer ? Math.floor(number) : number;
  }, true);
}

/** A whole number within the limits, as sent: no coercion of strings,
 *  booleans or arrays, no rounding. Null clears the key. */
export function setWholeNumber(
  target: JsonObject,
  source: JsonObject,
  key: string,
  opts: { min: number; max?: number }
) {
  patchKey(target, source, key, (value) => {
    const inRange = typeof value === "number" && Number.isSafeInteger(value) && value >= opts.min && (opts.max === undefined || value <= opts.max);
    if (!inRange) {
      throw new Error(opts.max === undefined
        ? `${key} must be a whole number of at least ${opts.min}`
        : `${key} must be a whole number from ${opts.min} to ${opts.max}`);
    }
    return value;
  });
}

export function normalizeHost(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a listen address`);
  const host = value.trim();
  if (!host) throw new Error(`${label} must be a listen address`);
  return host;
}

export function normalizePort(value: unknown, label: string): number {
  const raw = typeof value === "string" ? value.trim() : value;
  const port = Number(raw);
  const limits = SETTINGS_NUMBER_LIMITS.server.port;
  if (!Number.isInteger(port) || port < limits.min || port > limits.max) {
    throw new Error(`${label} must be an integer between ${limits.min} and ${limits.max}`);
  }
  return port;
}

export function setSecret(target: JsonObject, source: JsonObject, key: string, clearKey: string) {
  if (source[clearKey] === true) {
    target[key] = "";
    return;
  }
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null) {
    target[key] = "";
    return;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed) target[key] = trimmed;
}

export function voiceProviderTypeFor(root: JsonObject, provider: unknown) {
  const providerValue = typeof provider === "string" ? provider.trim() : "";
  const models = isJsonObject(root.models) ? root.models : {};
  const providers = isJsonObject(models.providers) ? models.providers : {};
  const namedProvider = providerValue ? providers[providerValue] : null;
  if (isJsonObject(namedProvider) && typeof namedProvider.type === "string") {
    return namedProvider.type.trim().toLowerCase();
  }
  const type = providerValue.toLowerCase();
  return VOICE_PROVIDER_TYPES.has(type) ? type : "";
}

function isModelRef(value: string) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  return isValidProviderName(value.slice(0, slash));
}
