type SettingOption<T extends string = string> = {
  value: T;
  label: string;
};

import type { ModelPriceSetting, ProviderBilling } from "./api/pricing.js";

export const PROVIDER_TYPE_VALUES = [
  "openai",
  "openai-compatible",
  "kilo",
  "codex",
  "anthropic",
  "google"
] as const;
export type ProviderType = (typeof PROVIDER_TYPE_VALUES)[number];

export const VOICE_PROVIDER_TYPE_VALUES = ["openai", "codex"] as const;
export type VoiceProviderType = (typeof VOICE_PROVIDER_TYPE_VALUES)[number];

export const CODEX_SERVICE_TIER_VALUES = ["", "priority", "flex"] as const;
export type CodexServiceTier = (typeof CODEX_SERVICE_TIER_VALUES)[number];

export const LOG_REQUEST_MODE_VALUES = ["off", "metadata", "full"] as const;
export type LogRequestsMode = (typeof LOG_REQUEST_MODE_VALUES)[number];

export const REASONING_EFFORT_VALUES = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export const MODEL_INPUT_TYPE_VALUES = ["text", "image", "audio", "video", "document"] as const;
export type ModelInputType = (typeof MODEL_INPUT_TYPE_VALUES)[number];
/** The API Mandate speaks to a custom (OpenAI-compatible) provider's model.
 *  Absent means "responses"; every other provider type has one fixed API. */
export const MODEL_PROTOCOL_VALUES = ["responses", "chat", "messages"] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOL_VALUES)[number];
/** A model takes text and images unless its entry or its provider's list says
 *  otherwise. */
export const DEFAULT_MODEL_INPUTS: readonly ModelInputType[] = ["text", "image"];

export const DEFAULT_CODEX_REALTIME_MODEL = "gpt-realtime-1.5";
export const DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT = 25;
export const DEFAULT_COMPRESSION_THRESHOLD_TOKENS = 200000;
/** Idle compaction runs this many minutes before a thread's cache expires. */
export const DEFAULT_IDLE_COMPACTION_LEAD_MINUTES = 5;
/** Idle compaction leaves threads smaller than this as they are. */
export const DEFAULT_IDLE_COMPACTION_MIN_TOKENS = 200000;

export const CODEX_BUILTIN_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5"
] as const;

export const PROVIDER_BASE_URL_DEFAULTS: Record<ProviderType, { baseURL: string }> = {
  openai: { baseURL: "https://api.openai.com/v1" },
  "openai-compatible": { baseURL: "" },
  kilo: { baseURL: "https://api.kilo.ai/api/gateway" },
  codex: { baseURL: "https://chatgpt.com/backend-api/codex" },
  anthropic: { baseURL: "https://api.anthropic.com/v1" },
  google: { baseURL: "https://generativelanguage.googleapis.com/v1beta" }
};

export const PROVIDER_DEFAULT_MODEL_IDS: Record<ProviderType, string> = {
  openai: "gpt-4.1-mini",
  "openai-compatible": "",
  kilo: "kilo-auto/balanced",
  codex: CODEX_BUILTIN_MODEL_IDS[0],
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.5-flash"
};

export const SETTINGS_NUMBER_LIMITS = {
  server: {
    port: { min: 0, max: 65535 }
  },
  agent: {
    compressionThresholdTokens: { min: 1000 },
    idleCompactionLeadMinutes: { min: 1, max: 59 },
    idleCompactionMinTokens: { min: 1000 }
  },
  models: {
    cacheLifetimeMinutes: { min: 0, max: 1440 }
  },
  voice: {
    idleTimeoutMs: { min: 0 },
    maxSessionMs: { min: 0 },
    contextMessageCount: { min: 0, max: 100 }
  }
} as const;

export const PROVIDER_TYPE_OPTIONS: ReadonlyArray<SettingOption<ProviderType>> = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "kilo", label: "Kilo Gateway" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "google", label: "Google" },
  { value: "openai-compatible", label: "OpenAI compatible" }
];

export const CODEX_SERVICE_TIER_OPTIONS: ReadonlyArray<SettingOption<CodexServiceTier>> = [
  { value: "", label: "Default" },
  { value: "priority", label: "Priority" },
  { value: "flex", label: "Flex" }
];

export const LOG_REQUEST_OPTIONS: ReadonlyArray<SettingOption<LogRequestsMode>> = [
  { value: "off", label: "Off" },
  { value: "metadata", label: "Metadata" },
  { value: "full", label: "Full" }
];

