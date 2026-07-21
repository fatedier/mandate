import {
  DEFAULT_CODEX_REALTIME_MODEL,
  DEFAULT_COMPRESSION_THRESHOLD_TOKENS,
  DEFAULT_VOICE_CONTEXT_MESSAGE_COUNT
} from "../../shared/settings.js";
import type { Config, ResolvedProviderConfig } from "./types.js";

export const DEFAULT_AGENT_PREFERENCES = [
  "Prefer Claude for planning and design.",
  "Prefer Codex for code implementation."
].join("\n");

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
    providers: {}
  },
  agent: {
    preferences: DEFAULT_AGENT_PREFERENCES,
    managerModel: { model: "", reasoningEffort: "provider-default" },
    managerModelRef: "",
    managerModelFallbackRefs: [],
    managerModelFallbacks: [],
    managerFallbacks: [],
    workerModel: { model: "", reasoningEffort: "provider-default" },
    workerModelRef: "",
    workerModelFallbackRefs: [],
    workerModelFallbacks: [],
    workerFallbacks: [],
    manager: emptyResolvedProvider(),
    worker: emptyResolvedProvider(),
    maxStepsPerWake: 200,
    compressionThresholdTokens: DEFAULT_COMPRESSION_THRESHOLD_TOKENS,
    /** "off" | "metadata" | "full" - how much to record in llm_calls for
     *  agent wakes + compression. */
    logRequests: "metadata"
  },
  memory: {
    embedding: {
      model: ""
    },
    dream: {
      enabled: true
    }
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
