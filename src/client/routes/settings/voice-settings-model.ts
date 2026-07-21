import {
  DEFAULT_CODEX_REALTIME_MODEL,
  SETTINGS_NUMBER_LIMITS,
  VOICE_LANGUAGE_OPTIONS,
  type SettingsConfigResponse,
  type SettingsConfigUpdate
} from "./types";

export type VoiceForm = {
  provider: string;
  model: string;
  voice: string;
  language: string;
  baseURL: string;
  deployment: string;
  idleTimeoutMinutes: string;
  maxSessionMinutes: string;
  contextMessageCount: string;
  apiKey: string;
  clearApiKey: boolean;
};

export function voiceLanguageOptions(current: string): Array<{ value: string; label: string }> {
  const inList = VOICE_LANGUAGE_OPTIONS.some((option) => option.value === current);
  if (inList || !current) return [...VOICE_LANGUAGE_OPTIONS];
  return [{ value: current, label: `${current} (custom)` }, ...VOICE_LANGUAGE_OPTIONS];
}

export function formFromConfig(config: SettingsConfigResponse): VoiceForm {
  return {
    provider: config.voice.provider,
    model: config.voice.model,
    voice: config.voice.voice,
    language: config.voice.language,
    baseURL: config.voice.baseURL,
    deployment: config.voice.deployment,
    idleTimeoutMinutes: msToMinutes(config.voice.idleTimeoutMs),
    maxSessionMinutes: msToMinutes(config.voice.maxSessionMs),
    contextMessageCount: String(config.voice.contextMessageCount),
    apiKey: "",
    clearApiKey: false
  };
}

export function buildVoicePayload(form: VoiceForm): SettingsConfigUpdate {
  return {
    voice: {
      provider: form.provider,
      model: form.model,
      voice: form.voice,
      language: form.language,
      baseURL: form.baseURL,
      deployment: form.deployment,
      idleTimeoutMs: minutesToMs(form.idleTimeoutMinutes, "Idle timeout"),
      maxSessionMs: minutesToMs(form.maxSessionMinutes, "Max length"),
      contextMessageCount: contextMessageCountFromForm(form.contextMessageCount),
      apiKey: form.apiKey,
      clearApiKey: form.clearApiKey
    }
  };
}

export function nextVoiceProviderForm(
  config: SettingsConfigResponse,
  form: VoiceForm,
  provider: string
): VoiceForm {
  const providerType = voiceProviderType(config, provider);
  return {
    ...form,
    provider,
    model:
      providerType === "codex" && form.model === "gpt-realtime-mini"
        ? DEFAULT_CODEX_REALTIME_MODEL
        : form.model,
    apiKey: providerType === "codex" ? "" : form.apiKey,
    clearApiKey: providerType === "codex" ? false : form.clearApiKey
  };
}

export function voiceProviderType(config: SettingsConfigResponse, provider: string) {
  if (provider.trim().toLowerCase() === "codex") return "codex";
  const configuredType = config.models.providers[provider.trim()]?.type;
  if (configuredType === "codex") return "codex";
  return "openai";
}

export function voiceConfigured(config: SettingsConfigResponse, form: VoiceForm) {
  if (voiceProviderType(config, form.provider) === "codex") {
    return Boolean(voiceCodexAuth(config, form.provider)?.configured);
  }
  return config.voice.provider === form.provider && config.voice.providerType === "openai"
    ? config.voice.apiKeyConfigured
    : Boolean(config.models.providers[form.provider.trim()]?.apiKeyConfigured);
}

export type VoiceStatus = "ready" | "expired" | "unconfigured";

/**
 * What the header chip reports. An expired codex token leaves `configured`
 * true, so `voiceConfigured` alone rendered a green "Configured" directly
 * above an auth box reading "Expired". Expired is its own state: credentials
 * exist, but voice will not connect until you sign in again.
 */
export function voiceStatus(config: SettingsConfigResponse, form: VoiceForm): VoiceStatus {
  if (!voiceConfigured(config, form) || !form.model) return "unconfigured";
  if (voiceProviderType(config, form.provider) === "codex") {
    return voiceCodexAuth(config, form.provider)?.status === "expired" ? "expired" : "ready";
  }
  return "ready";
}

export function voiceCodexAuth(config: SettingsConfigResponse, provider: string) {
  if (config.voice.provider === provider && config.voice.providerType === "codex") {
    return config.voice.auth;
  }
  return config.models.providers[provider.trim()]?.auth;
}

export function voiceProviderOptions(config: SettingsConfigResponse, current: string) {
  const seen = new Set<string>();
  const options: Array<{ value: string; label: string }> = [];
  const add = (value: string, label: string) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    options.push({ value, label });
  };

  add("openai", "OpenAI");
  for (const [name, provider] of Object.entries(config.models.providers)) {
    if (provider.type === "openai" || provider.type === "codex") {
      add(name, `${name} (${providerTypeLabel(provider.type)})`);
    }
  }
  if (current && !seen.has(current)) {
    add(current, current);
  }
  return options;
}

function providerTypeLabel(type: string) {
  return type === "codex" ? "OpenAI Codex" : "OpenAI";
}

function msToMinutes(ms: number) {
  if (!Number.isFinite(ms)) return "0";
  return String(Math.round(ms / 60000));
}

function minutesToMs(value: string, label: string) {
  return Math.round(nonNegativeNumber(value, label) * 60000);
}

function nonNegativeInteger(value: string, label: string) {
  return Math.floor(nonNegativeNumber(value, label));
}

function contextMessageCountFromForm(value: string) {
  const count = nonNegativeInteger(value, "Context messages");
  const limit = SETTINGS_NUMBER_LIMITS.voice.contextMessageCount.max;
  if (count > limit) {
    throw new Error(`Context messages must be at most ${limit}.`);
  }
  return count;
}

function nonNegativeNumber(value: string, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return number;
}
