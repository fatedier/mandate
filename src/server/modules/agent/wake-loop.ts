import { createHash } from "node:crypto";
import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type TimeoutConfiguration,
  type ToolSet
} from "ai";
import type {
  AgentMessage, AgentScope, AgentStore, AgentWakeReason,
  AssistantContent
} from "./agent-store.js";
import type { AgentWakeMetadata } from "../../../shared/api-contracts.js";
import type {
  AiSdkAssistantMessage,
  FeatureEventContent,
  ModelInputType
} from "../../../shared/agent-message-types.js";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { JSONObject, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { WakeLock } from "./wake-lock.js";
import { collectStream, isVisibleOutputStreamPart } from "./stream-collector.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import type { AgentScope as AgentToolScope } from "./tool-scope.js";
import type { ToolContext } from "./tool-registry.js";
import { createStreamIdleTimeoutGuard } from "../llm/stream-timeout.js";
import {
  providerOptionsWithReasoningForAiSdk,
  reasoningForAiSdk
} from "../llm/reasoning.js";
import { AGENT_WAKE_STEP_LLM_TIMEOUT, LLM_STREAM_IDLE_TIMEOUT_MS } from "../llm/timeouts.js";
import {
  errorMessage,
  isNonFallbackLlmError,
  isRetryableLlmError,
  isTimeoutLlmError,
  maxAttemptsForLlmCandidateCount,
  retryDelayMs
} from "../llm/retry-policy.js";
import { latestUiLocationFromMessages, renderUiLocationPrompt } from "../ui-context/ui-context-registry.js";
import { positiveNumberOrNull, prepareAiSdkMessages } from "./wake-message-adapter.js";
import { toUserFacingError } from "../../platform/errors.js";
import { logError } from "../../platform/logger.js";

export interface ToolCallSpec {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

interface ToolDispatchResult {
  result?: unknown;
  isError?: boolean;
  error?: string;
}

export interface ToolDispatcher {
  registry: { tools: ToolSet };
  dispatch(call: ToolCallSpec, ctx: ToolContext): Promise<ToolDispatchResult>;
}

interface SseEmitter {
  emit(event: string, data: unknown): void;
  /** Optional so a test double may omit it; the real emitter coalesces deltas
   *  and needs the end of the stream announced. */
  flushMessageDelta?(threadId: string, wakeId: string): void;
}

interface WakeSchedulerDeps {
  agentStore: AgentStore;
  /** Resolves after the server's initial terminal-state refresh. */
  ready?: Promise<void>;
  lock: WakeLock;
  maxStepsPerWake: number | (() => number);
  buildSystemPrompt: (threadId: string) => string | Promise<string>;
  buildInitialContext?: (threadId: string) => string | null | Promise<string | null>;
  buildRuntimeContext?: (threadId: string) => string | null | Promise<string | null>;
  toolDispatcherForThread: (threadId: string) => ToolDispatcher;
  llmModel: LanguageModel;
  llmForThread?: (threadId: string) => {
    model: LanguageModel;
    llmCallRecorder?: AgentLlmCallRecorder;
    candidates?: WakeLlmCandidate[];
  };
  supportsInputForThread?: (threadId: string, input: ModelInputType) => boolean;
  supportsToolResultImagesForThread?: (threadId: string) => boolean;
  contextBudgetTokens?: number | (() => number);
  /** Total/chunk timeout passed to the AI SDK streamText call. Defaults to the agent wake timeout. */
  llmTimeout?: TimeoutConfiguration<ToolSet> | (() => TimeoutConfiguration<ToolSet>);
  /** Mandate-level idle timeout for stream activity. Any non-terminal stream
   *  event refreshes it; the total LLM timeout remains the hard cap. */
  streamIdleTimeoutMs?: number | (() => number);
  sse: SseEmitter;
  /** Called after the wake lock is acquired and before the first LLM step.
   *  Used for scope-specific wake setup such as mailbox draining. */
  preWakeHook?: (threadId: string, info: PreWakeInfo) => void | Promise<void>;
  /** Called before every LLM step. Used for pending inter-agent mailbox
   *  input that arrives while the wake is already running. */
  preStepHook?: (threadId: string, info: PreStepInfo) => void | Promise<void>;
  /** Called after queued input/runtime context are appended but before each
   *  LLM request is built. Used for context compression gates. If it changes
   *  prompt history, return historyChanged so runtime context can be rebuilt. */
  beforeModelCallHook?: (
    threadId: string,
    info: BeforeModelCallInfo
  ) => void | BeforeModelCallResult | Promise<void | BeforeModelCallResult>;
  /** Called fire-and-forget after the wake completes (success / error / limit). */
  postWakeHook?: (threadId: string, info: PostWakeInfo) => void | Promise<void>;
  /** Called after the in-memory wake lock is released. Used to flush queued user messages. */
  afterWakeReleasedHook?: (threadId: string) => void | Promise<void>;
  /** Build an AgentScope object passed to tool handlers via `ctx.scope`. */
  buildToolScope: (threadId: string) => AgentToolScope;
  uiContext?: {
    getLocationForThread: (threadId: string) => ReturnType<typeof latestUiLocationFromMessages>;
  };
  /** Optional hook called after a wake finishes (success / error / limit). Used by dispatch-handoff-bridge in B2. */
  wakeFinishedHook?: (event: WakeFinishedEvent) => void | Promise<void>;
  /** Optional recorder for the llm_calls table. When omitted (or its
   *  logRequests is "off"), no Activity rows are written for wakes. */
  llmCallRecorder?: AgentLlmCallRecorder;
}

export interface WakeLlmCandidate {
  model: LanguageModel;
  llmCallRecorder?: AgentLlmCallRecorder;
  supportsImageInput?: boolean;
  supportsToolResultImages?: boolean;
  meta?: {
    provider?: string;
    model?: string;
    baseURL?: string;
    reasoningEffort?: ReasoningEffort;
    supportsReasoning?: boolean;
  };
}

type WakeStreamArgs = {
  tools?: ToolSet;
  system?: string | SystemModelMessage | SystemModelMessage[];
  messages: ModelMessage[];
  providerOptions?: SharedV4ProviderOptions;
  abortSignal?: AbortSignal;
};

type WakeLlmResult = Awaited<ReturnType<typeof collectStream>> & {
  sdkAssistantMessages?: AiSdkAssistantMessage[];
};

export interface PostWakeInfo {
  wakeId: string;
  reason: AgentWakeReason;
  status: "finished" | "limit_reached" | "error" | "canceled";
  triggerMessageId: string | null;
  stepCount: number;
  /** Input tokens from the last successful LLM call in this wake, if reported. */
  lastInputTokens: number | null;
  /** Max agent_messages.seq included in the last successful LLM prompt. */
  lastPromptMaxSeq: number | null;
  /** Largest successful LLM input-token count seen during this wake, if reported. */
  maxInputTokens: number | null;
}

export interface PreWakeInfo {
  wakeId: string;
  reason: AgentWakeReason;
  triggerMessageId: string | null;
}

export interface BeforeModelCallInfo {
  wakeId: string;
  reason: AgentWakeReason;
  triggerMessageId: string | null;
  allowTools: boolean;
}

interface BeforeModelCallResult {
  historyChanged?: boolean;
}

interface PreStepInfo {
  wakeId: string;
  allowTools: boolean;
}

interface WakeRuntimeContextState {
  messageAppended: boolean;
}

export interface WakeFinishedEvent {
  threadId: string;
  wakeId: string;
  reason: AgentWakeReason;
  status: "finished" | "limit_reached" | "error" | "canceled";
  triggerMessageId: string | null;
}

class WakeCanceledError extends Error {
  constructor() {
    super("Stopped by user.");
    this.name = "WakeCanceledError";
  }
}

/** Thread scope info folded into wake SSE payloads so clients can map wake
 *  activity onto feature cards without a per-event thread lookup. */
interface WakeScopeInfo {
  scope: AgentScope;
  scopeId: string | null;
}

interface LlmCallFeatureEventMetadata {
  type: "feature_event";
  kind: FeatureEventContent["kind"];
  taskId?: string;
  featureId: string;
  workItemId: string | null;
  source?: FeatureEventContent["source"];
  label: string;
  signal?: "blocked" | "needs_user";
  stepCount?: number;
}

export class WakeScheduler {
  private readonly running = new Map<string, {
    threadId: string;
    controller: AbortController;
    reason: AgentWakeReason;
    triggerMessageId: string | null;
  }>();
  private readonly runtimeContextByWake = new Map<string, WakeRuntimeContextState>();

  constructor(private deps: WakeSchedulerDeps) {}

  /** Synchronously creates the wake row and kicks off the async loop.
   *  Returns the wakeId so callers (e.g. voice agent) can correlate later
   *  wakeFinished events. Returns null if a wake is already in flight for
   *  this thread (lock contention). */
  wake(
    threadId: string,
    reason: AgentWakeReason,
    triggerMessageId: string | null,
    metadata: AgentWakeMetadata | null = null
  ): string | null {
    const thread = this.deps.agentStore.getThreadById(threadId);
    if (!thread || thread.archivedAt || thread.closedAt) return null;
    const release = this.deps.lock.tryAcquire(threadId);
    if (!release) return null;
    const wake = this.deps.agentStore.createWake({ threadId, reason, triggerMessageId, metadata });
    reason = wake.reason;
    triggerMessageId = wake.triggerMessageId;
    metadata = wake.metadata ?? null;
    const controller = new AbortController();
    this.running.set(wake.id, { threadId, controller, reason, triggerMessageId });
    this.runtimeContextByWake.set(wake.id, { messageAppended: false });
    const scopeInfo = this.threadScopeInfo(threadId);
    this.deps.sse.emit(SSE_EVENTS.agentWakeStarted, {
      threadId, wakeId: wake.id, reason, triggerMessageId, metadata, ...(scopeInfo ?? {})
    });
    void this.runWakeBody(
      threadId,
      wake.id,
      release,
      reason,
      triggerMessageId,
      controller.signal,
      scopeInfo,
      metadata
    );
    return wake.id;
  }

  cancelWake(wakeId: string): { ok: boolean; wakeId: string; status: "running" | "canceled" | "finished" | "limit_reached" | "error"; message?: string } {
    const wake = this.deps.agentStore.getWakeById(wakeId);
    if (!wake) return { ok: false, wakeId, status: "error", message: "wake not found" };
    if (wake.status !== "running") {
      return { ok: false, wakeId, status: wake.status, message: `wake is already ${wake.status}` };
    }
    this.deps.agentStore.requestWakeCancellation(wakeId);
    const running = this.running.get(wakeId);
    if (!running) {
      this.deps.agentStore.finishWake(wakeId, "canceled", "Stopped by user.");
      this.deps.sse.emit(SSE_EVENTS.agentWakeFinished, {
        threadId: wake.threadId,
        wakeId,
        status: "canceled",
        errorMessage: "Stopped by user.",
        contextUsage: null,
        ...(this.threadScopeInfo(wake.threadId) ?? {})
      });
      return { ok: true, wakeId, status: "canceled" };
    }
    running.controller.abort(new WakeCanceledError());
    return { ok: true, wakeId, status: "running" };
  }

  /** Returns the running wake row for a thread, or null. Used by dispatchers
   *  and queues to detect in-flight feature/overview wakes. */
  getRunningWakeForThread(threadId: string): { id: string; reason: AgentWakeReason; startedAt: string } | null {
    const r = this.deps.agentStore.getRunningWakeForThread(threadId);
    return r ? { id: r.id, reason: r.reason, startedAt: r.startedAt } : null;
  }

  /** True while the in-memory wake lock is held. This catches active LLM/tool
   *  work even before the wake row is visible to DB readers. */
  isThreadBusy(threadId: string): boolean {
    return this.deps.lock.isHeld(threadId);
  }

  /** Resolved once per wake (not per emit) and threaded through runWakeBody
   *  so every started/finished emission carries the same scope info. The
   *  lookup sits between lock acquisition and the wake body — it must never
   *  throw, or the lock would leak; scope info is display-only, so a failed
   *  read degrades to omitting the optional fields. */
  private threadScopeInfo(threadId: string): WakeScopeInfo | null {
    try {
      const thread = this.deps.agentStore.getThreadById(threadId);
      return thread ? { scope: thread.scope, scopeId: thread.scopeId } : null;
    } catch {
      return null;
    }
  }

  private async runWakeBody(
    threadId: string,
    wakeId: string,
    release: () => void,
    reason: AgentWakeReason,
    triggerMessageId: string | null,
    signal: AbortSignal,
    scopeInfo: WakeScopeInfo | null,
    wakeMetadata: AgentWakeMetadata | null
  ): Promise<void> {
    let lastInputTokens: number | null = null;
    let lastPromptMaxSeq: number | null = null;
    let maxInputTokens: number | null = null;
    try {
      if (this.deps.ready) await this.deps.ready;
      throwIfCanceled(signal);
      const thread = this.deps.agentStore.getThreadById(threadId);
      if (!thread || thread.archivedAt || thread.closedAt) throw new WakeCanceledError();
      if (this.deps.preWakeHook) {
        await this.deps.preWakeHook(threadId, {
          wakeId,
          reason,
          triggerMessageId
        });
      }
      throwIfCanceled(signal);

      let stepCount = 0;
      let done = false;
      const maxStepsPerWake = this.maxStepsPerWake();
      const publishContextUsage = (inputTokens: number, promptMaxSeq: number) => {
        lastInputTokens = inputTokens;
        lastPromptMaxSeq = promptMaxSeq;
        maxInputTokens = maxInputTokens === null
          ? inputTokens
          : Math.max(maxInputTokens, inputTokens);
        this.deps.agentStore.updateWakeTokenUsage(wakeId, lastInputTokens, maxInputTokens);
        const contextUsage = this.contextUsage(lastInputTokens);
        if (contextUsage) {
          this.deps.sse.emit(SSE_EVENTS.agentContextUsageUpdated, {
            threadId,
            wakeId,
            contextUsage
          });
        }
      };
      while (stepCount < maxStepsPerWake) {
        throwIfCanceled(signal);
        const step = await this.runStep(threadId, wakeId, {
          allowTools: true,
          reason,
          triggerMessageId,
          signal,
          wakeMetadata,
          onUsage: publishContextUsage
        });
        throwIfCanceled(signal);
        done = step.done;
        stepCount++;
        this.deps.agentStore.updateWakeStepCount(wakeId, stepCount);
        if (done) break;
      }

      if (!done) {
        // Hit step limit. Give the agent one final reply-only step: tools are
        // disabled and the system prompt tells it to wrap up. Better than the
        // old behavior (silent stop + system message asking the user to type
        // "continue") because the user gets a real summary of where things
        // landed and what's left.
        throwIfCanceled(signal);
        await this.runStep(threadId, wakeId, {
          allowTools: false,
          reason,
          triggerMessageId,
          signal,
          wakeMetadata,
          onUsage: publishContextUsage
        });
        throwIfCanceled(signal);
        stepCount++;
        this.deps.agentStore.updateWakeStepCount(wakeId, stepCount);
        this.deps.agentStore.finishWake(wakeId, "limit_reached");
        this.deps.sse.emit(SSE_EVENTS.agentWakeFinished, {
          threadId, wakeId, status: "limit_reached",
          stepCount,
          contextUsage: this.contextUsage(lastInputTokens),
          errorMessage: `Step budget (${maxStepsPerWake}) exhausted. The agent's final summary is above — send another message to keep going.`,
          ...(scopeInfo ?? {})
        });
      } else {
        this.deps.agentStore.finishWake(wakeId, "finished");
        this.deps.sse.emit(SSE_EVENTS.agentWakeFinished, {
          threadId, wakeId, status: "finished",
          stepCount,
          contextUsage: this.contextUsage(lastInputTokens),
          ...(scopeInfo ?? {})
        });
      }
    } catch (err) {
      if (err instanceof WakeCanceledError || signal.aborted) {
        this.deps.agentStore.finishWake(wakeId, "canceled", "Stopped by user.");
        this.deps.sse.emit(SSE_EVENTS.agentWakeFinished, {
          threadId,
          wakeId,
          status: "canceled",
          contextUsage: this.contextUsage(lastInputTokens),
          errorMessage: "Stopped by user.",
          ...(scopeInfo ?? {})
        });
        return;
      }
      const userError = toUserFacingError(err, "LLM call failed");
      logError(`agent wake ${wakeId}`, wakeErrorLogMessage(userError), "LLM call failed");
      this.deps.agentStore.finishWake(wakeId, "error", userError.message);
      this.deps.sse.emit(SSE_EVENTS.agentWakeFinished, {
        threadId, wakeId, status: "error", errorMessage: userError.message, error: userError,
        contextUsage: this.contextUsage(lastInputTokens),
        ...(scopeInfo ?? {})
      });
    } finally {
      const finalWake = this.deps.agentStore.getWakeById(wakeId);
      const finalStatus = finalWake && finalWake.status !== "running"
        ? finalWake.status as "finished" | "limit_reached" | "error" | "canceled"
        : "error";
      this.running.delete(wakeId);
      this.runtimeContextByWake.delete(wakeId);
      if (this.deps.wakeFinishedHook) {
        if (finalWake) {
          Promise.resolve(this.deps.wakeFinishedHook({
            threadId,
            wakeId,
            reason,
            status: finalStatus,
            triggerMessageId
          })).catch(() => { /* ignore */ });
        }
      }
      let postWakeHookPromise: Promise<void> | null = null;
      if (this.deps.postWakeHook) {
        try {
          // Start post-wake bookkeeping before releasing the wake lock so
          // release-time follow-up checks see any synchronous state changes.
          postWakeHookPromise = Promise.resolve(this.deps.postWakeHook(threadId, {
            wakeId,
            reason,
            status: finalStatus,
            triggerMessageId,
            stepCount: finalWake?.stepCount ?? 0,
            lastInputTokens,
            lastPromptMaxSeq,
            maxInputTokens
          }));
        } catch {
          // Never let a hook failure poison the wake result.
        }
      }
      release();
      if (this.deps.afterWakeReleasedHook) {
        Promise.resolve(this.deps.afterWakeReleasedHook(threadId)).catch(() => { /* ignore */ });
      }
      postWakeHookPromise?.catch(() => { /* ignore */ });
    }
  }

  private async runStep(
    threadId: string,
    wakeId: string,
    opts: {
      allowTools: boolean;
      reason: AgentWakeReason;
      triggerMessageId: string | null;
      signal: AbortSignal;
      wakeMetadata?: AgentWakeMetadata | null;
      onUsage?: (inputTokens: number, promptMaxSeq: number) => void;
    }
  ): Promise<{ done: boolean; inputTokens: number | null; promptMaxSeq: number }> {
    throwIfCanceled(opts.signal);
    if (this.deps.preStepHook) {
      await this.deps.preStepHook(threadId, {
        wakeId,
        allowTools: opts.allowTools
      });
    }
    throwIfCanceled(opts.signal);
    const dispatcher = this.deps.toolDispatcherForThread(threadId);
    const llm = this.deps.llmForThread?.(threadId) ?? {
      model: this.deps.llmModel,
      llmCallRecorder: this.deps.llmCallRecorder
    };
    await this.ensurePromptContextMessages(threadId, wakeId, opts);
    if (this.deps.beforeModelCallHook) {
      const hookResult = await this.deps.beforeModelCallHook(threadId, {
        wakeId,
        reason: opts.reason,
        triggerMessageId: opts.triggerMessageId,
        allowTools: opts.allowTools
      });
      throwIfCanceled(opts.signal);
      if (hookResult?.historyChanged) {
        await this.ensurePromptContextMessages(threadId, wakeId, opts);
      }
    }
    const active = this.deps.agentStore.getActiveMessages(threadId);
    const promptMaxSeq = active.reduce((max, message) => Math.max(max, message.seq), 0);
    // System-role messages are persisted separately as the immutable first
    // instruction. The LLM-facing messages[] stream stays append-only user /
    // assistant / tool history plus context snapshots.
    const includeImages = this.deps.supportsInputForThread?.(threadId, "image") ?? true;
    const includeToolResultImages = this.deps.supportsToolResultImagesForThread?.(threadId) ?? includeImages;
    const messages = prepareAiSdkMessages(active, {
      includeImages,
      includeToolResultImages
    });
    const candidates = filterCandidatesForPromptImages(
      normalizeLlmCandidates(llm, this.deps.llmCallRecorder),
      messages
    );
    if (candidates.length === 0) {
      throw new Error("current agent model candidates do not support image input");
    }

    const systemContent = systemContentForThread(this.deps.agentStore, threadId);
    // Wrap as a SystemModelMessage so we can attach cacheControl to only the
    // immutable system instruction. Runtime state is stored as user-role
    // context messages and is intentionally not part of this cached prefix.
    const system: string | SystemModelMessage = systemContent
      ? {
          role: "system" as const,
          content: systemContent,
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }
        }
      : "";

    const requestPayload = {
      system: systemContent,
      messages,
      allowTools: opts.allowTools,
      toolNames: opts.allowTools ? Object.keys(dispatcher.registry.tools) : []
    };
    const wakeMetadata = opts.wakeMetadata ?? null;
    const featureEvents = wakeMetadata?.featureEvents?.length
      ? wakeMetadata.featureEvents.map(featureEventMetadataForLlmLog)
      : null;
    const callMetadata = {
      wakeId,
      allowTools: opts.allowTools,
      messageCount: messages.length,
      promptMaxSeq,
      ...(featureEvents ? { featureEvents } : {})
    };
    const firstRecorder = candidates[0]?.llmCallRecorder ?? llm.llmCallRecorder;
    const callId = firstRecorder?.startCall({
      purpose: "agent_wake_step",
      scopeType: "agent_thread",
      scopeId: threadId,
      requestPayload,
      metadata: callMetadata
    }) ?? null;

    const collected = await this.runLlmCandidates({
      candidates,
      threadId,
      wakeId,
      requestPayload,
      metadata: callMetadata,
      callId,
      streamArgs: {
        ...(opts.allowTools ? { tools: dispatcher.registry.tools } : {}),
        system,
        messages,
        abortSignal: opts.signal
      },
      signal: opts.signal
    });
    throwIfCanceled(opts.signal);

    // In reply-only mode, drop any tool calls the model emitted — the system
    // prompt said no more tools, but not every provider honors that strictly.
    const toolCallsThisStep = opts.allowTools ? collected.toolCalls : [];

    const assistantContent: AssistantContent = { type: "assistant" };
    const sdkAssistantMessages = opts.allowTools
      ? collected.sdkAssistantMessages
      : stripToolCallPartsFromSdkAssistantMessages(collected.sdkAssistantMessages);
    if (sdkAssistantMessages?.length) assistantContent.sdkAssistantMessages = sdkAssistantMessages;
    if (collected.text) assistantContent.text = collected.text;
    if (toolCallsThisStep.length > 0) assistantContent.toolCalls = toolCallsThisStep;

    const assistantMsg = this.deps.agentStore.appendMessage({
      threadId, role: "assistant", source: "self",
      wakeId, content: assistantContent
    });
    this.deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: assistantMsg });

    const inputTokens = positiveNumberOrNull(collected.usage.promptTokens);
    if (inputTokens !== null) opts.onUsage?.(inputTokens, promptMaxSeq);

    if (toolCallsThisStep.length === 0) {
      return { done: collected.endTurn !== false, inputTokens, promptMaxSeq };
    }

    for (let i = 0; i < toolCallsThisStep.length; i++) {
      const call = toolCallsThisStep[i]!;
      if (opts.signal.aborted) {
        this.appendCanceledToolResults(threadId, wakeId, toolCallsThisStep.slice(i));
        throw new WakeCanceledError();
      }
      const dispatched = await dispatcher.dispatch(call, {
        threadId, wakeId,
        lineageThreadId: this.deps.agentStore.lineageThreadId(threadId),
        scope: this.deps.buildToolScope(threadId)
      });
      const toolMsg = this.deps.agentStore.appendMessage({
        threadId, role: "tool", source: "self", wakeId,
        content: {
          type: "tool_result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          ...(dispatched.isError
            ? { isError: true, error: dispatched.error }
            : { result: dispatched.result })
        }
      });
      this.deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: toolMsg });
      if (opts.signal.aborted) {
        this.appendCanceledToolResults(threadId, wakeId, toolCallsThisStep.slice(i + 1));
        throw new WakeCanceledError();
      }
    }

    return { done: false, inputTokens, promptMaxSeq };
  }

  private async ensurePromptContextMessages(
    threadId: string,
    wakeId: string,
    opts: { allowTools: boolean; signal: AbortSignal }
  ): Promise<void> {
    if (!this.deps.agentStore.getSystemMessage(threadId)) {
      const systemPrompt = await this.deps.buildSystemPrompt(threadId);
      this.deps.agentStore.ensureSystemMessage(threadId, systemPrompt);
    }

    const active = this.deps.agentStore.getActiveMessages(threadId);
    const stateParts: string[] = [];
    const scopeContext = await this.deps.buildRuntimeContext?.(threadId);
    if (scopeContext?.trim()) stateParts.push(scopeContext.trim());

    const uiLocation = this.deps.uiContext?.getLocationForThread(threadId)
      ?? latestUiLocationFromMessages(active)
      ?? null;
    const uiLocationPrompt = renderUiLocationPrompt(uiLocation);
    if (uiLocationPrompt) stateParts.push(uiLocationPrompt);

    if (!opts.allowTools) {
      stateParts.push(
        "## Step budget exhausted\n\n" +
        `You have used your full step budget (${this.maxStepsPerWake()} steps). ` +
        "No more tool calls will be honored. Reply with a final summary describing " +
        "what you accomplished, what is still pending, and what the user should do next."
      );
    }

    const stateBody = renderContextBody(stateParts);
    const stateHash = stateBody ? hashText(contextFingerprint(stateBody)) : "";
    const latest = latestRuntimeContextMessage(active);
    if (!latest) {
      const initialParts: string[] = [];
      const initialContext = await this.deps.buildInitialContext?.(threadId);
      if (initialContext?.trim()) initialParts.push(initialContext.trim());
      if (stateBody) initialParts.push(stateBody);
      const initialBody = renderContextBody(initialParts);
      if (!initialBody) return;
      this.appendContextMessage(threadId, wakeId, "initial", initialBody, stateHash);
      const wakeContext = this.runtimeContextByWake.get(wakeId);
      if (wakeContext) wakeContext.messageAppended = true;
      return;
    }

    if (!stateBody) return;
    if (runtimeStateHash(latest) === stateHash) return;
    const wakeContext = this.runtimeContextByWake.get(wakeId);
    if (opts.allowTools && wakeContext?.messageAppended) return;
    this.appendContextMessage(threadId, wakeId, "update", stateBody, stateHash);
    if (wakeContext) wakeContext.messageAppended = true;
  }

  private appendContextMessage(
    threadId: string,
    wakeId: string,
    kind: "initial" | "update",
    body: string,
    stateHash: string
  ): void {
    const text = kind === "initial"
      ? renderInitialContextMessage(body)
      : renderRuntimeContextMessage(body);
    this.deps.agentStore.appendMessage({
      threadId,
      role: "user",
      source: "runtime-context",
      wakeId,
      content: {
        type: "text",
        text,
        metadata: {
          runtimeContextHash: hashText(text),
          runtimeStateHash: stateHash,
          runtimeContextKind: kind,
          runtimeContextMode: "compact"
        }
      }
    });
  }

  private contextUsage(inputTokens: number | null): {
    inputTokens: number | null;
    budgetTokens: number;
    updatedAt: string;
    source: "compression_budget";
  } | null {
    const budget = positiveNumberOrNull(resolveNumber(this.deps.contextBudgetTokens));
    if (budget === null) return null;
    return {
      inputTokens,
      budgetTokens: budget,
      updatedAt: new Date().toISOString(),
      source: "compression_budget"
    };
  }

  private maxStepsPerWake(): number {
    const value = positiveNumberOrNull(resolveNumber(this.deps.maxStepsPerWake));
    return value === null ? 1 : Math.floor(value);
  }

  private appendCanceledToolResults(threadId: string, wakeId: string, calls: ToolCallSpec[]): void {
    for (const call of calls) {
      const toolMsg = this.deps.agentStore.appendMessage({
        threadId,
        role: "tool",
        source: "self",
        wakeId,
        content: {
          type: "tool_result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          isError: true,
          error: "Stopped by user."
        }
      });
      this.deps.sse.emit(SSE_EVENTS.agentMessageAppended, { threadId, message: toolMsg });
    }
  }

  private async runLlmCandidates(input: {
    candidates: WakeLlmCandidate[];
    threadId: string;
    wakeId: string;
    requestPayload: unknown;
    metadata: Record<string, unknown>;
    callId: string | null;
    streamArgs: WakeStreamArgs;
    signal: AbortSignal;
  }): Promise<WakeLlmResult> {
    let lastError: unknown = null;
    const maxAttemptsPerCandidate = maxAttemptsForLlmCandidateCount(input.candidates.length);
    for (let candidateIndex = 0; candidateIndex < input.candidates.length; candidateIndex++) {
      const candidate = input.candidates[candidateIndex]!;
      const recorder = candidate.llmCallRecorder;
      for (let attempt = 1; attempt <= maxAttemptsPerCandidate; attempt++) {
        const startedAt = Date.now();
        const callMetadata = {
          ...input.metadata,
          ...(candidateIndex === 0 && attempt === 1 ? {} : {
            fallbackAttempt: true,
            candidateIndex,
            attempt,
            provider: candidate.meta?.provider,
            model: candidate.meta?.model,
            reasoningEffort: candidate.meta?.reasoningEffort
          })
        };
        const callId = candidateIndex === 0 && attempt === 1
          ? input.callId
          : recorder?.startCall({
              purpose: "agent_wake_step",
              scopeType: "agent_thread",
              scopeId: input.threadId,
              requestPayload: input.requestPayload,
              metadata: callMetadata
            }) ?? null;
        let emittedText = false;
        const idleTimeoutMs = this.streamIdleTimeoutMs();
        const streamDiagnostics = createLlmStreamDiagnostics({
          startedAt,
          callId,
          wakeId: input.wakeId,
          candidateIndex,
          attempt,
          provider: candidate.meta?.provider,
          model: candidate.meta?.model,
          idleTimeoutMs
        });
        const streamIdleGuard = createStreamIdleTimeoutGuard(
          input.streamArgs.abortSignal,
          idleTimeoutMs
        );
        try {
          const stream = streamText({
            ...input.streamArgs,
            providerOptions: providerOptionsForCandidate(input.streamArgs.providerOptions, candidate, input.threadId),
            abortSignal: streamIdleGuard.signal,
            model: candidate.model,
            reasoning: reasoningForAiSdk(
              candidate.meta?.reasoningEffort,
              candidate.meta?.supportsReasoning
            ),
            maxRetries: 0,
            timeout: this.llmTimeout()
          });
          const collected = await collectStream(stream.fullStream, {
            onPart: (part) => {
              const timeoutActivity = isStreamIdleActivityPart(part);
              streamDiagnostics.recordPart(part, timeoutActivity, isVisibleOutputStreamPart(part));
              if (timeoutActivity) streamIdleGuard.markActivity();
            },
            onTextDelta: (delta, totalText) => {
              emittedText = emittedText || delta.length > 0;
              this.deps.sse.emit(SSE_EVENTS.agentMessageDelta, {
                threadId: input.threadId,
                wakeId: input.wakeId,
                deltaText: delta,
                totalText
              });
            }
          });
          const sdkAssistantMessages = assistantMessagesOnly(await stream.responseMessages);
          const result: WakeLlmResult = sdkAssistantMessages.length
            ? { ...collected, sdkAssistantMessages }
            : collected;
          recorder?.finishCall(callId, {
            status: "succeeded",
            result,
            usage: result.usage,
            metadata: {
              ...callMetadata,
              stream: streamDiagnostics.summary("succeeded")
            },
            ttftMs: streamDiagnostics.ttftMs(),
            latencyMs: Date.now() - startedAt
          });
          return result;
        } catch (err) {
          recorder?.finishCall(callId, {
            status: "failed",
            error: err,
            metadata: {
              ...callMetadata,
              stream: streamDiagnostics.summary("failed")
            },
            ttftMs: streamDiagnostics.ttftMs(),
            latencyMs: Date.now() - startedAt
          });
          if (input.signal.aborted) throw new WakeCanceledError();
          const canFallback = candidateIndex < input.candidates.length - 1
            && !isNonFallbackLlmError(err);
          if (emittedText) {
            if (!canFallback) throw err;
            this.deps.sse.emit(SSE_EVENTS.agentMessageDelta, {
              threadId: input.threadId,
              wakeId: input.wakeId,
              deltaText: "",
              totalText: ""
            });
            lastError = err;
            break;
          }
          lastError = err;

          const retryable = isRetryableLlmError(err) && !isTimeoutLlmError(err);
          if (attempt < maxAttemptsPerCandidate && retryable) {
            await sleep(retryDelayMs(attempt), input.signal);
            continue;
          }

          if (canFallback) break;
          throw err;
        } finally {
          // Every exit from an attempt passes here — success, retry, fallback,
          // throw, cancel — and each one ends this stream. A delta still
          // coalesced past the end would arrive after the finished message and
          // relight the streaming bubble.
          this.deps.sse.flushMessageDelta?.(input.threadId, input.wakeId);
          streamIdleGuard.cleanup();
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(errorMessage(lastError) || "LLM call failed");
  }

  private llmTimeout(): TimeoutConfiguration<ToolSet> {
    const configured = this.deps.llmTimeout;
    return typeof configured === "function" ? configured() : configured ?? AGENT_WAKE_STEP_LLM_TIMEOUT;
  }

  private streamIdleTimeoutMs(): number {
    const value = positiveNumberOrNull(resolveNumber(this.deps.streamIdleTimeoutMs));
    return value === null ? LLM_STREAM_IDLE_TIMEOUT_MS : Math.floor(value);
  }

}

function systemContentForThread(agentStore: AgentStore, threadId: string): string {
  const message = agentStore.getSystemMessage(threadId);
  if (!message || message.content.type !== "text") return "";
  return message.content.text;
}

function latestRuntimeContextMessage(messages: AgentMessage[]): AgentMessage | null {
  return [...messages].reverse().find((message) =>
    message.role === "user"
    && message.source === "runtime-context"
    && message.content.type === "text"
  ) ?? null;
}

function runtimeStateHash(message: AgentMessage): unknown {
  if (message.content.type !== "text") return null;
  return message.content.metadata?.runtimeStateHash
    ?? message.content.metadata?.runtimeContextHash
    ?? null;
}

function renderContextBody(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

function renderInitialContextMessage(body: string): string {
  const text = body.trim();
  if (!text) return "";
  return [
    "[initial_context]",
    "Baseline capabilities and compact starting context for this prompt window. Later runtime_context entries are append-only compact digests; use tools for authoritative current state. Capability manifests remain valid until a newer initial_context appears.",
    "",
    text
  ].join("\n");
}

function renderRuntimeContextMessage(body: string): string {
  const text = body.trim();
  if (!text) return "";
  return [
    "[runtime_context]",
    "Compact routing digest, not a conversation event and not authoritative state. This message is append-only; use tools for exact current state.",
    "",
    text
  ].join("\n");
}

type LlmStreamStatus = "succeeded" | "failed";
const LLM_STREAM_TRACE_BUFFER_LIMIT = 200;

export interface LlmStreamDiagnosticsInput {
  startedAt: number;
  callId: string | null;
  wakeId: string;
  candidateIndex: number;
  attempt: number;
  provider?: string;
  model?: string;
  idleTimeoutMs: number;
}

interface LlmStreamDiagnostics {
  recordPart: (part: { type: string }, timeoutActivity: boolean, visibleOutput: boolean) => void;
  summary: (status: LlmStreamStatus) => Record<string, unknown>;
  /** Time to first token, or null for a call the provider never answered.
   *  Also inside `summary()`, but that object is reduced away by retention
   *  while this rides in a column of its own. */
  ttftMs: () => number | null;
}

/** Exported for its own tests. The distinction it draws — the SDK's local
 *  `start` against the provider's first output — is the whole of what time to
 *  first token means, and it is not observable from outside the wake loop. */
export function createLlmStreamDiagnostics(input: LlmStreamDiagnosticsInput): LlmStreamDiagnostics {
  let partCount = 0;
  let modelDataPartCount = 0;
  let timeoutActivityPartCount = 0;
  let visibleOutputPartCount = 0;
  let textDeltaCount = 0;
  let toolCallCount = 0;
  let firstPartAtMs: number | null = null;
  // The first part carrying model output, which is not the first part: the SDK
  // emits `start` and `start-step` locally the moment the request goes out, so
  // `firstPartAtMs` measures our own dispatch — 14.9ms on average against an
  // 11-second mean latency — and says nothing about the provider.
  let firstModelDataAtMs: number | null = null;
  let lastPartAtMs: number | null = null;
  let lastTimeoutActivityAtMs: number | null = null;
  let lastVisibleOutputAtMs: number | null = null;
  let lastPartType = "";
  const partTypes: Record<string, number> = {};
  const trace = llmStreamTraceEnabled();
  const traceEvents: Record<string, unknown>[] = [];
  let droppedTraceEvents = 0;

  return {
    ttftMs: () => firstModelDataAtMs,
    recordPart(part, timeoutActivity, visibleOutput) {
      const elapsedMs = Math.max(0, Date.now() - input.startedAt);
      partCount++;
      if (firstPartAtMs === null) firstPartAtMs = elapsedMs;
      lastPartAtMs = elapsedMs;
      lastPartType = part.type;
      partTypes[part.type] = (partTypes[part.type] ?? 0) + 1;
      if (!isLifecycleStreamPartType(part.type)) {
        modelDataPartCount++;
        if (firstModelDataAtMs === null) firstModelDataAtMs = elapsedMs;
      }
      if (timeoutActivity) {
        timeoutActivityPartCount++;
        lastTimeoutActivityAtMs = elapsedMs;
      }
      if (visibleOutput) {
        visibleOutputPartCount++;
        lastVisibleOutputAtMs = elapsedMs;
        if (part.type === "text-delta") textDeltaCount++;
        if (part.type === "tool-call") toolCallCount++;
      }
      if (trace) {
        bufferLlmStreamTrace(traceEvents, {
          event: "part",
          callId: input.callId,
          wakeId: input.wakeId,
          candidateIndex: input.candidateIndex,
          attempt: input.attempt,
          provider: input.provider,
          model: input.model,
          partType: part.type,
          elapsedMs,
          sinceLastTimeoutActivityMs: lastTimeoutActivityAtMs === null
            ? null
            : Math.max(0, elapsedMs - lastTimeoutActivityAtMs),
          sinceLastVisibleOutputMs: lastVisibleOutputAtMs === null
            ? null
            : Math.max(0, elapsedMs - lastVisibleOutputAtMs),
          timeoutActivity,
          partCount,
          modelDataPartCount,
          timeoutActivityPartCount,
          visibleOutputPartCount
        }, () => { droppedTraceEvents++; });
      }
    },
    summary(status) {
      const elapsedMs = Math.max(0, Date.now() - input.startedAt);
      const output = {
        status,
        partCount,
        modelDataPartCount,
        timeoutActivityPartCount,
        visibleOutputPartCount,
        textDeltaCount,
        toolCallCount,
        firstPartAtMs,
        firstModelDataAtMs,
        lastPartAtMs,
        lastTimeoutActivityAtMs,
        lastVisibleOutputAtMs,
        lastPartType: lastPartType || null,
        partTypes,
        elapsedMs,
        idleTimeoutMs: input.idleTimeoutMs
      };
      if (trace && status === "failed") {
        for (const event of traceEvents) logLlmStreamTrace(event);
        if (droppedTraceEvents > 0) {
          logLlmStreamTrace({
            event: "trace-truncated",
            callId: input.callId,
            wakeId: input.wakeId,
            candidateIndex: input.candidateIndex,
            attempt: input.attempt,
            provider: input.provider,
            model: input.model,
            retainedPartEvents: traceEvents.length,
            droppedPartEvents: droppedTraceEvents
          });
        }
        logLlmStreamTrace({
          event: "finish",
          callId: input.callId,
          wakeId: input.wakeId,
          candidateIndex: input.candidateIndex,
          attempt: input.attempt,
          provider: input.provider,
          model: input.model,
          ...output
        });
      }
      return output;
    }
  };
}

function bufferLlmStreamTrace(
  events: Record<string, unknown>[],
  event: Record<string, unknown>,
  onDrop: () => void
): void {
  if (events.length < LLM_STREAM_TRACE_BUFFER_LIMIT) {
    events.push(event);
    return;
  }
  onDrop();
}

function llmStreamTraceEnabled(): boolean {
  const value = (process.env.MANDATE_LLM_STREAM_TRACE ?? "").trim().toLowerCase();
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return true;
}

function logLlmStreamTrace(event: Record<string, unknown>): void {
  console.error(`[mandate] llm-stream: ${JSON.stringify(event)}`);
}

function isStreamIdleActivityPart(part: { type: string }): boolean {
  switch (part.type) {
    case "abort":
    case "error":
    case "finish":
      return false;
    default:
      return true;
  }
}

function isLifecycleStreamPartType(type: string): boolean {
  switch (type) {
    case "start":
    case "start-step":
    case "finish":
    case "abort":
    case "error":
      return true;
    default:
      return false;
  }
}

function featureEventMetadataForLlmLog(event: FeatureEventContent): LlmCallFeatureEventMetadata {
  const metadata: LlmCallFeatureEventMetadata = {
    type: "feature_event",
    kind: event.kind,
    featureId: event.featureId,
    workItemId: event.workItemId,
    ...(event.source ? { source: event.source } : {}),
    label: event.label
  };
  if ("taskId" in event) metadata.taskId = event.taskId;
  if (event.kind === "escalation" && event.signal) metadata.signal = event.signal;
  if (event.kind === "limit_reached") metadata.stepCount = event.stepCount;
  return metadata;
}

function contextFingerprint(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeLlmCandidates(
  llm: { model: LanguageModel; llmCallRecorder?: AgentLlmCallRecorder; candidates?: WakeLlmCandidate[] },
  fallbackRecorder?: AgentLlmCallRecorder
): WakeLlmCandidate[] {
  const candidates = llm.candidates?.length
    ? llm.candidates
    : [{ model: llm.model, llmCallRecorder: llm.llmCallRecorder ?? fallbackRecorder }];
  return candidates.length ? candidates : [{ model: llm.model, llmCallRecorder: llm.llmCallRecorder ?? fallbackRecorder }];
}

function providerOptionsForCandidate(
  existing: SharedV4ProviderOptions | undefined,
  candidate: WakeLlmCandidate,
  threadId: string
): SharedV4ProviderOptions | undefined {
  const withReasoning = providerOptionsWithReasoningForAiSdk(
    existing,
    candidate.meta?.provider,
    candidate.meta?.reasoningEffort,
    candidate.meta?.supportsReasoning
  );
  if (!shouldPreserveOpenAiReasoningState(candidate)) return withReasoning;
  const openai: JSONObject = withReasoning?.openai ?? {};
  return {
    ...withReasoning,
    openai: {
      ...openai,
      store: openai.store ?? false,
      promptCacheKey: openai.promptCacheKey ?? threadId
    }
  };
}

function shouldPreserveOpenAiReasoningState(candidate: WakeLlmCandidate): boolean {
  const provider = candidate.meta?.provider;
  if (provider === "openai" || provider === "openai-compatible" || provider === "codex") return true;
  // LanguageModel can be a bare model-id string with no provider field.
  if (typeof candidate.model === "string") return false;
  const modelProvider = candidate.model.provider.toLowerCase();
  return modelProvider === "openai.responses" || modelProvider === "codex.responses";
}

function assistantMessagesOnly(messages: readonly unknown[]): AiSdkAssistantMessage[] {
  return messages.filter((message): message is AiSdkAssistantMessage =>
    isRecord(message) && message.role === "assistant"
  );
}

function stripToolCallPartsFromSdkAssistantMessages(
  messages: AiSdkAssistantMessage[] | undefined
): AiSdkAssistantMessage[] | undefined {
  if (!messages?.length) return undefined;
  const stripped = messages
    .map(stripToolCallPartsFromSdkAssistantMessage)
    .filter((message): message is AiSdkAssistantMessage => message !== null);
  return stripped.length ? stripped : undefined;
}

function stripToolCallPartsFromSdkAssistantMessage(message: AiSdkAssistantMessage): AiSdkAssistantMessage | null {
  const content = message.content;
  if (!Array.isArray(content)) return message;
  const stripped = content.filter((part) => !isSdkToolCallPart(part));
  if (stripped.length === 0) return null;
  return stripped.length === content.length ? message : { ...message, content: stripped };
}

function isSdkToolCallPart(part: unknown): boolean {
  return isRecord(part) && (
    part.type === "tool-call" ||
    part.type === "tool-result" ||
    part.type === "tool-approval-request"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function filterCandidatesForPromptImages(
  candidates: WakeLlmCandidate[],
  messages: ModelMessage[]
): WakeLlmCandidate[] {
  if (!promptContainsImageInput(messages)) return candidates;
  const hasToolResultImage = promptContainsToolResultImageInput(messages);
  return candidates.filter((candidate) =>
    candidate.supportsImageInput !== false &&
    (!hasToolResultImage || candidate.supportsToolResultImages !== false)
  );
}

function promptContainsImageInput(messages: ModelMessage[]): boolean {
  return messages.some((message) => valueContainsImageInput((message as Record<string, unknown>).content));
}

function promptContainsToolResultImageInput(messages: ModelMessage[]): boolean {
  return messages.some((message) => valueContainsToolResultImageInput((message as Record<string, unknown>).content));
}

function valueContainsImageInput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(valueContainsImageInput);
  const record = value as Record<string, unknown>;
  if (
    record.type === "image" ||
    record.type === "image-data" ||
    record.type === "image-url" ||
    record.type === "image-file-id"
  ) {
    return true;
  }
  if (record.type === "content" && valueContainsImageInput(record.value)) return true;
  if (record.type === "tool-result" && valueContainsImageInput(record.output)) return true;
  if (record.type === "file" && isImageMediaType(record.mediaType)) return true;
  if (record.type === "media" && typeof record.mediaType === "string" && record.mediaType.startsWith("image/")) {
    return true;
  }
  return false;
}

function valueContainsToolResultImageInput(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(valueContainsToolResultImageInput);
  const record = value as Record<string, unknown>;
  if (record.type === "tool-result") return valueContainsImageInput(record.output);
  return false;
}

function isImageMediaType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const mediaType = value.trim().toLowerCase();
  return mediaType === "image" || mediaType.startsWith("image/");
}

function wakeErrorLogMessage(error: ReturnType<typeof toUserFacingError>): string {
  const parts = [
    error.message,
    error.category ? `category=${error.category}` : "",
    error.code ? `code=${error.code}` : "",
    error.detail && error.detail !== error.message ? `detail=${error.detail}` : ""
  ].filter(Boolean);
  return parts.join(" ");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new WakeCanceledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new WakeCanceledError());
    }, { once: true });
  });
}

function resolveNumber(value: number | (() => number) | undefined): number | undefined {
  return typeof value === "function" ? value() : value;
}

function throwIfCanceled(signal: AbortSignal): void {
  if (signal.aborted) throw new WakeCanceledError();
}
