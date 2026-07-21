import { SETTINGS_NUMBER_LIMITS } from "../../../shared/settings.js";
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

export function setString(target: JsonObject, source: JsonObject, key: string) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null) {
    delete target[key];
    return;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  target[key] = value.trim();
}

export function setBoolean(target: JsonObject, source: JsonObject, key: string) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null) {
    delete target[key];
    return;
  }
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  target[key] = value;
}

export function setCodexServiceTier(target: JsonObject, source: JsonObject) {
  if (!Object.hasOwn(source, "serviceTier")) return;
  const value = source.serviceTier;
  if (value === null || value === "") {
    delete target.serviceTier;
    return;
  }
  if (typeof value !== "string") throw new Error("serviceTier must be a string");
  const tier = normalizeCodexServiceTier(value);
  if (tier) {
    target.serviceTier = tier;
  } else {
    delete target.serviceTier;
  }
}

export function setModelRef(target: JsonObject, source: JsonObject, key: string) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null || value === "") {
    delete target[key];
    return;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (!isModelRef(trimmed)) throw new Error(`${key} must use provider/model`);
  target[key] = trimmed;
}

export function setAgentModelSelection(target: JsonObject, source: JsonObject, key: string) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null || value === "") {
    delete target[key];
    return;
  }
  target[key] = normalizeAgentModelSelection(value, key);
}

export function setAgentModelSelectionArray(target: JsonObject, source: JsonObject, key: string) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null) {
    delete target[key];
    return;
  }
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
  target[key] = refs;
}

export function setProviderModels(target: JsonObject, source: JsonObject) {
  if (!Object.hasOwn(source, "models")) return;
  const value = source.models;
  if (value === null) {
    delete target.models;
    return;
  }
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
    models.push({
      id,
      input,
      ...(typeof entry.supportsReasoning === "boolean"
        ? { supportsReasoning: entry.supportsReasoning }
        : {})
    });
    seen.add(id);
  }
  if (models.length > 0) {
    target.models = models;
  } else {
    delete target.models;
  }
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
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null) {
    delete target[key];
    return;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const normalized = value.trim().toLowerCase();
  if (!allowed.has(normalized)) throw new Error(`${key} is not supported`);
  target[key] = normalized;
}

export function setVoiceProvider(target: JsonObject, source: JsonObject, key: string) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null) {
    delete target[key];
    return;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  const type = trimmed.toLowerCase();
  if (VOICE_PROVIDER_TYPES.has(type)) {
    target[key] = type;
    return;
  }
  if (!isValidProviderName(trimmed)) throw new Error(`${key} is invalid`);
  target[key] = trimmed;
}

export function setPositiveNumber(
  target: JsonObject,
  source: JsonObject,
  key: string,
  opts: { min: number; max?: number; integer: boolean }
) {
  if (!Object.hasOwn(source, key)) return;
  const value = source[key];
  if (value === null || value === "") {
    delete target[key];
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < opts.min) {
    throw new Error(`${key} must be at least ${opts.min}`);
  }
  if (opts.max !== undefined && number > opts.max) {
    throw new Error(`${key} must be at most ${opts.max}`);
  }
  target[key] = opts.integer ? Math.floor(number) : number;
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

export function previousProviderName(source: JsonObject) {
  if (!Object.hasOwn(source, "previousName")) return "";
  const value = source.previousName;
  if (value === null || value === "") return "";
  if (typeof value !== "string") throw new Error("previousName must be a string");
  const trimmed = value.trim();
  if (!isValidProviderName(trimmed)) throw new Error("previousName is invalid");
  return trimmed;
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