export const REASONING_EFFORT_OPTIONS: ReadonlyArray<SettingOption<ReasoningEffort>> = [
  { value: "provider-default", label: "Provider default" },
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "XHigh" },
  { value: "max", label: "Max" }
];

export const VOICE_LANGUAGE_OPTIONS: ReadonlyArray<SettingOption> = [
  { value: "auto", label: "Automatic" },
  { value: "English", label: "English" },
  { value: "Simplified Chinese", label: "简体中文 (Simplified Chinese)" },
  { value: "Traditional Chinese", label: "繁體中文 (Traditional Chinese)" },
  { value: "Japanese", label: "日本語 (Japanese)" },
  { value: "Korean", label: "한국어 (Korean)" },
  { value: "Spanish", label: "Español (Spanish)" },
  { value: "French", label: "Français (French)" },
  { value: "German", label: "Deutsch (German)" },
  { value: "Portuguese", label: "Português (Portuguese)" },
  { value: "Russian", label: "Русский (Russian)" },
  { value: "Italian", label: "Italiano (Italian)" },
  { value: "Arabic", label: "العربية (Arabic)" },
  { value: "Hindi", label: "हिन्दी (Hindi)" },
  { value: "Vietnamese", label: "Tiếng Việt (Vietnamese)" },
  { value: "Thai", label: "ภาษาไทย (Thai)" },
  { value: "Indonesian", label: "Bahasa Indonesia (Indonesian)" },
  { value: "Dutch", label: "Nederlands (Dutch)" },
  { value: "Turkish", label: "Türkçe (Turkish)" },
  { value: "Polish", label: "Polski (Polish)" }
];

export interface ModelCapabilitySettings {
  id: string;
  input: ModelInputType[];
  supportsReasoning?: boolean;
  /** Set only on a custom provider's model, and only when not "responses". */
  protocol?: Exclude<ModelProtocol, "responses">;
  /** A decision model: it answers typed questions over OpenRouter's Decisions
   *  API instead of chatting. Set only on a custom provider's model; absent,
   *  a chat model. */
  kind?: "decision";
  /** What a call of this model costs; absent, Automatic (the price lists). */
  price?: ModelPriceSetting;
  /** How many minutes its provider keeps a cached prompt after its last use,
   *  for idle compaction; 0 is off. Absent, the family's default (Claude 60,
   *  GPT 30, any other off). */
  cacheLifetimeMinutes?: number;
}

export interface AgentModelSelection {
  model: string;
  reasoningEffort: ReasoningEffort;
}

type AgentModelSelectionUpdate = string | AgentModelSelection;

interface AgentModelOverrideSettings {
  manager: boolean;
  worker: boolean;
  global: boolean;
  dream: boolean;
  extraction: boolean;
  /** The subagent route is set; unset, a subagent runs on the route of the agent that asks. */
  subagent: boolean;
  /** The page updates' route is set; unset, a page subagent runs as subagents do. */
  page: boolean;
  /** Manager request check's own route is set; unset, it runs on Decisions while that is on. */
  managerRequestCheck: boolean;
  /** Manager stop check's own route is set; unset, it runs on Decisions while that is on. */
  managerStopCheck: boolean;
  /** Memory repeat check's own route is set; unset, it runs on Decisions while that is on. */
  memoryRepeatCheck: boolean;
}

interface DefaultModelSettings {
  model: string;
  reasoningEffort: ReasoningEffort;
  modelFallbacks: AgentModelSelection[];
}

interface CodexAuthSettings {
  status: "missing" | "expired" | "authenticated";
  configured: boolean;
  accountId: string;
  email: string;
  profileId: string;
}

export interface ProviderSettings {
  type: ProviderType;
  baseURL: string;
  /** How this connection charges, as Settings resolves it (see providerBilling). */
  billing?: ProviderBilling;
  organizationId?: string;
  serviceTier?: string;
  models: ModelCapabilitySettings[];
  apiKeyConfigured: boolean;
  auth?: CodexAuthSettings;
}

interface ModelsSettings {
  default: DefaultModelSettings;
  providers: Record<string, ProviderSettings>;
  prices: { autoUpdate: boolean };
}

export const PROVIDER_BILLING_VALUES = ["usage", "plan", "free"] as const satisfies readonly ProviderBilling[];

/** A connection's billing: what the user chose, else its type's default — a
 *  ChatGPT sign-in (Codex) is a plan, every other type is paid per use. */
export function providerBilling(provider: { type: string; billing?: ProviderBilling }): ProviderBilling {
  return provider.billing ?? (provider.type === "codex" ? "plan" : "usage");
}

