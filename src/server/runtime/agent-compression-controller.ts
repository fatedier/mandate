import type { LanguageModel, ModelMessage } from "ai";
import type { MandateStore } from "../app/store.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { AgentMessage, AgentStore } from "../modules/agent/agent-store.js";
import type { BeforeModelCallInfo } from "../modules/agent/wake-loop.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import {
  EmptyCompressionSummaryError,
  estimateMessagesTokens,
  getCompressionGateDecision,
  normalizeCompressionSummaryText,
  runCompression
} from "../modules/agent/compression.js";
import { prepareAiSdkMessages } from "../modules/agent/wake-message-adapter.js";
import type { Config } from "../config.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";
import type { ReasoningEffort } from "../../shared/settings.js";
import type { MemoryManager } from "../modules/memory/manager.js";
import { extractSummaryMemories } from "../modules/memory/extraction.js";
import { newId } from "../platform/ids.js";
import { renderPromptFile } from "../platform/prompts/prompt-template.js";
import { runAgentCompressionLlm } from "./agent-compression-llm.js";
import { llmAttemptMetadata, runLlmCandidates } from "../modules/llm/run-candidates.js";
import { buildCompressionMemorySource } from "./agent-memory-hooks.js";
import compressionPromptPath from "../modules/agent/prompts/agent-compression-system.md" with { type: "file" };

interface MemoryExtractionHandle {
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder: AgentLlmCallRecorder;
}

interface CompressionHandle {
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder: AgentLlmCallRecorder;
  candidates?: CompressionCandidate[];
}

interface CompressionCandidate {
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder: AgentLlmCallRecorder;
}

interface AgentCompressionControllerDeps {
  config: Config;
  getConfig?: () => Config;
  store: MandateStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  compressionForThread: (threadId: string) => CompressionHandle;
  buildSystemPrompt: (threadId: string) => string | Promise<string>;
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  memoryManager: MemoryManager;
  memoryExtractionForThread: (threadId: string) => MemoryExtractionHandle;
  /** Pane read cursors to drop when a thread is compressed. */
  cursors: { resetThread(threadId: string): void };
}

export interface AgentCompressionController {
  readonly contextBudgetTokens: number;
  summarizeSideConversation(threadId: string): Promise<string>;
  beforeModelCallHook(
    threadId: string,
    info: BeforeModelCallInfo
  ): Promise<{ historyChanged: boolean }>;
}

