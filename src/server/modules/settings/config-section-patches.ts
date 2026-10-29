import {
  LOG_REQUEST_MODES,
  PROVIDER_TYPES,
  REASONING_EFFORTS,
  isJsonObject,
  isValidProviderName,
  type JsonObject
} from "./config-normalizers.js";
import { PROVIDER_BILLING_VALUES, SETTINGS_NUMBER_LIMITS } from "../../../shared/settings.js";
import { GLOBAL_AGENT_NAME_MAX, normalizeGlobalAgentName } from "../../../shared/global-agent-name.js";
import {
  normalizeHost,
  normalizePort,
  sectionFor,
  setAgentModelSelection,
  setAgentModelSelectionArray,
  setCodexServiceTier,
  setBoolean,
  setEnum,
  setModelRef,
  setPositiveNumber,
  setWholeNumber,
  setProviderModels,
  setSecret,
  setString,
  setVoiceProvider,
  voiceProviderTypeFor
} from "./config-patch-helpers.js";

const AGENT_KEYS = [
  "preferences",
  "managerModel",
  "managerModelFallbacks",
  "workerModel",
  "workerModelFallbacks",
  "globalModel",
  "globalModelFallbacks",
  "dreamModel",
  "dreamModelFallbacks",
  "extractionModel",
  "extractionModelFallbacks",
  "subagentModel",
  "subagentModelFallbacks",
  "pageModel",
  "pageModelFallbacks",
  "decisionsEnabled",
  "decisionsModel",
  "decisionsModelFallbacks",
  "managerRequestCheckModel",
  "managerRequestCheckModelFallbacks",
  "managerRequestCheckEnabled",
  "managerStopCheckModel",
  "managerStopCheckModelFallbacks",
  "managerStopCheckEnabled",
  "memoryRepeatCheckModel",
  "memoryRepeatCheckModelFallbacks",
  "memoryRepeatCheckEnabled",
  // The file alone sets it (no Settings control); a save keeps it.
  "cacheSealEnabled",
  "compressionThresholdTokens",
  "idleCompactionEnabled",
  "idleCompactionLeadMinutes",
  "idleCompactionMinTokens",
  "logRequests",
  "globalAgentName"
] as const;

const MEMORY_KEYS = ["embedding", "dream"] as const;
const MEMORY_EMBEDDING_KEYS = ["model"] as const;
const MEMORY_DREAM_KEYS = ["enabled"] as const;
const MODEL_DEFAULT_KEYS = ["model", "reasoningEffort", "modelFallbacks"] as const;

export function applyServerPatch(root: JsonObject, patch: unknown) {
  if (!isJsonObject(patch)) throw new Error("server settings must be an object");
  if (Object.hasOwn(patch, "host")) {
    root.host = normalizeHost(patch.host, "server.host");
  }
  if (Object.hasOwn(patch, "port")) {
    root.port = normalizePort(patch.port, "server.port");
  }
}

