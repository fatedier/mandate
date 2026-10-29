import type { LanguageModel, ModelMessage } from "ai";
import type { IdleCompactOptions, IdleCompactOutcome } from "../modules/agent/idle-compaction/types.js";
import { logError } from "../platform/logger.js";
import type { MandateStore } from "../app/store.js";
import type { AgentMessage, AgentStore } from "../modules/agent/agent-store.js";
import type { BeforeModelCallInfo, StepPrompt } from "../modules/agent/wake-loop.js";
import type { AgentSseEmitter } from "../modules/sse/sse-events.js";
import type { AgentLlmCallRecorder } from "../modules/activity/llm-call-recorder.js";
import {
  EmptyCompressionSummaryError,
  getCompressionGateDecision,
  hasSomethingToCompact,
  type ManualCompactionOutcome,
  normalizeCompressionSummaryText,
  runCompression
} from "../modules/agent/compression.js";
import { needsReasoningPlaceholder } from "../modules/llm/open-responses-model.js";
import { prepareAiSdkMessages } from "../modules/agent/wake-message-adapter.js";
import type { Config } from "../config.js";
import { SSE_EVENTS } from "../../shared/api-contracts.js";
import type { ModelInputType } from "../../shared/agent-message-types.js";
import type { ReasoningEffort } from "../../shared/settings.js";
import { newId } from "../platform/ids.js";
import { renderPromptFile } from "../platform/prompts/prompt-template.js";
import { runAgentCompressionLlm, runAgentCompressionOnStepPrompt } from "./agent-compression-llm.js";
import type { TextModelCallResult } from "../modules/llm/text-model.js";
import { llmAttemptMetadata, runLlmCandidates } from "../modules/llm/run-candidates.js";
import { parseJsonRecord } from "../platform/json.js";
import compressionPromptPath from "../modules/agent/prompts/agent-compression-system.md" with { type: "file" };
import { errorText } from "../../shared/error-text.js";
import { positiveNumberOrNull } from "../../shared/positive-number.js";
import { localTimeZone } from "../platform/time/agent-time.js";
import { modelImages } from "../modules/agent/model-images.js";

interface CompressionHandle {
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  /** Required, even when undefined: absent means reasoning on, so a dropped
   *  forward would silently turn a model's "off" back on. */
  supportsReasoning: boolean | undefined;
  recorder: AgentLlmCallRecorder;
  candidates?: CompressionCandidate[];
}

interface CompressionCandidate {
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  /** Required, even when undefined: absent means reasoning on, so a dropped
   *  forward would silently turn a model's "off" back on. */
  supportsReasoning: boolean | undefined;
  recorder: AgentLlmCallRecorder;
}

interface AgentCompressionControllerDeps {
  config: Config;
  getConfig?: () => Config;
  store: MandateStore;
  agentStore: AgentStore;
  sse: AgentSseEmitter;
  compressionForThread: (threadId: string) => CompressionHandle;
  buildSystemPrompt: (threadId: string) => string | Promise<string>;
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  /** Memories from the messages a compression hid: each leaves the model's
   *  context once, so each is read once. */
  extractWindow: (threadId: string, trigger: "compression", messages: AgentMessage[]) => void;
  /** Pane read cursors to drop when a thread is compressed. */
  cursors: { resetThread(threadId: string): void };
  /** Takes a thread's wake lock, as a turn does: null when it is held. The
   *  function returned lets it go and starts what queued behind. A compaction
   *  started by hand runs under it. Absent (tests that never compact by
   *  hand): every thread is found busy. */
  holdThread?: (threadId: string) => (() => void) | null;
  /** The prompt the thread's next step would send, which a compaction is
   *  sent on to read the step's prompt cache. Absent, or throwing (no
   *  candidate can take it): the compaction is sent on its own. */
  stepPromptForThread?: (threadId: string) => StepPrompt | Promise<StepPrompt>;
  /** The cache seal: a compaction is a call of the thread (it drops a seal
   *  waiting on it) and rewrites it (its next step is not judged). */
  cacheSeal?: { noteCallStarted(threadId: string): void; noteCompacted(threadId: string): void };
  /** The zone a compaction sent on its own writes the history's times in,
   *  as the thread's steps do. Unset: the machine's. */
  timeZone?: string;
}

