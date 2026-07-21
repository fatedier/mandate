import {
  CODEX_SERVICE_TIER_VALUES,
  LOG_REQUEST_MODE_VALUES,
  MODEL_INPUT_TYPE_VALUES,
  PROVIDER_BASE_URL_DEFAULTS,
  PROVIDER_TYPE_VALUES,
  REASONING_EFFORT_VALUES,
  VOICE_PROVIDER_TYPE_VALUES,
  type ModelInputType,
  type ReasoningEffort
} from "../../../shared/settings.js";

export type JsonObject = Record<string, unknown>;

export type ProviderAuthRename = { from: string; to: string };

export const PROVIDER_TYPES: ReadonlySet<string> = new Set(PROVIDER_TYPE_VALUES);
export const VOICE_PROVIDER_TYPES: ReadonlySet<string> = new Set(VOICE_PROVIDER_TYPE_VALUES);
export const LOG_REQUEST_MODES: ReadonlySet<string> = new Set(LOG_REQUEST_MODE_VALUES);
export const REASONING_EFFORTS: ReadonlySet<string> = new Set(REASONING_EFFORT_VALUES);
export const MODEL_INPUT_TYPES = new Set<ModelInputType>(MODEL_INPUT_TYPE_VALUES);
const CODEX_SERVICE_TIERS: ReadonlySet<string> = new Set(CODEX_SERVICE_TIER_VALUES);
export const PROVIDER_DEFAULTS: Record<string, { baseURL: string }> = PROVIDER_BASE_URL_DEFAULTS;

export function normalizeModelInputs(value: unknown): ModelInputType[] {
  const inputs = new Set<ModelInputType>(["text"]);
  if (value === undefined || value === null) return [...inputs];
  if (!Array.isArray(value)) throw new Error("models[].input must be an array");
  for (const item of value) {
    if (typeof item !== "string") throw new Error("models[].input entries must be strings");
    const normalized = item.trim().toLowerCase();
    if (!MODEL_INPUT_TYPES.has(normalized as ModelInputType)) {
      throw new Error(`unsupported model input: ${item}`);
    }
    if (normalized === "image") inputs.add("image");
  }
  return [...inputs];
}

export function normalizeProviderType(value: unknown): string {
  if (typeof value !== "string") return "";
  const type = value.trim().toLowerCase();
  return PROVIDER_TYPES.has(type) ? type : "";
}

export function normalizeVoiceProviderType(value: unknown): string {
  if (typeof value !== "string") return "";
  const type = value.trim().toLowerCase();
  return VOICE_PROVIDER_TYPES.has(type) ? type : "";
}

export function normalizeProviderName(value: unknown) {
  if (typeof value !== "string") return "";
  const name = value.trim();
  return isValidProviderName(name) ? name : "";
}

export function isValidProviderName(name: string) {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

export function normalizeCodexServiceTier(value: unknown) {
  const tier = normalizeOptionalString(value).toLowerCase();
  if (!tier) return "";
  return CODEX_SERVICE_TIERS.has(tier) ? tier : "";
}

export function normalizeLogRequestsMode(value: unknown, fallback = "metadata") {
  if (typeof value !== "string") {
    return fallback;
  }
  const mode = value.trim().toLowerCase();
  if (LOG_REQUEST_MODES.has(mode)) {
    return mode;
  }
  return fallback;
}

export function normalizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort = "provider-default"
): ReasoningEffort {
  if (typeof value !== "string") return fallback;
  const effort = value.trim().toLowerCase();
  return REASONING_EFFORTS.has(effort) ? effort as ReasoningEffort : fallback;
}

export function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
