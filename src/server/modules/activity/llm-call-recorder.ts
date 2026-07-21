// Wraps MandateStore's llm_calls write API for the agent's two LLM users:
// the wake step (one row per `streamText` call) and compression
// (one row per `generateText` summarization call). Mirrors the analyzer's
// pattern so rows show up in the same Activity feed.

import type { MandateStore } from "../../app/store.js";
import {
  type LogRequestsMode,
  extractUsage, outputForLog, responseForLog, errorForLog, sanitizeForLlmLog
} from "./llm-call-logging.js";

interface AgentLlmCallRecorderConfig {
  store: MandateStore | null;
  logRequests: LogRequestsMode;
  provider: string;
  providerName?: string;
  model: string;
  baseURL: string;
  apiMode: string;
}

interface StartCallInput {
  purpose: string;
  scopeType: string;
  scopeId: string;
  parentCallId?: string;
  requestPayload?: unknown;
  metadata?: Record<string, unknown>;
}

interface FinishCallInput {
  status: "succeeded" | "failed";
  result?: unknown;
  /** Streaming pathway: pass usage directly when no `result.totalUsage` exists. */
  usage?: unknown;
  metadata?: Record<string, unknown>;
  latencyMs?: number;
  /** Elapsed to the provider's first output part, or null when it never sent
   *  one. Only the streaming pathway can know it. */
  ttftMs?: number | null;
  error?: unknown;
}

export class AgentLlmCallRecorder {
  constructor(private cfg: AgentLlmCallRecorderConfig) {}

  startCall(input: StartCallInput): string | null {
    if (!this.cfg.store || this.cfg.logRequests === "off") return null;
    const r = this.cfg.store.startLlmCall({
      purpose: input.purpose,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      parentCallId: input.parentCallId ?? "",
      provider: this.cfg.provider,
      model: this.cfg.model,
      baseURL: this.cfg.baseURL,
      apiMode: this.cfg.apiMode,
      requestJson: this.cfg.logRequests === "full" && input.requestPayload !== undefined
        ? sanitizeForLlmLog(input.requestPayload) : null,
      metadataJson: this.metadataForLog(input.metadata)
    });
    return r?.id ?? null;
  }

  finishCall(id: string | null, input: FinishCallInput): void {
    if (!id || !this.cfg.store || this.cfg.logRequests === "off") return;
    const result = isRecord(input.result) ? input.result : {};
    const usage = extractUsage(input.usage ?? result.totalUsage ?? result.usage);
    this.cfg.store.finishLlmCall(id, {
      status: input.status,
      responseJson: this.cfg.logRequests === "full" ? sanitizeForLlmLog(responseForLog(input.result)) : null,
      outputJson: this.cfg.logRequests === "full" ? sanitizeForLlmLog(outputForLog(input.result)) : null,
      usageJson: usage.raw ? sanitizeForLlmLog(usage.raw) : null,
      metadataJson: input.metadata ? this.metadataForLog(input.metadata) : undefined,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      errorJson: input.error ? sanitizeForLlmLog(errorForLog(input.error)) : null,
      latencyMs: input.latencyMs,
      ttftMs: input.ttftMs
    });
  }

  private metadataForLog(metadata?: Record<string, unknown>): unknown {
    const providerName = this.cfg.providerName?.trim();
    if (!metadata && !providerName) return null;
    return sanitizeForLlmLog({
      ...metadata,
      ...(providerName ? { providerName } : {})
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
