import {
  MODEL_INPUT_TYPES,
  PROVIDER_DEFAULTS,
  VOICE_PROVIDER_TYPES as SUPPORTED_VOICE_PROVIDER_TYPES,
  isValidProviderName,
  normalizeCodexServiceTier,
  normalizeOptionalString,
  normalizeProviderName,
  normalizeProviderType,
  normalizeReasoningEffort,
  normalizeVoiceProviderType
} from "../modules/settings/config-schema.js";
import { DEFAULT_CODEX_REALTIME_MODEL, DEFAULT_CONFIG } from "./defaults.js";
import type {
  Config,
  JsonObject,
  ModelCapabilityConfig,
  ModelInputType,
  ProviderConfig,
  ResolvedProviderConfig
} from "./types.js";
import type { AgentModelSelection } from "../../shared/settings.js";

export function normalizeModelsConfig(config: Config) {
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, rawConfig] of Object.entries(config.models.providers ?? {})) {
    if (!isValidProviderName(name)) continue;
    const type = normalizeProviderType(rawConfig.type) || normalizeProviderType(name);
    if (!type) continue;
    const defaults = PROVIDER_DEFAULTS[type] ?? { baseURL: "" };
    providers[name] = {
      type,
      baseURL: normalizeOptionalString(rawConfig.baseURL) || defaults.baseURL,
      apiKey: providerApiKey(type, rawConfig.apiKey),
      models: normalizeModelCapabilities(rawConfig.models),
      ...(type === "kilo"
        ? { organizationId: normalizeOptionalString(rawConfig.organizationId) }
        : {}),
      ...(type === "codex" ? { serviceTier: normalizeCodexServiceTier(rawConfig.serviceTier) } : {})
    };
  }
  config.models.providers = providers;
  config.models.default.model = normalizeModelRef(config.models.default.model, undefined, "");
  config.models.default.reasoningEffort = normalizeReasoningEffort(
    config.models.default.reasoningEffort
  );
  config.models.default.modelFallbacks = normalizeAgentModelSelectionList(
    config.models.default.modelFallbacks,
    providerNameFromModelRef(config.models.default.model),
    config.models.default.model
  ).filter((selection) => selection.model !== config.models.default.model);
}

export function normalizeAgentModelConfig(config: Config, fileAgent: JsonObject = {}) {
  const defaultModel = config.models.default.model;
  const defaultSelection: AgentModelSelection = {
    model: defaultModel,
    reasoningEffort: config.models.default.reasoningEffort
  };

  const managerModel = hasExplicitAgentSelection(fileAgent, "managerModel")
    ? normalizeAgentModelSelection(
        config.agent.managerModel,
        providerNameFromModelRef(defaultModel),
        defaultModel
      )
    : defaultSelection;
  const workerModel = hasExplicitAgentSelection(fileAgent, "workerModel")
    ? normalizeAgentModelSelection(
        config.agent.workerModel,
        providerNameFromModelRef(defaultModel),
        defaultModel
      )
    : defaultSelection;

  const worker = resolvedProviderFor(config, workerModel);
  const manager = resolvedProviderFor(config, managerModel);

  config.agent.worker = worker;
  config.agent.workerModelRef = worker.modelRef;
  config.agent.workerModel = {
    model: worker.modelRef,
    reasoningEffort: worker.reasoningEffort
  };
  const explicitWorkerFallbacks = hasExplicitAgentSelection(fileAgent, "workerModelFallbacks");
  const workerFallbackInput = explicitWorkerFallbacks
    ? config.agent.workerModelFallbacks
    : config.models.default.modelFallbacks;
  config.agent.workerModelFallbacks = normalizeAgentModelSelectionList(
    workerFallbackInput,
    providerNameFromModelRef(worker.modelRef),
    worker.modelRef
  ).filter((selection) => selection.model !== worker.modelRef);
  config.agent.workerModelFallbackRefs = config.agent.workerModelFallbacks.map(
    (selection) => selection.model
  );
  config.agent.workerFallbacks = resolvedFallbackProviders(
    config,
    config.agent.workerModelFallbacks
  );

  config.agent.manager = manager;
  config.agent.managerModelRef = manager.modelRef;
  config.agent.managerModel = {
    model: manager.modelRef,
    reasoningEffort: manager.reasoningEffort
  };
  const explicitManagerFallbacks = hasExplicitAgentSelection(fileAgent, "managerModelFallbacks");
  const managerFallbackInput = explicitManagerFallbacks
    ? config.agent.managerModelFallbacks
    : config.models.default.modelFallbacks;
  config.agent.managerModelFallbacks = normalizeAgentModelSelectionList(
    managerFallbackInput,
    providerNameFromModelRef(manager.modelRef),
    manager.modelRef
  ).filter((selection) => selection.model !== manager.modelRef);
  config.agent.managerModelFallbackRefs = config.agent.managerModelFallbacks.map(
    (selection) => selection.model
  );
  config.agent.managerFallbacks = resolvedFallbackProviders(
    config,
    config.agent.managerModelFallbacks
  );
}

