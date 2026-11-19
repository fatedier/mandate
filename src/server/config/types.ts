import type {
  AgentModelSelection,
  ModelCapabilitySettings,
  ReasoningEffort,
  ServiceTier
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
   *  read_worker_thread and read_thread read up to 4,000 (the rest saved to a
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
export type AgentRoute = "manager" | "worker" | "personal" | "dream" | "extraction" | "subagent" | "page" | "skillReview";

/** One place notifications go: a kind's own values (a secret among them)
 *  under a name the user gave it. A kind this build lacks is kept as the
 *  file has it. */
export interface NotificationChannelConfig {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  /** Off: only the title goes to the channel. */
  includeText: boolean;
  values: Record<string, string>;
}

/** The background jobs' pacing (config/runtime-config.ts). */
export interface RuntimeConfig {
  pricingPassEveryMs: number;
  scheduleTickMs: number;
  scheduleBootStaggerMs: number;
  dreamCheckEveryMs: number;
  priceDataFirstMs: number;
  priceDataEveryMs: number;
  retentionEveryMs: number;
  historyWordsMergeEveryMs: number;
  memoryVectorsWarmMs: number;
  checkpointEveryMs: number;
  activitySlicesCheckEveryMs: number;
  sseHeartbeatMs: number;
}

export interface Config {
  port: number;
  host: string;
  /** Refuse a write or a WebSocket handshake that a page of another site sent
   *  (app/http-app.ts). On unless the config file turns it off. */
  checkOrigin: boolean;
  pollIntervalMs: number;
  captureLines: number;
  runtime: RuntimeConfig;
  logging: {
    level: LogLevel;
    /** An error logged at debug also prints its stack. File only. */
    stacks: boolean;
    /** A failed model stream logs its part-by-part trace. File only. */
    streamTrace: boolean;
  };
  schedules: {
    /** false stops every schedule: no check runs, and none can be made or
     *  run. Read once at start, so an agent that rewrites the file cannot
     *  turn them back on before a restart. File only. */
    enabled: boolean;
  };
  skills: {
    /** More folders of skills, read at start beside the data dir's skills/;
     *  `~/` is the home directory, a relative one is inside the data dir.
     *  File only. */
    extraDirs: string[];
  };
  models: {
    default: {
      model: string;
      reasoningEffort: ReasoningEffort;
      /** The first step's service tier; absent, none. */
      serviceTier?: ServiceTier;
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
    /** Personal agent's route; unset, the default's. */
    personalModel: AgentModelSelection;
    personalModelFallbacks: AgentModelSelection[];
    personalFallbacks: ResolvedProviderConfig[];
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
    /** The page updates' route: Personal agent's page subagents. Resolved as the
     *  others are, but run only while `pageRouteSet`; unset, a page subagent
     *  runs as the other subagents do. */
    pageModel: AgentModelSelection;
    pageModelFallbacks: AgentModelSelection[];
    pageFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets the page updates' route, read from the file alone. */
    pageRouteSet: boolean;
    /** The skill review's route: reviews of finished work an agent asked for.
     *  Unset, it is the Dream's route (or the manager's, when only that is
     *  set): a strong model, never the workers'. */
    skillReviewModel: AgentModelSelection;
    skillReviewModelFallbacks: AgentModelSelection[];
    skillReviewFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets the skill review's route, read from the file alone. */
    skillReviewRouteSet: boolean;
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
    /** Whether the tool-call review runs: off until the user turns it on. */
    toolReviewEnabled: boolean;
    /** The user's own rules for the review, in their words: the review and
     *  the agents read them as the user's. "" when none. */
    toolReviewRules: string;
    /** The review's screen: its own route while set, else Decisions' chain
     *  while Decisions is on (see toolReviewScreenChain). */
    toolReviewScreenModel: AgentModelSelection;
    toolReviewScreenModelFallbacks: AgentModelSelection[];
    toolReviewScreenFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets the screen's own route, read from the file alone. */
    toolReviewScreenRouteSet: boolean;
    /** The review's second look: its own route's chat models while set, else
     *  the chat models in Decisions' chain while Decisions is on. */
    toolReviewSecondLookModel: AgentModelSelection;
    toolReviewSecondLookModelFallbacks: AgentModelSelection[];
    toolReviewSecondLookFallbacks: ResolvedProviderConfig[];
    /** Whether the file sets the second look's own route, read from the file alone. */
    toolReviewSecondLookRouteSet: boolean;
    manager: ResolvedProviderConfig;
    worker: ResolvedProviderConfig;
    personal: ResolvedProviderConfig;
    dream: ResolvedProviderConfig;
    extraction: ResolvedProviderConfig;
    subagent: ResolvedProviderConfig;
    page: ResolvedProviderConfig;
    skillReview: ResolvedProviderConfig;
    decisions: ResolvedProviderConfig;
    managerRequestCheck: ResolvedProviderConfig;
    managerStopCheck: ResolvedProviderConfig;
    memoryRepeatCheck: ResolvedProviderConfig;
    toolReviewScreen: ResolvedProviderConfig;
    toolReviewSecondLook: ResolvedProviderConfig;
    compressionThresholdTokens: number;
    /** Idle compaction: on unless the file says false; how
     *  many minutes before a thread's cache expires (1–59, default 5); the
     *  smallest context it compacts (at least 1,000, default 200,000). */
    idleCompactionEnabled: boolean;
    idleCompactionLeadMinutes: number;
    idleCompactionMinTokens: number;
    logRequests: string;
    /** The personal agent's name; "" until the user names it. */
    personalAgentName: string;
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
  /** Where the personal agent's notices reach the user outside Mandate's window. */
  notifications: {
    /** The address other devices open Mandate at; "" leaves external notices without a link. */
    linkBase: string;
    /** The desktop app shows system notifications only while this is on. */
    desktopApp: boolean;
    /** The Telegram Bot API server: the public one unless the file names a
     *  self-hosted one. The config file's alone. */
    telegramApiBase: string;
    channels: NotificationChannelConfig[];
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
