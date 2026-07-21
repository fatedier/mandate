import {
  LOG_REQUEST_MODES,
  PROVIDER_TYPES,
  REASONING_EFFORTS,
  isJsonObject,
  isValidProviderName,
  type JsonObject,
  type ProviderAuthRename
} from "./config-normalizers.js";
import { SETTINGS_NUMBER_LIMITS } from "../../../shared/settings.js";
import {
  normalizeHost,
  normalizePort,
  previousProviderName,
  sectionFor,
  setAgentModelSelection,
  setAgentModelSelectionArray,
  setCodexServiceTier,
  setBoolean,
  setEnum,
  setModelRef,
  setPositiveNumber,
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
  "maxStepsPerWake",
  "compressionThresholdTokens",
  "logRequests"
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

export function applyModelsPatch(
  root: JsonObject,
  patch: unknown,
  authRenames: ProviderAuthRename[]
) {
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
      const previousName = previousProviderName(providerPatch);
      const existing = isJsonObject(currentProviders[provider]) ? currentProviders[provider] : {};
      const target: JsonObject = { ...existing };
      setEnum(target, providerPatch, "type", PROVIDER_TYPES);
      if (!target.type) throw new Error(`models.providers.${provider}.type is required`);
      setString(target, providerPatch, "baseURL");
      setProviderModels(target, providerPatch);
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
      if (target.type === "codex" && previousName && previousName !== provider) {
        authRenames.push({ from: previousName, to: provider });
      }
      providers[provider] = target;
    }
    section.providers = providers;
  }
}

export function applyAgentPatch(root: JsonObject, patch: unknown) {
  if (!isJsonObject(patch)) throw new Error("agent settings must be an object");
  const section = sectionFor(root, "agent");

  setString(section, patch, "preferences");
  setAgentModelSelection(section, patch, "managerModel");
  setAgentModelSelectionArray(section, patch, "managerModelFallbacks");
  setAgentModelSelection(section, patch, "workerModel");
  setAgentModelSelectionArray(section, patch, "workerModelFallbacks");
  setPositiveNumber(section, patch, "maxStepsPerWake", {
    min: SETTINGS_NUMBER_LIMITS.agent.maxStepsPerWake.min,
    integer: true
  });
  setPositiveNumber(section, patch, "compressionThresholdTokens", {
    min: SETTINGS_NUMBER_LIMITS.agent.compressionThresholdTokens.min,
    integer: true
  });
  setEnum(section, patch, "logRequests", LOG_REQUEST_MODES);

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
  delete root.analysis;
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
