type SettingOption<T extends string = string> = {
  value: T;
  label: string;
};

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
  "xhigh"
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export const MODEL_INPUT_TYPE_VALUES = ["text", "image", "audio", "video", "document"] as const;
export type ModelInputType = (typeof MODEL_INPUT_TYPE_VALUES)[number];

export const DEFAULT_CODEX_REALTIME_MODEL = "gpt-realtime-1.5";
export const DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT = 25;
export const DEFAULT_COMPRESSION_THRESHOLD_TOKENS = 200000;

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
    maxStepsPerWake: { min: 1 },
    compressionThresholdTokens: { min: 1000 }
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
  { value: "xhigh", label: "XHigh" }
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
}

export interface AgentModelSelection {
  model: string;
  reasoningEffort: ReasoningEffort;
}

type AgentModelSelectionUpdate = string | AgentModelSelection;

interface AgentModelOverrideSettings {
  manager: boolean;
  worker: boolean;
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
  organizationId?: string;
  serviceTier?: string;
  models: ModelCapabilitySettings[];
  apiKeyConfigured: boolean;
  auth?: CodexAuthSettings;
}

interface ModelsSettings {
  default: DefaultModelSettings;
  providers: Record<string, ProviderSettings>;
}

interface AgentSettings {
  preferences: string;
  managerModel: AgentModelSelection;
  managerModelFallbacks: AgentModelSelection[];
  workerModel: AgentModelSelection;
  workerModelFallbacks: AgentModelSelection[];
  modelOverrides: AgentModelOverrideSettings;
  manager: { model: string; provider: string; apiKeyConfigured: boolean };
  worker: { model: string; provider: string; apiKeyConfigured: boolean };
  maxStepsPerWake: number;
  compressionThresholdTokens: number;
  logRequests: LogRequestsMode;
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
}

export type SettingsConfigPayload = Omit<SettingsConfigResponse, "ok">;

export interface ProviderSettingsUpdate {
  previousName?: string;
  type: ProviderType;
  baseURL?: string | null;
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
  };
  agent?: {
    preferences?: string | null;
    managerModel?: AgentModelSelectionUpdate | null;
    managerModelFallbacks?: AgentModelSelectionUpdate[] | null;
    workerModel?: AgentModelSelectionUpdate | null;
    workerModelFallbacks?: AgentModelSelectionUpdate[] | null;
    maxStepsPerWake?: number | null;
    compressionThresholdTokens?: number | null;
    logRequests?: LogRequestsMode | null;
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
}
