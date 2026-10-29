import type {
  AgentModelSelection,
  ModelCapabilitySettings,
  ReasoningEffort
} from "../../shared/settings.js";
import type { LogLevel } from "../platform/logger.js";
import type { ProviderBilling } from "../../shared/api/pricing.js";

import type { LlmApi } from "../../shared/llm-api.js";
export type JsonObject = Record<string, unknown>;
export type { ModelInputType } from "../../shared/settings.js";

export type ModelCapabilityConfig = ModelCapabilitySettings;

export interface ProviderConfig {
  type: string;
  baseURL: string;
  organizationId?: string;
  apiKey: string;
  serviceTier?: string;
  billing?: ProviderBilling;
  models: ModelCapabilityConfig[];
}

export interface ResolvedProviderConfig {
  providerName: string;
  provider: string;
  providerType: string;
  model: string;
  modelRef: string;
  reasoningEffort: ReasoningEffort;
  supportsReasoning?: boolean;
  /** A custom provider's model on a non-default API. */
  protocol?: "chat" | "messages";
  /** The API the model speaks (absent only for an unresolved selection). */
  api?: LlmApi;
  /** A decision model (see ModelCapabilitySettings.kind). */
  kind?: "decision";
  baseURL: string;
  organizationId: string;
  apiKey: string;
  serviceTier: string;
}

export interface MemoryConfig {
  embedding: {
    model: string;
  };
  dream: {
    enabled: boolean;
  };
}

export interface RetentionConfig {
  /** How long a thread must be silent before its tool results are shortened. */
  chatRetentionDays: number;
  /** agent_messages ceiling. Over it, age is ignored and the oldest threads are
   *  shortened first. */
  chatMaxTableBytes: number;
  /** Head kept when a result is shortened.
   *
   *  This is lossy for the model, not just for the transcript, and the number was
   *  chosen knowing that. Every wake replays the stored string up to
   *  MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS (wake-message-adapter.ts, 30,000), and
   *  read_feature_thread and read_thread read up to 4,000 (the rest saved to a
   *  file) while chat_history_read allows up to 4,000, so on a thread nobody has touched in 90 days an agent looking back at
   *  its own old tool output sees 2,000 characters where it used to see up to
   *  30,000. Many rows sit in that 2,001-30,000 band. The trade was taken for the
   *  space: a short head reclaims far more than a long one, and 20,000 -- the
   *  value that would cost the model nothing -- reclaims little.
   *
   *  Outputs above 30,000 characters are the exception and lose nothing that
   *  matters: the spool has already replaced their body with a file path, and that path lives
   *  in the opening bytes, so it survives inside the head and the agent can still
   *  fetch the whole thing. */
  chatToolResultHeadChars: number;
}

/** The routes a model chain can be set for; each is the default's unless it
 *  has its own, except two: unset, a subagent runs on the route of the agent
 *  that started it, and a page subagent (page updates) as subagents do. */
export type AgentRoute = "manager" | "worker" | "global" | "dream" | "extraction" | "subagent" | "page";