interface AgentCompressionController {
  readonly contextBudgetTokens: number;
  beforeModelCallHook(
    threadId: string,
    info: BeforeModelCallInfo
  ): Promise<{ historyChanged: boolean }>;
  /** Starts the compaction the gate would run, by hand. Returns at once; the
   *  run reports through the compaction events. The thread is held for its
   *  duration (see holdThread). */
  compactNow(threadId: string): ManualCompactionOutcome;
  /** Whether a compaction by hand or an idle one has the thread now. */
  isCompacting(threadId: string): boolean;
  /** Starts an idle compaction: under the thread's
   *  lock, over the minimum only, on the candidate whose cache is warm only
   *  (no other candidate, no compaction route), its summary tagged. Returns
   *  at once; a failure is logged and goes out as the failed event. */
  compactIdle(threadId: string, opts: IdleCompactOptions): IdleCompactOutcome;
}

/** An idle compaction's limits, carried to its summarizer and its summary. */
interface IdleRun {
  only: IdleCompactOptions["only"];
  summaryTag: { trigger: "idle"; idleMinutes: number };
}

export function createAgentCompressionController(
  deps: AgentCompressionControllerDeps
): AgentCompressionController {
  const {
    config,
    getConfig,
    store,
    agentStore,
    sse,
    compressionForThread,
    buildSystemPrompt,
    supportsInputForThread,
    extractWindow,
    cursors,
    holdThread,
    stepPromptForThread,
    cacheSeal
  } = deps;
  const inFlightCompressionByThread = new Map<string, Promise<unknown>>();
  /** Threads a compaction started by hand has now. */
  const compacting = new Set<string>();

  /** The system prompt the thread's steps are sent with; a thread that has
   *  none yet gets one built. */
  const systemContentForThread = async (threadId: string): Promise<string> => {
    const existing = agentStore.getSystemMessage(threadId);
    if (existing?.content.type === "text") return existing.content.text;
    return await buildSystemPrompt(threadId);
  };

  /** Compression is a context-reset boundary, so the thread goes on with
   *  the system prompt built from today's template instead of the one it was
   *  born with (a long-lived thread otherwise keeps that forever). Done once
   *  the summary is in: it is asked with the prompt the steps were sent. */
  const refreshSystemPrompt = async (threadId: string): Promise<void> => {
    const generated = await buildSystemPrompt(threadId);
    if (generated.trim()) agentStore.ensureSystemMessage(threadId, generated);
  };

  const stepPromptOf = async (threadId: string): Promise<StepPrompt | null> => {
    if (!stepPromptForThread) return null;
    try {
      return await stepPromptForThread(threadId);
    } catch {
      // No candidate takes the step's prompt (its images): the compaction
      // goes on its own, which leaves out what a model cannot take.
      return null;
    }
  };

  /** One attempt, filed in Activity as a compaction. */
  const recordedAttempt = async (
    recorder: AgentLlmCallRecorder,
    threadId: string,
    requestPayload: unknown,
    metadata: Record<string, unknown>,
    call: () => Promise<TextModelCallResult>
  ) => {
    const startedAt = Date.now();
    const callId = recorder.startCall({
      purpose: "agent_compression",
      scopeType: "agent_thread",
      scopeId: threadId,
      requestPayload,
      metadata
    });
    try {
      const result = await call();
      const summaryText = normalizeCompressionSummaryText(result.text);
      recorder.finishCall(callId, {
        status: "succeeded",
        result,
        latencyMs: Date.now() - startedAt
      });
      return { summaryText };
    } catch (err) {
      recorder.finishCall(callId, {
        status: "failed",
        error: err,
        latencyMs: Date.now() - startedAt
      });
      throw err;
    }
  };

  // The shared policy reads an empty summary as a non-retryable failure; the
  // runner still caps this at one retry per model.
  const retryEmptySummary = (failure: { error: unknown }) =>
    (failure.error instanceof EmptyCompressionSummaryError ? "retry" as const : undefined);

  /** The compaction sent as the thread's next step: the same candidates,
   *  tools, system prompt and history, the compaction prompt after it. */
  const summarizeOnStepPrompt = (
    prompt: StepPrompt,
    threadId: string,
    compactPrompt: string,
    baseMetadata: Record<string, unknown>
  ) => {
    const ask: ModelMessage = { role: "user", content: compactPrompt };
    return runLlmCandidates({
      candidates: prompt.candidates,
      onFailure: retryEmptySummary,
      attempt: (candidate, at) => {
        // Each attempt's record is the history it sends.
        const messages = [...prompt.messagesFor(candidate), ask];
        return recordedAttempt(
          candidate.llmCallRecorder ?? compressionForThread(threadId).recorder,
          threadId,
          { system: prompt.systemContent, messages, toolNames: Object.keys(prompt.tools) },
          {
            ...baseMetadata,
            stepPrompt: true,
            ...llmAttemptMetadata(at, { provider: candidate.meta?.provider, model: candidate.meta?.model })
          },
          () => runAgentCompressionOnStepPrompt({ candidate, threadId, prompt, messages })
        );
      }
    });
  };

  /** The compaction on its own: the history without provider state, no
   *  tools, on the compaction route's candidates. */
  const summarizeAlone = async (
    messages: AgentMessage[],
    threadId: string,
    compactPrompt: string,
    baseMetadata: Record<string, unknown>
  ) => {
    const systemContent = await systemContentForThread(threadId);
    // Its images made small enough for a model, as a step's are.
    const fitted = await modelImages.prepare(messages);
    const historyFor = (candidate: CompressionCandidate) => {
      // A model that needs its reasoning back gets a placeholder on the steps
      // other models wrote (open-responses-model.ts).
      const placeholder = needsReasoningPlaceholder(candidate.model, candidate);
      return buildLocalCompressionMessages(messages, {
        compactPrompt,
        includeImages: supportsInputForThread?.(threadId, "image") ?? true,
        imageForModel: (image, messageId) => fitted.forModel(image, messageId),
        // The times the thread's steps read, as they read them.
        timeZone: deps.timeZone ?? localTimeZone(),
        ...(placeholder && typeof candidate.model !== "string" ? { reasoningPlaceholderFor: candidate.model.modelId } : {})
      });
    };
    const candidates = normalizeCompressionCandidates(compressionForThread(threadId));
    return runLlmCandidates({
      candidates,
      onFailure: retryEmptySummary,
      attempt: (candidate, at) => {
        // Each attempt's record is the history it sends.
        const llmMessages = historyFor(candidate);
        return recordedAttempt(
          candidate.recorder,
          threadId,
          { system: systemContent, messages: llmMessages },
          { ...baseMetadata, ...llmAttemptMetadata(at, { provider: candidate.provider }) },
          () => runAgentCompressionLlm({
            model: candidate.model,
            provider: candidate.provider,
            reasoningEffort: candidate.reasoningEffort,
            supportsReasoning: candidate.supportsReasoning,
            system: systemContent,
            messages: llmMessages
          })
        );
      }
    });
  };

  const summarize = async (
    messages: AgentMessage[],
    threadId: string,
    compressionMetadata: Record<string, unknown> = {},
    idle?: IdleRun
  ) => {
    const compactPrompt = renderPromptFile(compressionPromptPath);
    const baseMetadata = { messageCount: messages.length, ...compressionMetadata };
    cacheSeal?.noteCallStarted(threadId);
    const prompt = await stepPromptOf(threadId);
    // An idle compaction reads the warm cache or nothing: the step's prompt on
    // the candidate that kept it, never another one or the route's models.
    if (idle && !prompt) throw new Error("Idle compaction: the thread's step prompt could not be built.");
    const candidates = prompt && idle ? prompt.candidates.filter(idle.only) : prompt?.candidates;
    if (idle && candidates?.length === 0) throw new Error("Idle compaction: the model that kept the cache is not the thread's now.");
    const summary = prompt
      ? await summarizeOnStepPrompt({ ...prompt, candidates: candidates ?? prompt.candidates }, threadId, compactPrompt, baseMetadata)
      : await summarizeAlone(messages, threadId, compactPrompt, baseMetadata);
    await refreshSystemPrompt(threadId);
    return summary;
  };

  const currentConfig = () => getConfig?.() ?? config;

  const compressionConfig = (): { thresholdTokens: number; measuredTokens?: number } => {
    const cfg = currentConfig();
    return {
      thresholdTokens: cfg.agent.compressionThresholdTokens
    };
  };

  const runThreadCompressionNow = async (
    threadId: string,
    runConfig: ReturnType<typeof compressionConfig>,
    metadata: Record<string, unknown>,
    idle?: IdleRun
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
        summarizer: (messages, threadId) => summarize(messages, threadId, metadata, idle),
        ...(idle ? { summaryTag: idle.summaryTag } : {}),
        cursors,
        // Retaining more user text than the threshold allows would leave the
        // window over threshold and compress again on the next wake step.
        thresholdTokens: runConfig.thresholdTokens,
        measuredTokens: runConfig.measuredTokens
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
      cacheSeal?.noteCompacted(threadId);
      sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: result.summaryMessage });
      sse.emit(SSE_EVENTS.agentCompressionFinished, {
        threadId,
        compressionId,
        status: "finished",
        summaryMessageId: result.summaryMessage.id,
        replacedCount: result.replacedCount,
        replacedRange: result.replacedRange,
        // Not measured since: the meter gets no figure until the next call.
        contextUsage: {
          inputTokens: null,
          budgetTokens: runConfig.thresholdTokens,
          updatedAt: result.summaryMessage.createdAt,
          source: "compression_budget"
        },
        finishedAt: new Date().toISOString()
      });
      extractWindow(threadId, "compression", result.hiddenMessages);
      return result;
    } catch (err) {
      const errorMessage = errorText(err);
      sse.emit(SSE_EVENTS.agentCompressionFailed, {
        threadId,
        compressionId,
        status: "error",
        errorMessage,
        ...(typeof metadata.reason === "string" ? { reason: metadata.reason } : {}),
        finishedAt: new Date().toISOString()
      });
      throw err;
    }
  };

  const runThreadCompression = async (
    threadId: string,
    runConfig: ReturnType<typeof compressionConfig>,
    metadata: Record<string, unknown>,
    idle?: IdleRun
  ) => {
    const existing = inFlightCompressionByThread.get(threadId);
    if (existing) {
      await existing;
      return null;
    }

    const running = runThreadCompressionNow(threadId, runConfig, metadata, idle);
    inFlightCompressionByThread.set(threadId, running);
    try {
      return await running;
    } finally {
      if (inFlightCompressionByThread.get(threadId) === running) {
        inFlightCompressionByThread.delete(threadId);
      }
    }
  };

  /** The gate's reading of a window, the size its summary may record, and the
   *  figures every compaction run logs. */
  const readGate = (threadId: string, active: AgentMessage[]) => {
    const baseConfig = compressionConfig();
    const decision = getCompressionGateDecision(active, baseConfig, latestWakeTokenSignalForThread(store, threadId));
    return {
      baseConfig,
      decision,
      // The size the summary records is the gate's figure only where that
      // came from the provider's count: its fallbacks are plain estimates.
      measuredTokens: decision.strategy === "previous_input_plus_new_messages" ? decision.triggerTokens : undefined,
      metadata: {
        tokenEstimateStrategy: decision.strategy,
        triggerTokens: decision.triggerTokens,
        thresholdTokens: decision.thresholdTokens,
        estimatedActiveTokens: decision.estimatedActiveTokens,
        previousInputTokens: decision.previousInputTokens,
        previousPromptMaxSeq: decision.previousPromptMaxSeq,
        newMessageTokens: decision.newMessageTokens,
        projectedTokens: decision.projectedTokens
      }
    };
  };

  return {
    get contextBudgetTokens() {
      return currentConfig().agent.compressionThresholdTokens;
    },

    async beforeModelCallHook(threadId, info) {
      const gate = readGate(threadId, agentStore.getActiveMessages(threadId));
      if (!gate.decision.shouldCompress) return { historyChanged: false };

      const result = await runThreadCompression(threadId, { ...gate.baseConfig, measuredTokens: gate.measuredTokens }, {
        reason: "before_model_call",
        wakeId: info.wakeId,
        triggerMessageId: info.triggerMessageId,
        ...gate.metadata
      });
      return { historyChanged: Boolean(result) };
    },

    compactNow(threadId) {
      if (compacting.has(threadId)) return "compacting";
      // Taking the lock is the "is a turn running" check, with no gap between
      // the check and the start.
      const release = holdThread?.(threadId) ?? null;
      if (!release) return "running";
      let gate: ReturnType<typeof readGate>;
      try {
        const active = agentStore.getActiveMessages(threadId);
        gate = readGate(threadId, active);
        if (!hasSomethingToCompact(active, gate.baseConfig.thresholdTokens)) {
          release();
          return "nothing";
        }
      } catch (err) {
        // A read that fails must not leave the thread held: with no wake
        // there would be nothing to stop, and it would stay busy until a
        // restart.
        release();
        throw err;
      }
      compacting.add(threadId);
      // Nothing awaits this: a failure has gone out as an event.
      void runThreadCompression(threadId, { ...gate.baseConfig, measuredTokens: gate.measuredTokens }, {
        reason: "manual",
        ...gate.metadata
      }).catch(() => {}).finally(() => {
        compacting.delete(threadId);
        release();
      });
      return "started";
    },

    isCompacting(threadId) {
      return compacting.has(threadId);
    },

    compactIdle(threadId, opts) {
      // Taking the lock is the "is a turn running" check, as compactNow's.
      const release = holdThread?.(threadId) ?? null;
      if (!release) return "busy";
      let gate: ReturnType<typeof readGate>;
      try {
        const active = agentStore.getActiveMessages(threadId);
        gate = readGate(threadId, active);
        if (gate.decision.triggerTokens < opts.minTokens) {
          release();
          return "small";
        }
        if (!hasSomethingToCompact(active, gate.baseConfig.thresholdTokens)) {
          release();
          return "nothing";
        }
      } catch (err) {
        release();
        throw err;
      }
      // A compaction like one by hand for the page, /compact and /stop.
      compacting.add(threadId);
      void runThreadCompression(threadId, { ...gate.baseConfig, measuredTokens: gate.measuredTokens }, {
        reason: "idle",
        idleMinutes: opts.idleMinutes,
        ...gate.metadata
      }, { only: opts.only, summaryTag: { trigger: "idle", idleMinutes: opts.idleMinutes } })
        .catch((err) => logError("idle compaction", err, `thread ${threadId}`))
        .finally(() => {
          compacting.delete(threadId);
          release();
        });
      return "started";
    }
  };
}