export function applyModelsPatch(root: JsonObject, patch: unknown) {
  if (!isJsonObject(patch)) throw new Error("models settings must be an object");
  const section = sectionFor(root, "models");

  if (Object.hasOwn(patch, "default")) {
    if (!isJsonObject(patch.default)) throw new Error("models.default must be an object");
    const defaults = sectionFor(section, "default");
    setModelRef(defaults, patch.default, "model");
    setEnum(defaults, patch.default, "reasoningEffort", REASONING_EFFORTS);
    setAgentModelSelectionArray(defaults, patch.default, "modelFallbacks");
    keepKeys(defaults, MODEL_DEFAULT_KEYS);
  }

  if (Object.hasOwn(patch, "providers")) {
    if (!isJsonObject(patch.providers)) throw new Error("models.providers must be an object");
    const currentProviders = isJsonObject(section.providers) ? section.providers : {};
    const providers: JsonObject = {};
    for (const [provider, providerPatch] of Object.entries(patch.providers)) {
      if (!isValidProviderName(provider)) throw new Error(`invalid provider name: ${provider}`);
      if (!isJsonObject(providerPatch))
        throw new Error(`models.providers.${provider} must be an object`);
      // A provider is its name: it cannot be renamed, so the one saved under
      // this name is the one being edited.
      const existing = isJsonObject(currentProviders[provider]) ? currentProviders[provider] : {};
      const target: JsonObject = { ...existing };
      setEnum(target, providerPatch, "type", PROVIDER_TYPES);
      if (!target.type) throw new Error(`models.providers.${provider}.type is required`);
      setString(target, providerPatch, "baseURL");
      setEnum(target, providerPatch, "billing", BILLING_VALUES);
      setProviderModels(target, providerPatch);
      // Only a custom provider chooses its models' API, or serves decision
      // models; the others have one API and chat models only.
      if (target.type !== "openai-compatible") dropCustomModelFields(target);
      if (target.type === "codex") {
        setCodexServiceTier(target, providerPatch);
        delete target.apiKey;
        delete target.organizationId;
      } else {
        delete target.serviceTier;
        setSecret(target, providerPatch, "apiKey", "clearApiKey");
        if (target.type === "kilo") {
          setString(target, providerPatch, "organizationId");
        } else {
          delete target.organizationId;
        }
      }
      providers[provider] = target;
    }
    section.providers = providers;
  }

  if (Object.hasOwn(patch, "prices")) {
    if (!isJsonObject(patch.prices)) throw new Error("models.prices must be an object");
    const prices = sectionFor(section, "prices");
    setBoolean(prices, patch.prices, "autoUpdate");
    keepKeys(prices, ["autoUpdate"]);
  }
}

const BILLING_VALUES: ReadonlySet<string> = new Set(PROVIDER_BILLING_VALUES);

function dropCustomModelFields(target: JsonObject) {
  if (!Array.isArray(target.models)) return;
  target.models = target.models.map((model) => {
    if (!isJsonObject(model) || (!Object.hasOwn(model, "protocol") && !Object.hasOwn(model, "kind"))) return model;
    const rest = { ...model };
    delete rest.protocol;
    delete rest.kind;
    return rest;
  });
}

export function applyAgentPatch(root: JsonObject, patch: unknown) {
  if (!isJsonObject(patch)) throw new Error("agent settings must be an object");
  const section = sectionFor(root, "agent");

  setString(section, patch, "preferences");
  setAgentModelSelection(section, patch, "managerModel");
  setAgentModelSelectionArray(section, patch, "managerModelFallbacks");
  setAgentModelSelection(section, patch, "workerModel");
  setAgentModelSelectionArray(section, patch, "workerModelFallbacks");
  setAgentModelSelection(section, patch, "globalModel");
  setAgentModelSelectionArray(section, patch, "globalModelFallbacks");
  setAgentModelSelection(section, patch, "dreamModel");
  setAgentModelSelectionArray(section, patch, "dreamModelFallbacks");
  setAgentModelSelection(section, patch, "extractionModel");
  setAgentModelSelectionArray(section, patch, "extractionModelFallbacks");
  setAgentModelSelection(section, patch, "subagentModel");
  setAgentModelSelectionArray(section, patch, "subagentModelFallbacks");
  setAgentModelSelection(section, patch, "pageModel");
  setAgentModelSelectionArray(section, patch, "pageModelFallbacks");
  setBoolean(section, patch, "decisionsEnabled");
  setAgentModelSelection(section, patch, "decisionsModel");
  setAgentModelSelectionArray(section, patch, "decisionsModelFallbacks");
  setAgentModelSelection(section, patch, "managerRequestCheckModel");
  setAgentModelSelectionArray(section, patch, "managerRequestCheckModelFallbacks");
  setBoolean(section, patch, "managerRequestCheckEnabled");
  setAgentModelSelection(section, patch, "managerStopCheckModel");
  setAgentModelSelectionArray(section, patch, "managerStopCheckModelFallbacks");
  setBoolean(section, patch, "managerStopCheckEnabled");
  setAgentModelSelection(section, patch, "memoryRepeatCheckModel");
  setAgentModelSelectionArray(section, patch, "memoryRepeatCheckModelFallbacks");
  setBoolean(section, patch, "memoryRepeatCheckEnabled");
  setPositiveNumber(section, patch, "compressionThresholdTokens", {
    min: SETTINGS_NUMBER_LIMITS.agent.compressionThresholdTokens.min,
    integer: true
  });
  setBoolean(section, patch, "idleCompactionEnabled");
  setWholeNumber(section, patch, "idleCompactionLeadMinutes", SETTINGS_NUMBER_LIMITS.agent.idleCompactionLeadMinutes);
  setWholeNumber(section, patch, "idleCompactionMinTokens", SETTINGS_NUMBER_LIMITS.agent.idleCompactionMinTokens);
  setEnum(section, patch, "logRequests", LOG_REQUEST_MODES);
  if (Object.hasOwn(patch, "globalAgentName")) {
    const value = patch.globalAgentName;
    if (value !== null && typeof value !== "string") throw new Error("globalAgentName must be a string");
    const name = normalizeGlobalAgentName(value ?? "");
    if (name === null) throw new Error(`globalAgentName must be at most ${GLOBAL_AGENT_NAME_MAX} characters`);
    section.globalAgentName = name;
  }

  keepKeys(section, AGENT_KEYS);
}