const PRICE_KEY = /^(?:litellm:\S+|models\.dev:[^/\s]+\/\S+)$/;
const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;

/** A model's price setting, checked: a catalog model's key, or the user's own
 *  USD-per-1M rates (input and output required, cache rates optional). */
export function parseModelPriceSetting(value: unknown): { ok: true; value: ModelPriceSetting } | { ok: false } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "as")) {
    const keys = Object.keys(record);
    return typeof record.as === "string" && PRICE_KEY.test(record.as) && keys.length === 1
      ? { ok: true, value: { as: record.as } }
      : { ok: false };
  }
  const rates: Record<string, number> = {};
  for (const key of RATE_KEYS) {
    if (!Object.hasOwn(record, key) || record[key] === undefined) continue;
    const rate = record[key];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return { ok: false };
    rates[key] = rate;
  }
  if (rates.input === undefined || rates.output === undefined) return { ok: false };
  return { ok: true, value: rates as unknown as ModelPriceSetting };
}

interface AgentSettings {
  preferences: string;
  managerModel: AgentModelSelection;
  managerModelFallbacks: AgentModelSelection[];
  workerModel: AgentModelSelection;
  workerModelFallbacks: AgentModelSelection[];
  /** Your agent's route; the default's while it has none of its own. */
  globalModel: AgentModelSelection;
  globalModelFallbacks: AgentModelSelection[];
  /** The dream's route; the default's while it has none of its own. */
  dreamModel: AgentModelSelection;
  dreamModelFallbacks: AgentModelSelection[];
  /** Memory extraction's route; the default's while it has none of its own. */
  extractionModel: AgentModelSelection;
  extractionModelFallbacks: AgentModelSelection[];
  /** The subagents' route; the default's chain while the file sets
   *  none (`modelOverrides.subagent` false), when a subagent runs on the route
   *  of the agent that asks instead. */
  subagentModel: AgentModelSelection;
  subagentModelFallbacks: AgentModelSelection[];
  /** The page updates' route (Your agent's page subagents); the default's
   *  chain while the file sets none, when they run as subagents do. */
  pageModel: AgentModelSelection;
  pageModelFallbacks: AgentModelSelection[];
  /** Decisions: the models Mandate asks for quick judgements; its chain is
   *  kept while it is switched off. Unset, empty (never the default's). */
  decisionsEnabled: boolean;
  decisionsModel: AgentModelSelection;
  decisionsModelFallbacks: AgentModelSelection[];
  /** Manager request check's own route; unset, empty (it runs on Decisions). */
  managerRequestCheckModel: AgentModelSelection;
  managerRequestCheckModelFallbacks: AgentModelSelection[];
  /** Whether manager request check runs at all; on unless switched off. */
  managerRequestCheckEnabled: boolean;
  /** Manager stop check's own route; unset, empty (it runs on Decisions). */
  managerStopCheckModel: AgentModelSelection;
  managerStopCheckModelFallbacks: AgentModelSelection[];
  /** Whether manager stop check runs at all; off until switched on. */
  managerStopCheckEnabled: boolean;
  /** Memory repeat check's own route; unset, empty (it runs on Decisions). */
  memoryRepeatCheckModel: AgentModelSelection;
  memoryRepeatCheckModelFallbacks: AgentModelSelection[];
  /** Whether memory repeat check runs at all; off until switched on. */
  memoryRepeatCheckEnabled: boolean;
  modelOverrides: AgentModelOverrideSettings;
  compressionThresholdTokens: number;
  /** Idle compaction: on, how many minutes before the cache expires, and
   *  the smallest context it compacts. */
  idleCompactionEnabled: boolean;
  idleCompactionLeadMinutes: number;
  idleCompactionMinTokens: number;
  logRequests: LogRequestsMode;
  /** The global agent's name; "" until named. */
  globalAgentName: string;
}

interface MemorySettingsConfig {
  embedding: {
    model: string;
  };
  dream: {
    enabled: boolean;
  };
}

interface VoiceSettingsConfig {
  provider: string;
  providerName: string;
  providerType: VoiceProviderType;
  model: string;
  voice: string;
  language: string;
  baseURL: string;
  deployment: string;
  idleTimeoutMs: number;
  maxSessionMs: number;
  contextMessageCount: number;
  apiKeyConfigured: boolean;
  auth?: CodexAuthSettings;
}

export type WebSearchFieldType = "model" | "provider" | "secret" | "url" | "choice";

/** One field of a search kind, as the Settings page draws it. A secret's
 *  value is never sent: `configured` says whether one is saved. */
