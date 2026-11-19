import { type LanguageModel, type ModelMessage, type SystemModelMessage, type TimeoutConfiguration, type ToolSet } from "ai";
import type { JSONObject, SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { AiSdkAssistantMessage } from "../../../shared/agent-message-types.js";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import { isRecord } from "../../../shared/guards.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import type { AgentProviderSnapshot } from "./llm-provider.js";
import type { HostDiagnostics, ModelCallHost } from "./model-call-host.js";
import type { OfferedToolSpec } from "./tool-set.js";
import { isOpenResponsesModel, OPEN_RESPONSES_NAME } from "../llm/open-responses-model.js";
import { isReasoningSummaryRefusal, providerOptionsWithReasoningForAiSdk, reasoningForAiSdk, reasoningOn } from "../llm/reasoning.js";
import { isCyberPolicyLlmError, isInputRejectedLlmError, isNonFallbackLlmError, isRetryableLlmError, isTimeoutLlmError } from "../llm/retry-policy.js";
import { llmAttemptMetadata, runLlmCandidates } from "../llm/run-candidates.js";
import { openAttemptStreamState, requestBodyOf, streamModelOnce, summaryInBody, type AttemptStreamState, type ModelStreamHooks, type ModelStreamOutput } from "./model-stream.js";
import type { collectStream } from "./stream-collector.js";
import { WakeCanceledError } from "./wake-canceled-error.js";
import { stallWatch, type StallWatch } from "../../platform/diagnostics/stall-watch.js";


/** One wake step's call to the model: the candidates in order, each attempt
 *  streamed (deltas and the reasoning heading to the page), recorded for
 *  Activity, retried or handed to the next candidate by the shared runner, and
 *  the reasoning-summary request dropped for a model whose gateway refuses it.
 *  Holds what it learns about models across steps and wakes. */

export interface WakeLlmCandidate {
  model: LanguageModel;
  /** What the model was built from, when another thread can build it. */
  construction?: AgentProviderSnapshot;
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
  /** The conversation whose prompt cache the call reads, when not its own
   *  thread's: a side chat's is the personal agent's, whose conversation it
   *  starts with. Its prompt-cache key and session headers name it. */
  cacheThreadId?: string;
}

type WakeStreamArgs = {
  tools?: ToolSet;
  /** The same tools as specs, for the model-call worker; null when one of
   *  them cannot be offered there (its steps stay on this thread). */
  toolSpecs?: OfferedToolSpec[] | null;
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
  /** The model-call worker; absent, every stream runs on this thread. */
  modelCalls?: ModelCallHost;
  /** Where a stream on this thread is named while it runs (the process's stall watch). */
  stallWatch?: Pick<StallWatch, "watched">;
  /** The wait before a retry; a test passes one that does not wait. */
  retryWait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

let attemptSequence = 0;
/** A signal that never aborts: a stream asked for with none. */
const NEVER = new AbortController().signal;

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
      wait: (ms) => (this.deps.retryWait ?? sleep)(ms, input.signal),
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
        const timeout = this.deps.llmTimeout();
        const diagnosticsInput = {
          startedAt,
          callId,
          wakeId: input.wakeId,
          candidateIndex,
          attempt,
          provider: candidate.meta?.provider,
          model: candidate.meta?.model,
          idleTimeoutMs
        };
        const openHere = () => openAttemptStreamState({
          model: candidate.model,
          timeout,
          idleMs: idleTimeoutMs,
          parentSignal: input.streamArgs.abortSignal,
          diagnostics: diagnosticsInput
        });
        // The whole attempt streams on the model-call worker when it can take
        // it; otherwise, or when a stream could not be handed to it, here.
        const host = this.deps.modelCalls;
        const toolSpecs = input.streamArgs.toolSpecs ?? null;
        const viaWorker = host?.canStream(candidate, toolSpecs) ?? false;
        const attemptId = `attempt_${++attemptSequence}`;
        let here = viaWorker ? null : openHere();
        let observed: { firstOutputAt: number | null } | null = null;
        // The attempt's stream diagnostics under its outcome: the worker takes
        // them where the stream ran; a worker that did not answer leaves what
        // this thread saw.
        const diagnosticsHere = (state: AttemptStreamState, status: "succeeded" | "failed"): HostDiagnostics =>
          ({ summary: state.diagnostics.summary(status), ttftMs: state.diagnostics.ttftMs() });
        const diagnosticsFor = async (status: "succeeded" | "failed"): Promise<HostDiagnostics> => {
          const fromWorker = viaWorker ? await host!.endAttempt(attemptId, status) : null;
          if (here) return diagnosticsHere(here, status);
          if (fromWorker) return fromWorker;
          return { summary: { status, modelWorkerAnswered: false }, ttftMs: observed?.firstOutputAt != null ? Math.max(0, observed.firstOutputAt - startedAt) : null };
        };
        // Any reasoning heard proves the summary request was taken.
        let reasoningSeen = false;
        const streamOnce = async (askSummary: boolean): Promise<WakeLlmResult> => {
          const { model, ...callOptions } = candidateCallOptions(candidate, input.threadId, { providerOptions: input.streamArgs.providerOptions, askSummary });
          const messages = input.messagesFor?.(candidate) ?? input.streamArgs.messages;
          const hooks: ModelStreamHooks = {
            onReasoning: () => { reasoningSeen = true; },
            onSummaryInBody: (sent) => {
              if (sent !== null) this.summarySent.set(summarySentKey(candidate), sent);
            },
            onHeading: (heading) => {
              this.deps.sse.emit(SSE_EVENTS.agentReasoningHeading, { threadId: input.threadId, wakeId: input.wakeId, heading });
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
          };
          const streamInput = {
            model,
            ...(input.streamArgs.tools ? { tools: input.streamArgs.tools } : {}),
            ...(input.streamArgs.system !== undefined ? { system: input.streamArgs.system } : {}),
            messages,
            callOptions,
            askSummary
          };
          let output: ModelStreamOutput | null = null;
          if (viaWorker && !here) {
            const sent = await host!.stream({
              attemptId,
              threadId: input.threadId,
              wakeId: input.wakeId,
              candidate,
              tools: toolSpecs!,
              ...(input.streamArgs.system !== undefined ? { system: input.streamArgs.system } : {}),
              messages,
              callOptions,
              askSummary,
              timeout,
              idleMs: idleTimeoutMs,
              startedAt,
              diagnostics: diagnosticsInput,
              signal: input.streamArgs.abortSignal ?? NEVER
            }, hooks);
            if (sent.ok) output = sent.output;
            else if (!sent.notPosted) {
              if (sent.observed) observed = sent.observed;
              throw sent.error;
            }
          }
          // Not handed to the worker (it is gone, or the prompt cannot be
          // copied to it): this stream and the rest of the attempt run here.
          if (!output) {
            const state = here ??= openHere();
            // Named while it runs: a stall it causes says so in the log.
            output = await (this.deps.stallWatch ?? stallWatch).watched("model stream (in process)", () => streamModelOnce(streamInput, state, hooks));
          }
          const { collected, sdkAssistantMessages } = output;
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
          // A stream run on this thread: its diagnostics are taken at once.
          const diagnostics = viaWorker ? await diagnosticsFor("succeeded") : diagnosticsHere(here!, "succeeded");
          recorder?.finishCall(callId, {
            status: "succeeded",
            result,
            usage: result.usage,
            metadata: {
              ...callMetadata,
              stream: diagnostics.summary,
              // The context the model read, beside the billed sum (a continued Google reply).
              ...(result.usage.contextPromptTokens !== undefined ? { contextInputTokens: result.usage.contextPromptTokens } : {})
            },
            ttftMs: diagnostics.ttftMs,
            latencyMs: Date.now() - startedAt
          });
          return result;
        } catch (err) {
          const diagnostics = viaWorker ? await diagnosticsFor("failed") : diagnosticsHere(here!, "failed");
          recorder?.finishCall(callId, {
            status: "failed",
            error: err,
            metadata: {
              ...callMetadata,
              stream: diagnostics.summary
            },
            ttftMs: diagnostics.ttftMs,
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
          here?.idle.cleanup();
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
  const cacheKey = candidate.cacheThreadId ?? threadId;
  return {
    model: candidate.model,
    providerOptions: providerOptionsForCandidate(opts.providerOptions, candidate, cacheKey, opts.askSummary),
    headers: sessionAffinityHeaders(candidate, cacheKey),
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