export function applyMemoryPatch(root: JsonObject, patch: unknown) {
  if (!isJsonObject(patch)) throw new Error("memory settings must be an object");
  const section = sectionFor(root, "memory");
  const embedding = sectionFor(section, "embedding");
  const dream = sectionFor(section, "dream");
  if (Object.hasOwn(patch, "embedding")) {
    if (!isJsonObject(patch.embedding)) throw new Error("memory.embedding must be an object");
    setString(embedding, patch.embedding, "model");
  }
  if (Object.hasOwn(patch, "dream")) {
    if (!isJsonObject(patch.dream)) throw new Error("memory.dream must be an object");
    setBoolean(dream, patch.dream, "enabled");
  }

  keepKeys(embedding, MEMORY_EMBEDDING_KEYS);
  keepKeys(dream, MEMORY_DREAM_KEYS);
  keepKeys(section, MEMORY_KEYS);
}

export function applyVoicePatch(root: JsonObject, patch: unknown) {
  if (!isJsonObject(patch)) throw new Error("voice settings must be an object");
  const section = sectionFor(root, "voice");

  setVoiceProvider(section, patch, "provider");
  setString(section, patch, "model");
  setString(section, patch, "voice");
  setString(section, patch, "language");
  setString(section, patch, "baseURL");
  setString(section, patch, "deployment");
  setPositiveNumber(section, patch, "idleTimeoutMs", {
    min: SETTINGS_NUMBER_LIMITS.voice.idleTimeoutMs.min,
    integer: true
  });
  setPositiveNumber(section, patch, "maxSessionMs", {
    min: SETTINGS_NUMBER_LIMITS.voice.maxSessionMs.min,
    integer: true
  });
  setPositiveNumber(section, patch, "contextMessageCount", {
    min: SETTINGS_NUMBER_LIMITS.voice.contextMessageCount.min,
    max: SETTINGS_NUMBER_LIMITS.voice.contextMessageCount.max,
    integer: true
  });
  if (voiceProviderTypeFor(root, section.provider) === "codex") {
    delete section.apiKey;
    delete section.baseURL;
    delete section.deployment;
  } else {
    setSecret(section, patch, "apiKey", "clearApiKey");
  }
}

export function pruneSettingsSections(root: JsonObject) {
  if (isJsonObject(root.models) && isJsonObject(root.models.default)) {
    keepKeys(root.models.default, MODEL_DEFAULT_KEYS);
  }
  if (isJsonObject(root.agent)) {
    keepKeys(root.agent, AGENT_KEYS);
  }
  if (isJsonObject(root.memory)) {
    if (isJsonObject(root.memory.embedding)) {
      keepKeys(root.memory.embedding, MEMORY_EMBEDDING_KEYS);
    }
    if (isJsonObject(root.memory.dream)) {
      keepKeys(root.memory.dream, MEMORY_DREAM_KEYS);
    }
    keepKeys(root.memory, MEMORY_KEYS);
  }
}

function keepKeys(section: JsonObject, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(section)) {
    if (!allowedSet.has(key)) {
      delete section[key];
    }
  }
}