export interface Config {
  port: number;
  host: string;
  /** Refuse a write or a WebSocket handshake that a page of another site sent
   *  (app/http-app.ts). On unless the config file or MANDATE_CHECK_ORIGIN turns
   *  it off. */
  checkOrigin: boolean;
  pollIntervalMs: number;
  captureLines: number;
  logging: {
    level: LogLevel;
  };
  models: {
    default: {
      model: string;
      reasoningEffort: ReasoningEffort;
      modelFallbacks: AgentModelSelection[];
    };
    providers: Record<string, ProviderConfig>;
    /** Price data refreshes daily unless turned off. */
    prices: { autoUpdate: boolean };
  };
  agent: {
    preferences: string;
    managerModel: AgentModelSelection;
    managerModelFallbacks: AgentModelSelection[];
    managerFallbacks: ResolvedProviderConfig[];
    workerModel: AgentModelSelection;
    workerModelFallbacks: AgentModelSelection[];
    workerFallbacks: ResolvedProviderConfig[];
    /** Your agent's route; unset, the default's. */
    globalModel: AgentModelSelection;
    globalModelFallbacks: AgentModelSelection[];
    globalFallbacks: ResolvedProviderConfig[];
    /** The dream's route; unset, the default's. */
    dreamModel: AgentModelSelection;
    dreamModelFallbacks: AgentModelSelection[];
    dreamFallbacks: ResolvedProviderConfig[];
    /** Memory extraction's route; unset, the default's. */
    extractionModel: AgentModelSelection;
    extractionModelFallbacks: AgentModelSelection[];
    extractionFallbacks: ResolvedProviderConfig[];
    /** The subagents' route. Resolved as the others are (the default's
     *  chain while the file sets none: where switching it on starts), but run
     *  only while `subagentRouteSet`; unset, a subagent runs on the route of the
     *  agent that started it. */
    subagentModel: AgentModelSelection;
    subagentModelFallbacks: AgentModelSelection[];
    subagentFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets the subagent route (subagentModel or
     *  subagentModelFallbacks), read from the file alone: a route saved as the
     *  default's own chain is set all the same. */
    subagentRouteSet: boolean;
    /** The page updates' route: Your agent's page subagents. Resolved as the
     *  others are, but run only while `pageRouteSet`; unset, a page subagent
     *  runs as the other subagents do. */
    pageModel: AgentModelSelection;
    pageModelFallbacks: AgentModelSelection[];
    pageFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets the page updates' route, read from the file alone. */
    pageRouteSet: boolean;
    /** Decisions: the models Mandate asks for quick judgements (chat and
     *  decision models mixed). Unset, an empty chain — never the default's —
     *  and no use runs on it while `decisionsEnabled` is false. */
    decisionsEnabled: boolean;
    decisionsModel: AgentModelSelection;
    decisionsModelFallbacks: AgentModelSelection[];
    decisionsFallbacks: ResolvedProviderConfig[];
    /** Manager request check's own route: while set it runs on it, else on Decisions
     *  while Decisions is on (see managerRequestCheckChain). Unset, an empty chain. */
    managerRequestCheckModel: AgentModelSelection;
    managerRequestCheckModelFallbacks: AgentModelSelection[];
    managerRequestCheckFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets Manager request check's own route, read from the file alone. */
    managerRequestCheckRouteSet: boolean;
    /** Whether manager request check runs: on unless the file switches it off. */
    managerRequestCheckEnabled: boolean;
    /** Manager stop check's own route, as Manager request check's (see managerStopCheckChain). */
    managerStopCheckModel: AgentModelSelection;
    managerStopCheckModelFallbacks: AgentModelSelection[];
    managerStopCheckFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets Manager stop check's own route, read from the file alone. */
    managerStopCheckRouteSet: boolean;
    /** Whether manager stop check runs: off until the file switches it on. */
    managerStopCheckEnabled: boolean;
    /** Memory repeat check's own route, as Manager request check's (see memoryRepeatCheckChain). */
    memoryRepeatCheckModel: AgentModelSelection;
    memoryRepeatCheckModelFallbacks: AgentModelSelection[];
    memoryRepeatCheckFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets Memory repeat check's own route, read from the file alone. */
    memoryRepeatCheckRouteSet: boolean;
    /** Whether memory repeat check runs: off until the file switches it on. */
    memoryRepeatCheckEnabled: boolean;
    /** Whether Claude wake steps write their messages for five minutes and a
     *  quiet thread is sealed for an hour (cache seal): on unless the file
     *  says false. The file alone sets it; Settings keeps it. */
    cacheSealEnabled: boolean;
    manager: ResolvedProviderConfig;
    worker: ResolvedProviderConfig;
    global: ResolvedProviderConfig;
    dream: ResolvedProviderConfig;
    extraction: ResolvedProviderConfig;
    subagent: ResolvedProviderConfig;
    page: ResolvedProviderConfig;
    decisions: ResolvedProviderConfig;
    managerRequestCheck: ResolvedProviderConfig;
    managerStopCheck: ResolvedProviderConfig;
    memoryRepeatCheck: ResolvedProviderConfig;
    compressionThresholdTokens: number;
    /** Idle compaction: on unless the file says false; how
     *  many minutes before a thread's cache expires (1–59, default 5); the
     *  smallest context it compacts (at least 1,000, default 200,000). */
    idleCompactionEnabled: boolean;
    idleCompactionLeadMinutes: number;
    idleCompactionMinTokens: number;
    logRequests: string;
    /** The global agent's name; "" until the user names it. */
    globalAgentName: string;
  };
  memory: MemoryConfig;
  retention: RetentionConfig;
  /** Web search: the backend chosen ("off" or a kind's id) and each kind's
   *  own values, kept apart so a kind's setup stays while another is
   *  chosen. A kind this build lacks is kept as the file has it. */
  webSearch: {
    use: string;
    kinds: Record<string, Record<string, string>>;
  };
  voice: {
    provider: string;
    providerName: string;
    providerType: string;
    apiKey: string;
    model: string;
    voice: string;
    language: string;
    idleTimeoutMs: number;
    maxSessionMs: number;
    contextMessageCount: number;
    baseURL: string;
    deployment: string;
  };
}
