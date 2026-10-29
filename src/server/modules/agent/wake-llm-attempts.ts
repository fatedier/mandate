import { streamText, type LanguageModel, type ModelMessage, type SystemModelMessage, type TimeoutConfiguration, type ToolSet } from "ai";
import type { JSONObject, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { AiSdkAssistantMessage } from "../../../shared/agent-message-types.js";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { latestReasoningHeading } from "../../../shared/reasoning-heading.js";
import { isRecord } from "../../../shared/guards.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import { isOpenResponsesModel, OPEN_RESPONSES_NAME } from "../llm/open-responses-model.js";
import { isReasoningSummaryRefusal, providerOptionsWithReasoningForAiSdk, reasoningForAiSdk, reasoningOn } from "../llm/reasoning.js";
import { isCyberPolicyLlmError, isInputRejectedLlmError, isNonFallbackLlmError, isRetryableLlmError, isTimeoutLlmError } from "../llm/retry-policy.js";
import { llmAttemptMetadata, runLlmCandidates } from "../llm/run-candidates.js";
import { idleGuardedStreamOptions, isIdleActivityChunk } from "../llm/stream-timeout.js";
import { createLlmStreamDiagnostics } from "./llm-stream-diagnostics.js";
import { forReplay } from "./reasoning-replay.js";
import { collectStream, isVisibleOutputStreamPart } from "./stream-collector.js";
import { WakeCanceledError } from "./wake-canceled-error.js";

/** One wake step's call to the model: the candidates in order, each attempt
 *  streamed (deltas and the reasoning heading to the page), recorded for
 *  Activity, retried or handed to the next candidate by the shared runner, and
 *  the reasoning-summary request dropped for a model whose gateway refuses it.
 *  Holds what it learns about models across steps and wakes. */

export interface WakeLlmCandidate {
  model: LanguageModel;
  llmCallRecorder?: AgentLlmCallRecorder;
  supportsImageInput?: boolean;
  supportsToolResultImages?: boolean;
  meta?: {
    provider?: string;
    /** The provider's configured type: "openai-compatible" for a custom
     *  provider, whatever API family its model runs as. */
    providerType?: string;
    providerName?: string;
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
  /** The candidate that answered, by connection and model: kept with the
   *  reply for its replay. */
  writtenBy?: { provider: string; model: string };
  /** The candidate that answered itself (never stored): told apart from one
   *  of the same model on the same connection at another effort. */
  answeredBy?: WakeLlmCandidate;
};

interface WakeLlmAttemptsDeps {
  sse: {
    emit(event: string, data: unknown): void;
    flushMessageDelta?(threadId: string, wakeId: string): void;
  };
  llmTimeout: () => TimeoutConfiguration<ToolSet>;
  streamIdleTimeoutMs: () => number;
}

export class WakeLlmAttempts {
  /** Models whose gateway refused the reasoning-summary request: not asked again. */
  private readonly summaryRefused = new Set<string>();
  /** Whether the AI SDK put the summary option on the wire for a model under
   *  its current reasoning settings, as the last successful request that asked
   *  for it showed (it drops the option for a model it takes for a
   *  non-reasoning one). */
  private readonly summarySent = new Map<string, boolean>();

  constructor(private readonly deps: WakeLlmAttemptsDeps) {}

  async run(input: {
    candidates: WakeLlmCandidate[];
    threadId: string;
    wakeId: string;
    requestPayload: unknown;
    /** What Activity files each attempt under: the step's purpose. */
    purpose: string;
    metadata: Record<string, unknown>;
    /** What a candidate's own attempt adds to its row (the cache lifetime its
     *  marks asked for): a fallback's row describes the fallback. */
    metadataFor?: (candidate: WakeLlmCandidate) => Record<string, unknown>;
    callId: string | null;
    streamArgs: WakeStreamArgs;
    /** The history a candidate gets, when it is not streamArgs.messages for every one. */
    messagesFor?: (candidate: WakeLlmCandidate) => ModelMessage[];
    signal: AbortSignal;
    /** Each failed attempt's candidate, as it fails: the last one is the one thrown. */
    onAttemptFailed: (candidate: WakeLlmCandidate) => void;
    /** Each attempt's candidate, as its call starts (a retry's too). */
    onAttemptStart?: (candidate: WakeLlmCandidate) => void;
  }): Promise<WakeLlmResult> {
    // Per attempt, read by onFailure: attempts run one at a time, so the flag
    // always describes the attempt that just failed.
    let emittedText = false;
    return runLlmCandidates({
      candidates: input.candidates,
      signal: input.signal,
      wait: (ms) => sleep(ms, input.signal),
      onFailure: (failure) => {
        if (!emittedText) return;
        // The user has already seen part of this reply. Sending the same
        // request to the same model would stream it again; only a different
        // model is worth it, and its bubble has to start from empty. A
        // cyber_policy rejection is the exception: it is not always repeated
        // for the same request, so it keeps its retry (retry-policy), its
        // bubble starting over too.
        const retrySame = failure.decision === "retry" && isCyberPolicyLlmError(failure.error);
        if (!retrySame && !failure.canFallback) return "throw";
        this.deps.sse.emit(SSE_EVENTS.agentMessageDelta, {
          threadId: input.threadId,
          wakeId: input.wakeId,
          deltaText: "",
          totalText: ""
        });
        return retrySame ? "retry" : "fallback";
      },
      attempt: async (candidate, at) => {
        const { candidateIndex, attempt } = at;
        input.onAttemptStart?.(candidate);
        const recorder = candidate.llmCallRecorder;
        const startedAt = Date.now();
        const callMetadata = {
          ...input.metadata,
          ...input.metadataFor?.(candidate),
          ...llmAttemptMetadata(at, {
            provider: candidate.meta?.provider,
            model: candidate.meta?.model,
            reasoningEffort: candidate.meta?.reasoningEffort
          })
        };
        const callId = candidateIndex === 0 && attempt === 1
          ? input.callId
          : recorder?.startCall({
              purpose: input.purpose,
              scopeType: "agent_thread",
              scopeId: input.threadId,
              // The history this candidate is sent, not the first one's.
              requestPayload: input.messagesFor && isRecord(input.requestPayload)
                ? { ...input.requestPayload, messages: input.messagesFor(candidate) }
                : input.requestPayload,
              metadata: callMetadata
            }) ?? null;
        emittedText = false;
        const idleTimeoutMs = this.deps.streamIdleTimeoutMs();
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
        // Cut when quiet, as every model call is. Its raw chunks are kept
        // too, for an error a gateway sends inside an ordinary chunk, which
        // the SDK drops (collectStream).
        const idle = idleGuardedStreamOptions({
          model: candidate.model,
          timeout: this.deps.llmTimeout(),
          idleMs: idleTimeoutMs,
          parentSignal: input.streamArgs.abortSignal
        });
        // Any reasoning heard proves the summary request was taken.
        let reasoningSeen = false;
        const streamOnce = async (askSummary: boolean): Promise<WakeLlmResult> => {
          const stream = streamText({
            ...input.streamArgs,
            messages: input.messagesFor?.(candidate) ?? input.streamArgs.messages,
            ...candidateCallOptions(candidate, input.threadId, { providerOptions: input.streamArgs.providerOptions, askSummary }),
            maxRetries: 0,
            ...idle.options,
            // To see whether the SDK put the summary option on the wire.
            ...(askSummary ? { include: { requestBody: true } } : {})
          });
          // The page hears the heading the reasoning summary has reached, for
          // its working line, each time it changes — not the summary itself.
          let heading: string | null = null;
          const collected = await collectStream(stream.fullStream, {
            onReasoningDelta: (summary) => {
              reasoningSeen = true;
              const next = latestReasoningHeading(summary);
              if (!next || next === heading) return;
              heading = next;
              this.deps.sse.emit(SSE_EVENTS.agentReasoningHeading, { threadId: input.threadId, wakeId: input.wakeId, heading: next });
            },
            onPart: (part) => streamDiagnostics.recordPart(part, isIdleActivityChunk(part), isVisibleOutputStreamPart(part)),
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
          if (askSummary) {
            const sent = summaryInBody((await Promise.resolve(stream.request).catch(() => undefined))?.body);
            if (sent !== null) this.summarySent.set(summarySentKey(candidate), sent);
          }
          // The summary stays server-side (collected.reasoning): what is
          // replayed to the model is as it was before summaries were asked for.
          const sdkAssistantMessages = assistantMessagesOnly(await stream.responseMessages).map(forReplay);
          const writtenBy = candidate.meta?.model
            ? { provider: candidate.meta.providerName ?? candidate.meta.provider ?? "", model: candidate.meta.model }
            : undefined;
          return {
            ...collected,
            ...(sdkAssistantMessages.length ? { sdkAssistantMessages } : {}),
            ...(writtenBy ? { writtenBy } : {}),
            answeredBy: candidate
          };
        };
        try {
          // Only a candidate with reasoning on whose request carries the
          // option (an OpenAI-style Responses model) can have it refused.
          const askSummary = reasoningOn(candidate.meta?.supportsReasoning) &&
            shouldPreserveOpenAiReasoningState(candidate) &&
            !this.summaryRefused.has(summaryKey(candidate));
          let result: WakeLlmResult;
          try {
            result = await streamOnce(askSummary);
          } catch (err) {
            // A gateway may refuse the optional summary request in more shapes
            // than can be read (a 400, a stream error, a response.failed frame
            // whose parameter the SDK drops). So a request that asked for it and
            // failed before any output, with an error the retry policy would
            // not retry, gets the same model at once without it — within this
            // attempt, so its retry and fallback are left as they were. It is
            // not asked again once the error names the summary or the request
            // without it succeeds; another error fails both ways and is thrown.
            if (!askSummary || emittedText || reasoningSeen || input.signal.aborted) throw err;
            const named = isReasoningSummaryRefusal(err);
            // The shared policy's own reading of "would retry": retryable, not a
            // timeout, and not a request it rejects for good (a gateway that
            // stamps "invalid request" 500).
            const transient = isTimeoutLlmError(err) || (isRetryableLlmError(err) && !isNonFallbackLlmError(err));
            // Nor for an error about the input itself (too long, a role or image
            // the model does not take): a request option cannot cause it, and a
            // blip on a second request would turn it into a retry.
            if (!named && (transient || isInputRejectedLlmError(err))) throw err;
            // Nor when the option never went out: the failed request's body
            // says so when the error keeps it, else the model's last success.
            const sent = summaryInBody(requestBodyOf(err)) ?? this.summarySent.get(summarySentKey(candidate)) ?? true;
            if (!named && !sent) throw err;
            if (named) this.summaryRefused.add(summaryKey(candidate));
            result = await streamOnce(false);
            this.summaryRefused.add(summaryKey(candidate));
          }
          recorder?.finishCall(callId, {
            status: "succeeded",
            result,
            usage: result.usage,
            metadata: {
              ...callMetadata,
              stream: streamDiagnostics.summary("succeeded"),
              // The context the model read, beside the billed sum (a continued Google reply).
              ...(result.usage.contextPromptTokens !== undefined ? { contextInputTokens: result.usage.contextPromptTokens } : {})
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
          input.onAttemptFailed(candidate);
          if (input.signal.aborted) throw new WakeCanceledError();
          throw err;
        } finally {
          // Every exit from an attempt passes here — success, retry, fallback,
          // throw, cancel — and each one ends this stream. A delta still
          // coalesced past the end would arrive after the finished message and
          // relight the streaming bubble.
          this.deps.sse.flushMessageDelta?.(input.threadId, input.wakeId);
          idle.cleanup();
        }
      }
    });
  }
}

/** What a call on a thread's prompt sends besides the prompt, as the thread's
 *  steps send it: the model, its reasoning settings, the provider options
 *  (the OpenAI prompt cache key among them) and the session headers. A call
 *  that shares a step's prompt cache (a compaction) sends the same. */
export function candidateCallOptions(
  candidate: WakeLlmCandidate,
  threadId: string,
  opts: { providerOptions?: SharedV4ProviderOptions; askSummary: boolean }
) {
  return {
    model: candidate.model,
    providerOptions: providerOptionsForCandidate(opts.providerOptions, candidate, threadId, opts.askSummary),
    headers: sessionAffinityHeaders(candidate, threadId),
    reasoning: reasoningForAiSdk(candidate.meta?.reasoningEffort, candidate.meta?.supportsReasoning)
  };
}

/**
 * A custom provider is usually a proxy over several upstreams, and a prompt
 * cache lives on one: the proxy keeps a conversation's requests together
 * only when told which belong together. Each wake step names its thread in
 * the two session-affinity headers proxies read (OpenRouter's x-session-id,
 * and x-session-affinity). Other providers get none.
 */
function sessionAffinityHeaders(candidate: WakeLlmCandidate, threadId: string): Record<string, string> | undefined {
  // Kilo's own client sends the same two (its gateway may not read them yet).
  if (candidate.meta?.providerType !== "openai-compatible" && candidate.meta?.providerType !== "kilo") return undefined;
  return { "x-session-id": threadId, "x-session-affinity": threadId };
}

/** A step's provider options for this candidate: reasoning on as configured,
 *  and for an OpenAI-style Responses model nothing kept at the provider
 *  (store false, so its reasoning comes back encrypted for the next step),
 *  a prompt-cache key for the conversation, and the summary only when asked.
 *  The agent's wakes and the memory dream both send these. */
export function providerOptionsForCandidate(
  existing: SharedV4ProviderOptions | undefined,
  candidate: WakeLlmCandidate,
  cacheKey: string,
  askSummary: boolean
): SharedV4ProviderOptions | undefined {
  const withReasoning = providerOptionsWithReasoningForAiSdk(
    existing,
    candidate.meta?.provider,
    candidate.meta?.supportsReasoning
  );
  if (!shouldPreserveOpenAiReasoningState(candidate)) return withReasoning;
  const openai: JSONObject = withReasoning?.openai ?? {};
  // A model on the Open Responses package reads its options under its own
  // key; store and the cache key it gets from the request (open-responses-model.ts).
  const openResponses: JSONObject = withReasoning?.[OPEN_RESPONSES_NAME] ?? {};
  const onOpenResponses = isOpenResponsesModel(candidate.model);
  return {
    ...withReasoning,
    ...(onOpenResponses ? { [OPEN_RESPONSES_NAME]: { ...openResponses, reasoningSummary: askSummary ? openResponses.reasoningSummary ?? "auto" : null } } : {}),
    openai: {
      ...openai,
      store: openai.store ?? false,
      promptCacheKey: openai.promptCacheKey ?? cacheKey,
      // The live heading's source (and the step's kept summary). The AI SDK
      // sends it only to a model it takes for a reasoning one. Off is an
      // explicit null: left out, the SDK adds "detailed" whenever an effort
      // is set — which a gateway that refused the summary refuses again.
      reasoningSummary: askSummary ? openai.reasoningSummary ?? "auto" : null
    }
  };
}

/** A model under its reasoning settings: marking it Supported (or changing
 *  its effort) changes whether the SDK sends the summary option. */
function summarySentKey(candidate: WakeLlmCandidate): string {
  const meta = candidate.meta;
  return [summaryKey(candidate), String(meta?.supportsReasoning ?? "auto"), meta?.reasoningEffort ?? ""].join("|");
}

/** Whether a request body carries the reasoning-summary option; null when
 *  the body is not readable (absent, or not JSON). */
function summaryInBody(body: unknown): boolean | null {
  let value = body;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!isRecord(value)) return null;
  return isRecord(value.reasoning) && value.reasoning.summary != null;
}

/** The request body an error keeps (the AI SDK's API call error does), from
 *  the error or the causes it wraps. */
function requestBodyOf(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    if (current.requestBodyValues !== undefined) return current.requestBodyValues;
    current = current.cause;
  }
  return undefined;
}

/** Which model a refused summary request belongs to. */
function summaryKey(candidate: WakeLlmCandidate): string {
  const meta = candidate.meta;
  const modelId = typeof candidate.model === "string" ? candidate.model : candidate.model.modelId;
  return [meta?.provider ?? "", meta?.baseURL ?? "", meta?.model ?? modelId].join("|");
}

function shouldPreserveOpenAiReasoningState(candidate: WakeLlmCandidate): boolean {
  // LanguageModel can be a bare model-id string with no provider field.
  const modelProvider = typeof candidate.model === "string" ? "" : candidate.model.provider.toLowerCase();
  // A Chat Completions model takes none of the Responses-only options,
  // whatever provider family it belongs to.
  if (modelProvider.endsWith(".chat")) return false;
  const provider = candidate.meta?.provider;
  if (provider === "openai" || provider === "openai-compatible" || provider === "codex") return true;
  return modelProvider === "openai.responses" || modelProvider === "codex.responses";
}

export function assistantMessagesOnly(messages: readonly unknown[]): AiSdkAssistantMessage[] {
  return messages.filter((message): message is AiSdkAssistantMessage =>
    isRecord(message) && message.role === "assistant"
  );
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