export function buildLocalCompressionMessages(
  messages: AgentMessage[],
  opts: {
    compactPrompt: string;
    includeImages: boolean;
    timeZone?: string;
    reasoningPlaceholderFor?: string;
    imageForModel?: (image: { id: string; data: string; mediaType: string }, messageId: string) => { data: string; mediaType: string } | null;
  }
): ModelMessage[] {
  const history = prepareAiSdkMessages(messages, {
    includeImages: opts.includeImages,
    ...(opts.imageForModel ? { imageForModel: opts.imageForModel } : {}),
    includeToolResultImages: false,
    includeProviderState: false,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.reasoningPlaceholderFor !== undefined ? { reasoningPlaceholderFor: opts.reasoningPlaceholderFor } : {})
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

/** The provider's count of the thread's last prompt: its newest wake step's,
 *  a subagent's steps being wake steps under their own purpose. */
function latestWakeTokenSignalForThread(store: MandateStore, threadId: string) {
  const row = store.db.prepare(`
    select input_tokens as inputTokens, metadata_json as metadataJson
    from llm_calls
    where purpose in ('agent_wake_step', 'subagent_step', 'page_subagent_step')
      and scope_type = 'agent_thread'
      and scope_id = ?
      and status = 'succeeded'
      and input_tokens is not null
    order by coalesce(finished_at, updated_at, created_at) desc, created_at desc
    limit 1
  `).get(threadId) as { inputTokens: number | null; metadataJson: string | null } | undefined;
  if (!row) return {};

  const metadata = parseJsonRecord(row.metadataJson);
  // The context the model read, where the call billed more (a continued Google reply).
  const context = metadata ? positiveNumberOrNull(metadata.contextInputTokens) : null;
  return {
    previousInputTokens: context ?? row.inputTokens,
    previousPromptMaxSeq: metadata ? positiveNumberOrNull(metadata.promptMaxSeq) : null
  };
}
