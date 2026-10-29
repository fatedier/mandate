// Wraps MandateStore's llm_calls write API for the agent's two LLM users:
// the wake step (one row per `streamText` call) and compression
// (one row per `generateText` summarization call). Mirrors the analyzer's
// pattern so rows show up in the same Activity feed.

import type { LlmApi } from "../../../shared/llm-api.js";
import type { MandateStore } from "../../app/store.js";
import {
  type LogRequestsMode,
  extractUsage, outputForLog, responseForLog, errorForLog, sanitizeForLlmLog
} from "./llm-call-logging.js";
import { isRecord } from "../../../shared/guards.js";
import { CallFactsCollector, resolveCallFacts, type CallFactCandidates } from "../pricing/call-facts.js";
import { logError } from "../../platform/logger.js";

interface AgentLlmCallRecorderConfig {
  store: MandateStore | null;
  logRequests: LogRequestsMode;
  provider: string;
  providerName?: string;
  /** The API the model speaks; kept in the call's metadata for Activity. */
  api?: LlmApi;
  /** The connection's type when the model runs as another family (a Kilo
   *  model on Messages runs as anthropic): who reported a cost is read by it. */
  providerType?: string;
  model: string;
  baseURL: string;
  apiMode: string;
}

interface StartCallInput {
  purpose: string;
  scopeType: string;
  scopeId: string;
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

/**
 * The llm_calls row of each model call, for reading later (Activity). A row
 * the database refuses (an outside writer holding it past the busy timeout)
 * is logged and skipped, never thrown: thrown, it failed the call itself — a
 * reply that had come back was dropped and tried again as a model failure.
 * A row left running is closed by the startup sweep.
 */
export class AgentLlmCallRecorder {
  constructor(private cfg: AgentLlmCallRecorderConfig) {}

  startCall(input: StartCallInput): string | null {
    try {
      return this.writeStart(input);
    } catch (err) {
      logError(`llm call (${input.purpose}) could not be recorded`, err);
      return null;
    }
  }

  finishCall(id: string | null, input: FinishCallInput): void {
    try {
      this.writeFinish(id, input);
    } catch (err) {
      logError(`llm call ${id} could not be recorded`, err);
    }
  }

  /** Lays `patch` over a finished call's metadata (nested objects merge, a
   *  null removes a key): what is learned of a call after its answer. */
  mergeMetadata(id: string | null, patch: Record<string, unknown>): void {
    try {
      if (!id || !this.cfg.store || this.cfg.logRequests === "off") return;
      this.cfg.store.mergeLlmCallMetadata(id, sanitizeForLlmLog(patch));
    } catch (err) {
      logError(`llm call ${id} could not be recorded`, err);
    }
  }

  private writeStart(input: StartCallInput): string | null {
    if (!this.cfg.store || this.cfg.logRequests === "off") return null;
    const r = this.cfg.store.startLlmCall({
      purpose: input.purpose,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      provider: this.cfg.provider,
      model: this.cfg.model,
      baseURL: this.cfg.baseURL,
      apiMode: this.cfg.apiMode,
      providerName: this.cfg.providerName,
      requestJson: this.cfg.logRequests === "full" && input.requestPayload !== undefined
        ? sanitizeForLlmLog(input.requestPayload) : null,
      metadataJson: this.metadataForLog(input.metadata)
    });
    return r?.id ?? null;
  }

  private writeFinish(id: string | null, input: FinishCallInput): void {
    if (!id || !this.cfg.store || this.cfg.logRequests === "off") return;
    const result = isRecord(input.result) ? input.result : {};
    const error = isRecord(input.error) ? input.error : {};
    // A failed stream carries the usage it had: it may still have been billed.
    const usage = extractUsage(input.usage ?? result.totalUsage ?? result.usage ?? error.usageSoFar);
    const facts = resolveCallFacts(this.factsOf(input.result, error), this.cfg.providerType ?? this.cfg.provider, this.cfg.baseURL);
    this.cfg.store.finishLlmCall(id, {
      status: input.status,
      responseJson: this.cfg.logRequests === "full" ? sanitizeForLlmLog(responseForLog(input.result)) : null,
      outputJson: this.cfg.logRequests === "full" ? sanitizeForLlmLog(outputForLog(input.result)) : null,
      usageJson: usage.raw ? sanitizeForLlmLog(usage.raw) : null,
      metadataJson: input.metadata ? this.metadataForLog(input.metadata) : undefined,
      ...(typeof result.finishReason === "string" ? { finishReason: result.finishReason } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      errorJson: input.error ? sanitizeForLlmLog(errorForLog(input.error)) : null,
      latencyMs: input.latencyMs,
      ttftMs: input.ttftMs,
      reportedCostMicros: facts.reportedMicros,
      reportedCostField: facts.reportedField,
      cacheWrite1hTokens: facts.cacheWrite1hTokens,
      cacheWrite5mTokens: facts.cacheWrite5mTokens,
      serviceTier: facts.serviceTier
    });
  }

  /** A streamed result (or a failed stream's error) brings its facts; a
   *  whole result is read for them here. */
  private factsOf(result: unknown, error: Record<string, unknown>): CallFactCandidates {
    if (isRecord(result) && isRecord(result.facts)) return result.facts as CallFactCandidates;
    if (isRecord(error.facts)) return error.facts as CallFactCandidates;
    const collector = new CallFactsCollector();
    collector.noteResult(result);
    return collector.candidates();
  }

  private metadataForLog(metadata?: Record<string, unknown>): unknown {
    const providerName = this.cfg.providerName?.trim();
    const api = this.cfg.api;
    if (!metadata && !providerName && !api) return null;
    return sanitizeForLlmLog({
      ...metadata,
      ...(providerName ? { providerName } : {}),
      ...(api ? { api } : {})
    });
  }
}
