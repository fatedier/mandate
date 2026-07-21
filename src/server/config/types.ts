import type {
  AgentModelSelection,
  ModelCapabilitySettings,
  ReasoningEffort
} from "../../shared/settings.js";
import type { LogLevel } from "../platform/logger.js";

export type JsonObject = Record<string, unknown>;
export type { ModelInputType } from "../../shared/settings.js";

export type ModelCapabilityConfig = ModelCapabilitySettings;

export interface ProviderConfig {
  type: string;
  baseURL: string;
  organizationId?: string;
  apiKey: string;
  serviceTier?: string;
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
   *  shortened first. Matches the global cap openclaw puts on the same kind of
   *  data. */
  chatMaxTableBytes: number;
  /** Head kept when a result is shortened.
   *
   *  This is lossy for the model, not just for the transcript, and the number was
   *  chosen knowing that. Every wake replays the stored string up to
   *  MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS (wake-message-adapter.ts, 20,000), and
   *  read_feature_thread reads up to 3,000 while chat_history_read allows up to
   *  4,000, so on a thread nobody has touched in 90 days an agent looking back at
   *  its own old tool output sees 2,000 characters where it used to see up to
   *  20,000. 10,963 production rows sit in that 2,001-20,000 band. (An earlier
   *  note here claimed 2,000 matched chat_history_read's default so no reader but
   *  the transcript could tell; that was simply wrong.) The trade was measured
   *  and taken for the space: a
   *  2,000-character head reclaims 67.9 MB, 8,000 reclaims 26.6 MB, and 20,000 --
   *  the value that would cost the model nothing -- reclaims 7.0 MB.
   *
   *  Outputs above 64 KB are the exception and lose nothing that matters: the
   *  spool has already replaced their body with a file path, and that path lives
   *  in the opening bytes, so it survives inside the head and the agent can still
   *  fetch the whole thing. */
  chatToolResultHeadChars: number;
}

export interface Config {
  port: number;
  host: string;
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
  };
  agent: {
    preferences: string;
    managerModel: AgentModelSelection;
    managerModelRef: string;
    managerModelFallbacks: AgentModelSelection[];
    managerModelFallbackRefs: string[];
    managerFallbacks: ResolvedProviderConfig[];
    workerModel: AgentModelSelection;
    workerModelRef: string;
    workerModelFallbacks: AgentModelSelection[];
    workerModelFallbackRefs: string[];
    workerFallbacks: ResolvedProviderConfig[];
    manager: ResolvedProviderConfig;
    worker: ResolvedProviderConfig;
    maxStepsPerWake: number;
    compressionThresholdTokens: number;
    logRequests: string;
  };
  memory: MemoryConfig;
  retention: RetentionConfig;
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