export function normalizeVoiceConfig(config: Config, fileVoice: JsonObject) {
  const rawProvider = typeof config.voice.provider === "string" ? config.voice.provider.trim() : "";
  const namedProvider = normalizeProviderName(rawProvider);
  const namedProviderCfg = namedProvider ? config.models.providers?.[namedProvider] : undefined;
  let providerName = "";
  let providerType = "";

  if (namedProviderCfg && SUPPORTED_VOICE_PROVIDER_TYPES.has(namedProviderCfg.type)) {
    providerName = namedProvider;
    providerType = namedProviderCfg.type;
  } else {
    providerType = normalizeVoiceProviderType(rawProvider) || DEFAULT_CONFIG.voice.provider;
    if (providerType === "codex") {
      providerName = firstProviderNameOfType(config, "codex");
    }
  }

  config.voice.provider = providerName || providerType;
  config.voice.providerName = providerName;
  config.voice.providerType = providerType;

  const modelExplicit =
    Object.hasOwn(fileVoice, "model") || Boolean(process.env.MANDATE_VOICE_MODEL);
  config.voice.model = normalizeOptionalString(config.voice.model);
  if (providerType === "codex" && !modelExplicit) {
    config.voice.model = DEFAULT_CODEX_REALTIME_MODEL;
  }
  if (!config.voice.model) {
    config.voice.model =
      providerType === "codex" ? DEFAULT_CODEX_REALTIME_MODEL : DEFAULT_CONFIG.voice.model;
  }

  config.voice.voice = normalizeOptionalString(config.voice.voice) || DEFAULT_CONFIG.voice.voice;
  config.voice.language =
    normalizeOptionalString(config.voice.language) || DEFAULT_CONFIG.voice.language;
  if (providerType === "codex") {
    config.voice.apiKey = "";
    config.voice.baseURL = "";
    config.voice.deployment = "";
    return;
  }

  config.voice.baseURL = normalizeOptionalString(config.voice.baseURL);
  config.voice.deployment = normalizeOptionalString(config.voice.deployment);
  const providerCfg = providerName ? providerConfig(config, providerName) : null;
  config.voice.apiKey = normalizeOptionalString(config.voice.apiKey) || providerCfg?.apiKey || "";
}

function findModelCapability(
  config: Config,
  modelRef: string
): ModelCapabilityConfig | null {
  const resolved = parseModelRef(modelRef);
  if (!resolved) return null;
  const provider = config.models.providers[resolved.providerName];
  const configured = provider?.models.find((model) => model.id === resolved.model);
  if (configured) return configured;
  return builtinModelCapability(provider?.type ?? "", resolved.model);
}

export function modelSupportsInput(
  config: Config,
  modelRef: string,
  input: ModelInputType
): boolean {
  if (input === "text") return true;
  const capability = findModelCapability(config, modelRef);
  return Boolean(capability?.input.includes(input));
}

function resolvedProviderFor(config: Config, selection: AgentModelSelection): ResolvedProviderConfig {
  const resolved = resolveModelRef(selection.model);
  if (!resolved) {
    return {
      providerName: "",
      provider: "",
      providerType: "",
      model: "",
      modelRef: "",
      reasoningEffort: selection.reasoningEffort,
      baseURL: "",
      organizationId: "",
      apiKey: "",
      serviceTier: ""
    };
  }
  const providerCfg = providerConfig(config, resolved.providerName);
  const capability = findModelCapability(config, selection.model);
  return {
    providerName: resolved.providerName,
    provider: providerCfg.type,
    providerType: providerCfg.type,
    model: resolved.model,
    modelRef: selection.model,
    reasoningEffort: selection.reasoningEffort,
    supportsReasoning: capability?.supportsReasoning,
    baseURL: providerCfg.baseURL,
    organizationId: providerCfg.organizationId ?? "",
    apiKey: providerCfg.apiKey,
    serviceTier: providerCfg.serviceTier ?? ""
  };
}

function resolvedFallbackProviders(
  config: Config,
  selections: AgentModelSelection[]
): ResolvedProviderConfig[] {
  const fallbacks: ResolvedProviderConfig[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.model)) continue;
    const resolved = resolvedProviderFor(config, selection);
    if (!resolved.provider || !resolved.model || !resolved.modelRef) continue;
    fallbacks.push(resolved);
    seen.add(selection.model);
  }
  return fallbacks;
}

function providerConfig(config: Config, providerName: string): ProviderConfig {
  const current = config.models.providers[providerName];
  const type = normalizeProviderType(current?.type);
  const defaults = PROVIDER_DEFAULTS[type] ?? { baseURL: "" };
  return {
    type,
    baseURL: normalizeOptionalString(current?.baseURL || defaults.baseURL),
    apiKey: providerApiKey(type, current?.apiKey),
    models: normalizeModelCapabilities(current?.models),
    ...(type === "kilo"
      ? { organizationId: normalizeOptionalString(current?.organizationId) }
      : {}),
    ...(type === "codex" ? { serviceTier: normalizeCodexServiceTier(current?.serviceTier) } : {})
  };
}

