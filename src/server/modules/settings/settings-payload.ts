import { toolReviewAvailable } from "../../config/model-resolution.js";
import { getCodexAuthStatus, type CodexAuthStorage } from "../codex/codex-auth-store.js";
import { loadConfig, type AgentRoute, type Config, type JsonObject } from "../../config.js";
import type { JsonStore } from "../../platform/storage/json-store.js";
import type {
  LogRequestsMode,
  ProviderSettings,
  ProviderType,
  SettingsConfigPayload,
  VoiceProviderType
} from "../../../shared/settings.js";
import { providerModelsWithBuiltins } from "./provider-models.js";
import { providerBilling } from "../../../shared/settings.js";
import { hasExplicitAgentSelection } from "../../config/model-resolution.js";
import { isRecord } from "../../../shared/guards.js";
import { webSearchSettings } from "../web/web-search-settings.js";
import { notificationsSettings } from "../notifications/notifications-settings.js";
import { flatFromFile } from "../../config/file-layout.js";

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
  // Which routes the file sets, in the app's flat keys (file-layout.ts).
  const rawConfig = flatFromFile(deps.configStore?.read() ?? {});
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
        billing: providerBilling(cfg),
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
    restartRequired,
    server: {
      host: config.host,
      port: config.port
    },
    models: {
      default: {
        model: config.models.default.model,
        reasoningEffort: config.models.default.reasoningEffort,
        ...(config.models.default.serviceTier ? { serviceTier: config.models.default.serviceTier } : {}),
        modelFallbacks: config.models.default.modelFallbacks
      },
      providers,
      prices: { autoUpdate: config.models.prices.autoUpdate }
    },
    agent: {
      preferences: config.agent.preferences,
      managerModel: config.agent.managerModel,
      managerModelFallbacks: config.agent.managerModelFallbacks,
      workerModel: config.agent.workerModel,
      workerModelFallbacks: config.agent.workerModelFallbacks,
      personalModel: config.agent.personalModel,
      personalModelFallbacks: config.agent.personalModelFallbacks,
      dreamModel: config.agent.dreamModel,
      dreamModelFallbacks: config.agent.dreamModelFallbacks,
      extractionModel: config.agent.extractionModel,
      extractionModelFallbacks: config.agent.extractionModelFallbacks,
      subagentModel: config.agent.subagentModel,
      subagentModelFallbacks: config.agent.subagentModelFallbacks,
      pageModel: config.agent.pageModel,
      pageModelFallbacks: config.agent.pageModelFallbacks,
      skillReviewModel: config.agent.skillReviewModel,
      skillReviewModelFallbacks: config.agent.skillReviewModelFallbacks,
      decisionsEnabled: config.agent.decisionsEnabled,
      decisionsModel: config.agent.decisionsModel,
      decisionsModelFallbacks: config.agent.decisionsModelFallbacks,
      managerRequestCheckModel: config.agent.managerRequestCheckModel,
      managerRequestCheckModelFallbacks: config.agent.managerRequestCheckModelFallbacks,
      managerRequestCheckEnabled: config.agent.managerRequestCheckEnabled,
      managerStopCheckModel: config.agent.managerStopCheckModel,
      managerStopCheckModelFallbacks: config.agent.managerStopCheckModelFallbacks,
      managerStopCheckEnabled: config.agent.managerStopCheckEnabled,
      memoryRepeatCheckModel: config.agent.memoryRepeatCheckModel,
      memoryRepeatCheckModelFallbacks: config.agent.memoryRepeatCheckModelFallbacks,
      memoryRepeatCheckEnabled: config.agent.memoryRepeatCheckEnabled,
      // On only while it can run: what the next save will keep.
      toolReviewEnabled: config.agent.toolReviewEnabled && toolReviewAvailable(config),
      toolReviewRules: config.agent.toolReviewRules,
      toolReviewScreenModel: config.agent.toolReviewScreenModel,
      toolReviewScreenModelFallbacks: config.agent.toolReviewScreenModelFallbacks,
      toolReviewSecondLookModel: config.agent.toolReviewSecondLookModel,
      toolReviewSecondLookModelFallbacks: config.agent.toolReviewSecondLookModelFallbacks,
      modelOverrides,
      compressionThresholdTokens: config.agent.compressionThresholdTokens,
      idleCompactionEnabled: config.agent.idleCompactionEnabled,
      idleCompactionLeadMinutes: config.agent.idleCompactionLeadMinutes,
      idleCompactionMinTokens: config.agent.idleCompactionMinTokens,
      logRequests: config.agent.logRequests as LogRequestsMode,
      personalAgentName: config.agent.personalAgentName
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
    },
    webSearch: webSearchSettings(config),
    notifications: notificationsSettings(config),
    retention: {
      chatMaxTableBytes: config.retention.chatMaxTableBytes,
      chatToolResultHeadChars: config.retention.chatToolResultHeadChars
    }
  };
}

/** Whether each route has a model chain of its own: the file sets one, or its
 *  chain differs from the default's. The subagent route's is what the router
 *  reads, whether the file sets it. */
function agentModelOverrides(config: Config, rawAgent: JsonObject) {
  const defaultSelection = {
    model: config.models.default.model,
    reasoningEffort: config.models.default.reasoningEffort,
    serviceTier: config.models.default.serviceTier
  };
  const defaultFallbacks = config.models.default.modelFallbacks;
  const own = (route: AgentRoute) =>
    hasExplicitAgentSelection(rawAgent, `${route}Model`) ||
    hasExplicitAgentSelection(rawAgent, `${route}ModelFallbacks`) ||
    !sameSelection(config.agent[`${route}Model` as const], defaultSelection) ||
    !sameSelectionList(config.agent[`${route}ModelFallbacks` as const], defaultFallbacks);
  return {
    manager: own("manager"),
    worker: own("worker"),
    personal: own("personal"),
    dream: own("dream"),
    extraction: own("extraction"),
    // A chain equal to the default's cannot tell set from unset, and a read
    // of the settings holds no file (rawAgent is {} on GET, settings-routes
    // builds its service without a store); for this route the two differ —
    // unset, a subagent runs on the asking agent's route.
    subagent: config.agent.subagentRouteSet,
    // The same holds for the page updates' route.
    page: config.agent.pageRouteSet,
    skillReview: config.agent.skillReviewRouteSet,
    // And for Manager request check's and Manager stop check's: unset, each runs on Decisions.
    managerRequestCheck: config.agent.managerRequestCheckRouteSet,
    managerStopCheck: config.agent.managerStopCheckRouteSet,
    memoryRepeatCheck: config.agent.memoryRepeatCheckRouteSet,
    toolReviewScreen: config.agent.toolReviewScreenRouteSet,
    toolReviewSecondLook: config.agent.toolReviewSecondLookRouteSet
  };
}

type StepSettings = { model: string; reasoningEffort: string; serviceTier?: string };

function sameSelection(a: StepSettings, b: StepSettings) {
  return a.model === b.model && a.reasoningEffort === b.reasoningEffort && (a.serviceTier ?? "") === (b.serviceTier ?? "");
}

function sameSelectionList(a: StepSettings[], b: StepSettings[]) {
  return a.length === b.length && a.every((item, index) => sameSelection(item, b[index]!));
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