export function createAgentCompressionController(
  deps: AgentCompressionControllerDeps
): AgentCompressionController {
  const {
    config,
    getConfig,
    store,
    projectsStore,
    featuresStore,
    agentStore,
    sse,
    compressionForThread,
    buildSystemPrompt,
    supportsInputForThread,
    memoryManager,
    memoryExtractionForThread,
    cursors
  } = deps;
  const inFlightCompressionByThread = new Map<string, Promise<unknown>>();

  const systemContentForThread = async (threadId: string): Promise<string> => {
    // Compression is a context-reset boundary and already invalidates the
    // prompt cache, so rebuild from the current template here: a compressed
    // thread continues with today's policy instead of the prompt it was born
    // with (long-lived threads otherwise freeze on it forever).
    const generated = await buildSystemPrompt(threadId);
    if (generated.trim()) {
      const stored = agentStore.ensureSystemMessage(threadId, generated);
      if (stored?.content.type === "text") return stored.content.text;
      return generated;
    }
    const existing = agentStore.getSystemMessage(threadId);
    if (existing?.content.type === "text") return existing.content.text;
    return generated;
  };

  const summarize = async (
    messages: AgentMessage[],
    threadId: string,
    compressionMetadata: Record<string, unknown> = {}
  ) => {
    const systemContent = await systemContentForThread(threadId);
    const compactPrompt = renderPromptFile(compressionPromptPath);
    const llmMessages = buildLocalCompressionMessages(messages, {
      compactPrompt,
      includeImages: supportsInputForThread?.(threadId, "image") ?? true
    });
    const compression = compressionForThread(threadId);
    const candidates = normalizeCompressionCandidates(compression);
    const requestPayload = { system: systemContent, messages: llmMessages };
    const baseMetadata = { messageCount: messages.length, ...compressionMetadata };

    return runLlmCandidates({
      candidates,
      // The shared policy reads an empty summary as a non-retryable failure;
      // the runner still caps this at one retry per model.
      onFailure: (failure) => (failure.error instanceof EmptyCompressionSummaryError ? "retry" : undefined),
      attempt: async (candidate, at) => {
        const startedAt = Date.now();
        const callId = candidate.recorder.startCall({
          purpose: "agent_compression",
          scopeType: "agent_thread",
          scopeId: threadId,
          requestPayload,
          metadata: {
            ...baseMetadata,
            ...llmAttemptMetadata(at, { provider: candidate.provider })
          }
        });
        try {
          const result = await runAgentCompressionLlm({
            model: candidate.model,
            provider: candidate.provider,
            reasoningEffort: candidate.reasoningEffort,
            supportsReasoning: candidate.supportsReasoning,
            system: systemContent,
            messages: llmMessages
          });
          const summaryText = normalizeCompressionSummaryText(result.text);
          candidate.recorder.finishCall(callId, {
            status: "succeeded",
            result,
            latencyMs: Date.now() - startedAt
          });
          return { summaryText };
        } catch (err) {
          candidate.recorder.finishCall(callId, {
            status: "failed",
            error: err,
            latencyMs: Date.now() - startedAt
          });
          throw err;
        }
      }
    });
  };

  const currentConfig = () => getConfig?.() ?? config;

  const compressionConfig = () => {
    const cfg = currentConfig();
    return {
      thresholdTokens: cfg.agent.compressionThresholdTokens
    };
  };

  const runThreadCompressionNow = async (
    threadId: string,
    runConfig: ReturnType<typeof compressionConfig>,
    metadata: Record<string, unknown>
  ) => {
    const compressionId = newId("cmp");
    const active = agentStore.getActiveMessages(threadId);
    sse.emit(SSE_EVENTS.agentCompressionStarted, {
      threadId,
      compressionId,
      startedAt: new Date().toISOString(),
      activeMessageCount: active.length,
      thresholdTokens: runConfig.thresholdTokens,
      ...metadata
    });

    try {
      const result = await runCompression({
        agentStore,
        summarizer: (messages, threadId) => summarize(messages, threadId, metadata),
        cursors,
        // Retaining more user text than the threshold allows would leave the
        // window over threshold and compress again on the next wake step.
        thresholdTokens: runConfig.thresholdTokens
      }, threadId);
      if (!result) {
        sse.emit(SSE_EVENTS.agentCompressionFinished, {
          threadId,
          compressionId,
          status: "finished",
          summaryMessageId: null,
          replacedCount: 0,
          replacedRange: null,
          finishedAt: new Date().toISOString()
        });
        return null;
      }
      sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: result.summaryMessage });
      const source = buildCompressionMemorySource(threadId, result.summaryMessage, {
        agentStore,
        projectsStore,
        featuresStore
      });
      sse.emit(SSE_EVENTS.agentCompressionFinished, {
        threadId,
        compressionId,
        status: "finished",
        summaryMessageId: result.summaryMessage.id,
        replacedCount: result.replacedCount,
        replacedRange: result.replacedRange,
        contextUsage: {
          inputTokens: estimateMessagesTokens(agentStore.getActiveMessages(threadId)),
          budgetTokens: runConfig.thresholdTokens,
          updatedAt: result.summaryMessage.createdAt,
          source: "compression_budget"
        },
        finishedAt: new Date().toISOString()
      });
      if (source) {
        void extractCompressionSummaryMemories(threadId, source).catch(() => {
          // extractCompressionSummaryMemories already logs the normalized error.
        });
      }
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      sse.emit(SSE_EVENTS.agentCompressionFailed, {
        threadId,
        compressionId,
        status: "error",
        errorMessage,
        finishedAt: new Date().toISOString()
      });
      throw err;
    }
  };

  const runThreadCompression = async (
    threadId: string,
    runConfig: ReturnType<typeof compressionConfig>,
    metadata: Record<string, unknown>
  ) => {
    const existing = inFlightCompressionByThread.get(threadId);
    if (existing) {
      await existing;
      return null;
    }

    const running = runThreadCompressionNow(threadId, runConfig, metadata);
    inFlightCompressionByThread.set(threadId, running);
    try {
      return await running;
    } finally {
      if (inFlightCompressionByThread.get(threadId) === running) {
        inFlightCompressionByThread.delete(threadId);
      }
    }
  };

  const extractCompressionSummaryMemories = async (
    threadId: string,
    source: NonNullable<ReturnType<typeof buildCompressionMemorySource>>
  ) => {
    try {
      const extraction = memoryExtractionForThread(threadId);
      await extractSummaryMemories({
        memory: memoryManager,
        source,
        model: extraction.model,
        provider: extraction.provider,
        reasoningEffort: extraction.reasoningEffort,
        recorder: extraction.recorder
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mandate] memory summary extraction failed: ${msg}`);
    }
  };

  return {
    get contextBudgetTokens() {
      return currentConfig().agent.compressionThresholdTokens;
    },

    async summarizeSideConversation(threadId: string) {
      const thread = agentStore.getThreadById(threadId);
      if (!thread || thread.kind !== "side") throw new Error("side conversation not found");
      const messages = agentStore.getMessages(threadId).filter(
        (message) => message.role !== "system" && message.source !== "runtime-context"
      );
      if (messages.length === 0) return "";
      const result = await summarize(messages, threadId, { reason: "side_summary_draft" });
      return result.summaryText;
    },

    async beforeModelCallHook(threadId, info) {
      const active = agentStore.getActiveMessages(threadId);
      const baseConfig = compressionConfig();
      const tokenSignal = latestWakeTokenSignalForThread(store, threadId);
      const decision = getCompressionGateDecision(active, baseConfig, tokenSignal);
      if (!decision.shouldCompress) return { historyChanged: false };

      const result = await runThreadCompression(threadId, baseConfig, {
        reason: "before_model_call",
        wakeId: info.wakeId,
        triggerMessageId: info.triggerMessageId,
        allowTools: info.allowTools,
        tokenEstimateStrategy: decision.strategy,
        triggerTokens: decision.triggerTokens,
        thresholdTokens: decision.thresholdTokens,
        estimatedActiveTokens: decision.estimatedActiveTokens,
        previousInputTokens: decision.previousInputTokens,
        previousPromptMaxSeq: decision.previousPromptMaxSeq,
        newMessageTokens: decision.newMessageTokens,
        projectedTokens: decision.projectedTokens
      });
      return { historyChanged: Boolean(result) };
    }
  };
}

export function buildLocalCompressionMessages(
  messages: AgentMessage[],
  opts: { compactPrompt: string; includeImages: boolean }
): ModelMessage[] {
  const history = prepareAiSdkMessages(messages, {
    includeImages: opts.includeImages,
    includeToolResultImages: false,
    includeProviderState: false
  });
  return [
    ...history,
    { role: "user", content: opts.compactPrompt }
  ];
}

function normalizeCompressionCandidates(compression: CompressionHandle): CompressionCandidate[] {
  if (compression.candidates?.length) return compression.candidates;
  return [{
    model: compression.model,
    provider: compression.provider,
    reasoningEffort: compression.reasoningEffort,
    supportsReasoning: compression.supportsReasoning,
    recorder: compression.recorder
  }];
}

function latestWakeTokenSignalForThread(store: MandateStore, threadId: string) {
  const row = store.db.prepare(`
    select input_tokens as inputTokens, metadata_json as metadataJson
    from llm_calls
    where purpose = 'agent_wake_step'
      and scope_type = 'agent_thread'
      and scope_id = ?
      and status = 'succeeded'
      and input_tokens is not null
    order by coalesce(finished_at, updated_at, created_at) desc, created_at desc
    limit 1
  `).get(threadId) as { inputTokens: number | null; metadataJson: string | null } | undefined;
  if (!row) return {};

  const metadata = parseJsonRecord(row.metadataJson);
  return {
    previousInputTokens: row.inputTokens,
    previousPromptMaxSeq: metadata ? positiveNumberOrNull(metadata.promptMaxSeq) : null
  };
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