function normalizeModelRef(
  value: unknown,
  fallbackProviderName: string | undefined,
  fallbackRef: string
): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const resolved = raw ? parseModelRef(raw, fallbackProviderName) : null;
  if (resolved) return `${resolved.providerName}/${resolved.model}`;
  const fallback = parseModelRef(fallbackRef, fallbackProviderName);
  if (fallback) return `${fallback.providerName}/${fallback.model}`;
  return "";
}

function normalizeAgentModelSelection(
  value: unknown,
  fallbackProviderName: string | undefined,
  fallbackRef: string
): AgentModelSelection {
  const rawModel = isObject(value) ? value.model : value;
  const model = normalizeModelRef(rawModel, fallbackProviderName, fallbackRef);
  return {
    model,
    reasoningEffort: normalizeReasoningEffort(isObject(value) ? value.reasoningEffort : undefined)
  };
}

function normalizeAgentModelSelectionList(
  value: unknown,
  fallbackProviderName: string | undefined,
  fallbackRef: string
): AgentModelSelection[] {
  if (!Array.isArray(value)) return [];
  const selections: AgentModelSelection[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const selection = normalizeAgentModelSelection(item, fallbackProviderName, fallbackRef);
    if (!selection.model || seen.has(selection.model)) continue;
    selections.push(selection);
    seen.add(selection.model);
  }
  return selections;
}

function hasExplicitAgentSelection(fileAgent: JsonObject, key: string): boolean {
  if (!Object.hasOwn(fileAgent, key)) return false;
  const value = fileAgent[key];
  if (value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

function parseModelRef(
  value: string,
  fallbackProviderName?: string
): { providerName: string; model: string } | null {
  const raw = value.trim();
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const providerName = normalizeProviderName(raw.slice(0, slash));
    const model = raw.slice(slash + 1).trim();
    return providerName && model ? { providerName, model } : null;
  }
  const providerName = normalizeProviderName(fallbackProviderName);
  return providerName ? { providerName, model: raw } : null;
}

function resolveModelRef(modelRef: string) {
  return parseModelRef(modelRef);
}

function providerNameFromModelRef(modelRef: unknown) {
  if (typeof modelRef !== "string") return "";
  const slash = modelRef.indexOf("/");
  if (slash <= 0) return "";
  return normalizeProviderName(modelRef.slice(0, slash));
}

function firstProviderNameOfType(config: Config, providerType: string) {
  for (const [name, cfg] of Object.entries(config.models.providers ?? {})) {
    if (cfg.type === providerType) return name;
  }
  return "";
}

function providerApiKey(providerType: string, configured: unknown) {
  if (providerType === "codex") {
    return "";
  }
  const explicit = normalizeOptionalString(configured);
  if (explicit) return explicit;
  if (providerType === "openai" || providerType === "openai-compatible") {
    return process.env.OPENAI_API_KEY || "";
  }
  if (providerType === "anthropic") {
    return process.env.ANTHROPIC_API_KEY || "";
  }
  if (providerType === "google") {
    return process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_API_KEY || "";
  }
  return "";
}

function normalizeModelCapabilities(value: unknown): ModelCapabilityConfig[] {
  if (!Array.isArray(value)) return [];
  const models: ModelCapabilityConfig[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const id = normalizeOptionalString(entry.id);
    if (!id || seen.has(id)) continue;
    const input = normalizeModelInputs(entry.input);
    models.push({
      id,
      input,
      ...(typeof entry.supportsReasoning === "boolean"
        ? { supportsReasoning: entry.supportsReasoning }
        : {})
    });
    seen.add(id);
  }
  return models;
}

function normalizeModelInputs(value: unknown): ModelInputType[] {
  const inputs = new Set<ModelInputType>(["text"]);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "string") continue;
      const normalized = item.trim().toLowerCase();
      if (MODEL_INPUT_TYPES.has(normalized as ModelInputType)) {
        inputs.add(normalized as ModelInputType);
      }
    }
  }
  return [...inputs];
}

function builtinModelCapability(
  providerType: string,
  modelId: string
): ModelCapabilityConfig | null {
  const input = builtinModelInputs(providerType, modelId);
  return input ? { id: modelId, input } : null;
}

function builtinModelInputs(providerType: string, modelId: string): ModelInputType[] | null {
  const id = modelId.trim().toLowerCase();
  if (!id) return null;
  if (providerType === "codex" && /^gpt-5\./.test(id)) return ["text", "image"];
  if (providerType === "openai" && /^(gpt-5\.|gpt-4\.1|gpt-4o)/.test(id)) return ["text", "image"];
  if (providerType === "anthropic" && id.startsWith("claude-")) return ["text", "image"];
  if (providerType === "google" && id.startsWith("gemini-")) return ["text", "image"];
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
