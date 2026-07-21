import { getCodexAuthStatus, type CodexAuthStorage } from "../codex/codex-auth-store.js";
import { loadConfig, type Config, type JsonObject } from "../../config.js";
import { configPath } from "../../config/config-store.js";
import type { JsonStore } from "../../platform/storage/json-store.js";
import type {
  LogRequestsMode,
  ProviderSettings,
  ProviderType,
  SettingsConfigPayload,
  VoiceProviderType
} from "../../../shared/settings.js";
import { providerModelsWithBuiltins } from "./provider-models.js";

interface SettingsPayloadDeps {
  config?: Config;
  configStore?: JsonStore<JsonObject>;
  codexAuthStore?: CodexAuthStorage;
}

export function buildSettingsConfigPayload(
  restartRequired: boolean,
  deps: SettingsPayloadDeps = {}
): SettingsConfigPayload {
  const config =
    deps.config ?? (deps.configStore ? loadConfig(undefined, deps.configStore) : loadConfig());
  const rawConfig = deps.configStore?.read() ?? {};
  const rawAgent = isRecord(rawConfig.agent) ? rawConfig.agent : {};
  const modelOverrides = agentModelOverrides(config, rawAgent);
  const providers: Record<string, ProviderSettings> = Object.fromEntries(
    Object.entries(config.models.providers).map(([provider, cfg]) => {
      const auth =
        cfg.type === "codex"
          ? getCodexAuthStatus(provider, deps.codexAuthStore ?? undefined)
          : null;
      const providerPayload: ProviderSettings = {
        type: cfg.type as ProviderType,
        baseURL: cfg.baseURL,
        models: providerModelsWithBuiltins(cfg),
        apiKeyConfigured: cfg.type === "codex" ? (auth?.configured ?? false) : Boolean(cfg.apiKey)
      };
      if (cfg.type === "codex") {
        providerPayload.serviceTier = cfg.serviceTier ?? "";
        providerPayload.auth = auth ?? undefined;
      }
      if (cfg.type === "kilo") {
        providerPayload.organizationId = cfg.organizationId ?? "";
      }
      return [provider, providerPayload];
    })
  );
  return {
    configPath: deps.configStore?.filePath ?? configPath(),
    restartRequired,
    server: {
      host: config.host,
      port: config.port
    },
    models: {
      default: {
        model: config.models.default.model,
        reasoningEffort: config.models.default.reasoningEffort,
        modelFallbacks: config.models.default.modelFallbacks
      },
      providers
    },
    agent: {
      preferences: config.agent.preferences,
      managerModel: config.agent.managerModel,
      managerModelFallbacks: config.agent.managerModelFallbacks,
      workerModel: config.agent.workerModel,
      workerModelFallbacks: config.agent.workerModelFallbacks,
      modelOverrides,
      manager: {
        model: config.agent.manager.modelRef,
        provider: config.agent.manager.provider,
        apiKeyConfigured: credentialConfigured(
          config.agent.manager.provider,
          config.agent.manager.providerName,
          config.agent.manager.apiKey,
          deps.codexAuthStore
        )
      },
      worker: {
        model: config.agent.worker.modelRef,
        provider: config.agent.worker.provider,
        apiKeyConfigured: credentialConfigured(
          config.agent.worker.provider,
          config.agent.worker.providerName,
          config.agent.worker.apiKey,
          deps.codexAuthStore
        )
      },
      maxStepsPerWake: config.agent.maxStepsPerWake,
      compressionThresholdTokens: config.agent.compressionThresholdTokens,
      logRequests: config.agent.logRequests as LogRequestsMode
    },
    memory: {
      embedding: {
        model: config.memory.embedding.model
      },
      dream: {
        enabled: config.memory.dream.enabled
      }
    },
    voice: {
      provider: config.voice.provider,
      providerName: config.voice.providerName,
      providerType: config.voice.providerType as VoiceProviderType,
      model: config.voice.model,
      voice: config.voice.voice,
      language: config.voice.language,
      baseURL: config.voice.baseURL,
      deployment: config.voice.deployment,
      idleTimeoutMs: config.voice.idleTimeoutMs,
      maxSessionMs: config.voice.maxSessionMs,
      contextMessageCount: config.voice.contextMessageCount,
      apiKeyConfigured: voiceCredentialConfigured(config.voice, deps.codexAuthStore),
      auth:
        config.voice.providerType === "codex" && config.voice.providerName
          ? getCodexAuthStatus(config.voice.providerName, deps.codexAuthStore ?? undefined)
          : undefined
    }
  };
}

function agentModelOverrides(config: Config, rawAgent: JsonObject) {
  const defaultSelection = {
    model: config.models.default.model,
    reasoningEffort: config.models.default.reasoningEffort
  };
  const defaultFallbacks = config.models.default.modelFallbacks;
  return {
    manager:
      Object.hasOwn(rawAgent, "managerModel") ||
      Object.hasOwn(rawAgent, "managerModelFallbacks") ||
      !sameSelection(config.agent.managerModel, defaultSelection) ||
      !sameSelectionList(config.agent.managerModelFallbacks, defaultFallbacks),
    worker:
      Object.hasOwn(rawAgent, "workerModel") ||
      Object.hasOwn(rawAgent, "workerModelFallbacks") ||
      !sameSelection(config.agent.workerModel, defaultSelection) ||
      !sameSelectionList(config.agent.workerModelFallbacks, defaultFallbacks)
  };
}

function sameSelection(
  a: { model: string; reasoningEffort: string },
  b: { model: string; reasoningEffort: string }
) {
  return a.model === b.model && a.reasoningEffort === b.reasoningEffort;
}

function sameSelectionList(
  a: Array<{ model: string; reasoningEffort: string }>,
  b: Array<{ model: string; reasoningEffort: string }>
) {
  return a.length === b.length && a.every((item, index) => sameSelection(item, b[index]!));
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function credentialConfigured(
  providerType: string,
  providerName: string,
  apiKey: string,
  codexAuthStore?: CodexAuthStorage
) {
  if (providerType === "codex") {
    return getCodexAuthStatus(providerName, codexAuthStore ?? undefined).configured;
  }
  return Boolean(apiKey);
}

function voiceCredentialConfigured(voice: Config["voice"], codexAuthStore?: CodexAuthStorage) {
  if (voice.providerType === "codex") {
    return Boolean(
      voice.providerName &&
      getCodexAuthStatus(voice.providerName, codexAuthStore ?? undefined).configured
    );
  }
  return Boolean(voice.apiKey);
}
