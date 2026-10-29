import {
  DEFAULT_CODEX_REALTIME_MODEL,
  DEFAULT_COMPRESSION_THRESHOLD_TOKENS,
  DEFAULT_IDLE_COMPACTION_LEAD_MINUTES,
  DEFAULT_IDLE_COMPACTION_MIN_TOKENS,
  DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT
} from "../../shared/settings.js";
import type { Config, ResolvedProviderConfig } from "./types.js";

export function emptyResolvedProvider(): ResolvedProviderConfig {
  return {
    providerName: "",
    provider: "",
    providerType: "",
    model: "",
    modelRef: "",
    reasoningEffort: "provider-default",
    supportsReasoning: undefined,
    baseURL: "",
    organizationId: "",
    apiKey: "",
    serviceTier: ""
  };
}

export const DEFAULT_CONFIG: Config = {
  port: 4173,
  // Listen address. Default 127.0.0.1 keeps Mandate localhost-only since it
  // holds LLM API keys + agent control. Override to 0.0.0.0 (or a specific
  // LAN IP) via --host or MANDATE_HOST when explicit LAN access is wanted.
  host: "127.0.0.1",
  // Mandate has no login, and a browser lets any page send a write or open a
  // WebSocket to an address it can reach, this one included. The server
  // therefore refuses those from a page it did not serve. Off only for a setup
  // the check gets wrong (a proxy that rewrites the Host header, say).
  checkOrigin: true,
  pollIntervalMs: 5000,
  captureLines: 120,
  logging: {
    level: "info"
  },
  models: {
    default: {
      model: "",
      reasoningEffort: "provider-default",
      modelFallbacks: []
    },
    providers: {},
    prices: { autoUpdate: true }
  },
  agent: {
    preferences: "",
    managerModel: { model: "", reasoningEffort: "provider-default" },
    managerModelFallbacks: [],
    managerFallbacks: [],
    workerModel: { model: "", reasoningEffort: "provider-default" },
    workerModelFallbacks: [],
    workerFallbacks: [],
    globalModel: { model: "", reasoningEffort: "provider-default" },
    globalModelFallbacks: [],
    globalFallbacks: [],
    dreamModel: { model: "", reasoningEffort: "provider-default" },
    dreamModelFallbacks: [],
    dreamFallbacks: [],
    extractionModel: { model: "", reasoningEffort: "provider-default" },
    extractionModelFallbacks: [],
    extractionFallbacks: [],
    subagentModel: { model: "", reasoningEffort: "provider-default" },
    subagentModelFallbacks: [],
    subagentFallbacks: [],
    subagentRouteSet: false,
    pageModel: { model: "", reasoningEffort: "provider-default" },
    pageModelFallbacks: [],
    pageFallbacks: [],
    pageRouteSet: false,
    decisionsEnabled: false,
    decisionsModel: { model: "", reasoningEffort: "provider-default" },
    decisionsModelFallbacks: [],
    decisionsFallbacks: [],
    managerRequestCheckModel: { model: "", reasoningEffort: "provider-default" },
    managerRequestCheckModelFallbacks: [],
    managerRequestCheckFallbacks: [],
    managerRequestCheckRouteSet: false,
    managerRequestCheckEnabled: true,
    managerStopCheckModel: { model: "", reasoningEffort: "provider-default" },
    managerStopCheckModelFallbacks: [],
    managerStopCheckFallbacks: [],
    managerStopCheckRouteSet: false,
    managerStopCheckEnabled: false,
    memoryRepeatCheckModel: { model: "", reasoningEffort: "provider-default" },
    memoryRepeatCheckModelFallbacks: [],
    memoryRepeatCheckFallbacks: [],
    memoryRepeatCheckRouteSet: false,
    memoryRepeatCheckEnabled: false,
    cacheSealEnabled: true,
    manager: emptyResolvedProvider(),
    worker: emptyResolvedProvider(),
    global: emptyResolvedProvider(),
    dream: emptyResolvedProvider(),
    extraction: emptyResolvedProvider(),
    subagent: emptyResolvedProvider(),
    page: emptyResolvedProvider(),
    decisions: emptyResolvedProvider(),
    managerRequestCheck: emptyResolvedProvider(),
    managerStopCheck: emptyResolvedProvider(),
    memoryRepeatCheck: emptyResolvedProvider(),
    compressionThresholdTokens: DEFAULT_COMPRESSION_THRESHOLD_TOKENS,
    idleCompactionEnabled: true,
    idleCompactionLeadMinutes: DEFAULT_IDLE_COMPACTION_LEAD_MINUTES,
    idleCompactionMinTokens: DEFAULT_IDLE_COMPACTION_MIN_TOKENS,
    /** "off" | "metadata" | "full" - how much to record in llm_calls for
     *  agent wakes + compression. */
    logRequests: "metadata",
    /** The global agent's name; "" until the user names it (the guide shows). */
    globalAgentName: ""
  },
  memory: {
    embedding: {
      model: ""
    },
    dream: {
      enabled: true
    }
  },
  webSearch: {
    use: "off",
    kinds: {}
  },
  retention: {
    chatRetentionDays: 90,
    chatMaxTableBytes: 512 * 1024 * 1024,
    chatToolResultHeadChars: 2000
  },
  voice: {
    provider: "openai",
    providerName: "",
    providerType: "openai",
    apiKey: "",
    model: "gpt-realtime-mini",
    voice: "marin",
    language: "auto",
    idleTimeoutMs: 5 * 60 * 1000,
    maxSessionMs: 25 * 60 * 1000,
    /** Number of recent user/assistant dialogue messages from the overview
     *  thread to preload into the realtime conversation when a voice session
     *  starts. 0 = full amnesia. Tool calls and summary messages are filtered
     *  out before counting. Clamped to [0, 100]. */
    contextMessageCount: DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT,
    /** Override the realtime WebSocket base URL. Defaults to OpenAI's
     *  `wss://api.openai.com/v1/realtime`. Set to your Azure GA endpoint
     *  (`wss://<resource>.openai.azure.com/openai/v1/realtime`) to use
     *  Azure OpenAI; the provider detects Azure by host and switches to
     *  api-key auth + deployment-name query param automatically. */
    baseURL: "",
    /** Azure OpenAI only: deployment name. Falls back to `model` when blank. */
    deployment: ""
  }
};

export { DEFAULT_CODEX_REALTIME_MODEL };