export interface WebSearchFieldSettings {
  key: string;
  type: WebSearchFieldType;
  label: string;
  description?: string;
  required: boolean;
  value: string;
  configured?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
}

export interface WebSearchKindSettings {
  id: string;
  label: string;
  description: string;
  /** Every required field is filled, as saved. */
  setUp: boolean;
  fields: WebSearchFieldSettings[];
}

/** The kinds in the order "Search with" lists them; `use` is "off" or one of
 *  their ids. */
export interface WebSearchSettingsConfig {
  use: string;
  kinds: WebSearchKindSettings[];
}

export interface SettingsConfigResponse {
  ok: true;
  configPath: string;
  restartRequired: boolean;
  server: {
    host: string;
    port: number;
  };
  models: ModelsSettings;
  agent: AgentSettings;
  memory: MemorySettingsConfig;
  voice: VoiceSettingsConfig;
  webSearch: WebSearchSettingsConfig;
}

export type SettingsConfigPayload = Omit<SettingsConfigResponse, "ok">;

export interface ProviderSettingsUpdate {
  type: ProviderType;
  baseURL?: string | null;
  billing?: ProviderBilling | null;
  organizationId?: string | null;
  serviceTier?: CodexServiceTier | null;
  models?: ModelCapabilitySettings[] | null;
  apiKey?: string | null;
  clearApiKey?: boolean;
}

export interface SettingsConfigUpdate {
  server?: {
    host?: string;
    port?: number;
  };
  models?: {
    default?: {
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      modelFallbacks?: AgentModelSelectionUpdate[] | null;
    };
    providers?: Record<string, ProviderSettingsUpdate>;
    prices?: { autoUpdate?: boolean };
  };
  agent?: {
    preferences?: string | null;
    managerModel?: AgentModelSelectionUpdate | null;
    managerModelFallbacks?: AgentModelSelectionUpdate[] | null;
    workerModel?: AgentModelSelectionUpdate | null;
    workerModelFallbacks?: AgentModelSelectionUpdate[] | null;
    globalModel?: AgentModelSelectionUpdate | null;
    globalModelFallbacks?: AgentModelSelectionUpdate[] | null;
    dreamModel?: AgentModelSelectionUpdate | null;
    dreamModelFallbacks?: AgentModelSelectionUpdate[] | null;
    extractionModel?: AgentModelSelectionUpdate | null;
    extractionModelFallbacks?: AgentModelSelectionUpdate[] | null;
    subagentModel?: AgentModelSelectionUpdate | null;
    subagentModelFallbacks?: AgentModelSelectionUpdate[] | null;
    pageModel?: AgentModelSelectionUpdate | null;
    pageModelFallbacks?: AgentModelSelectionUpdate[] | null;
    decisionsEnabled?: boolean | null;
    decisionsModel?: AgentModelSelectionUpdate | null;
    decisionsModelFallbacks?: AgentModelSelectionUpdate[] | null;
    managerRequestCheckModel?: AgentModelSelectionUpdate | null;
    managerRequestCheckModelFallbacks?: AgentModelSelectionUpdate[] | null;
    managerRequestCheckEnabled?: boolean | null;
    managerStopCheckModel?: AgentModelSelectionUpdate | null;
    managerStopCheckModelFallbacks?: AgentModelSelectionUpdate[] | null;
    managerStopCheckEnabled?: boolean | null;
    memoryRepeatCheckModel?: AgentModelSelectionUpdate | null;
    memoryRepeatCheckModelFallbacks?: AgentModelSelectionUpdate[] | null;
    memoryRepeatCheckEnabled?: boolean | null;
    compressionThresholdTokens?: number | null;
    idleCompactionEnabled?: boolean | null;
    idleCompactionLeadMinutes?: number | null;
    idleCompactionMinTokens?: number | null;
    logRequests?: LogRequestsMode | null;
    globalAgentName?: string | null;
  };
  memory?: {
    embedding?: {
      model?: string | null;
    };
    dream?: {
      enabled?: boolean | null;
    };
  };
  voice?: {
    provider?: string | null;
    model?: string | null;
    voice?: string | null;
    language?: string | null;
    baseURL?: string | null;
    deployment?: string | null;
    idleTimeoutMs?: number | null;
    maxSessionMs?: number | null;
    contextMessageCount?: number | null;
    apiKey?: string | null;
    clearApiKey?: boolean;
  };
  /** A kind's values by field: a string sets one (a blank secret keeps the
   *  saved key), null removes it. Kinds left out are kept. */
  webSearch?: {
    use?: string | null;
    kinds?: Record<string, Record<string, string | null>>;
  };
}
