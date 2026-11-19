import type { ModelMessage } from "ai";
import { callTextModelForProvider, type TextModelCallResult } from "../llm/text-model.js";
import { DEFAULT_TEXT_MODEL_LLM_TIMEOUT, LLM_STREAM_IDLE_TIMEOUT_MS } from "../llm/timeouts.js";
import { candidateCallOptions, type WakeLlmCandidate } from "../agent/wake-llm-attempts.js";
import { llmAttemptMetadata, type LlmAttempt } from "../llm/run-candidates.js";
import type { StepPrompt } from "../agent/wake-loop.js";

/** A side chat's summary call: its next step's prompt as its steps send it
 *  (the same tools, offered and never run, and the same cache key),
 *  recorded as `side_chat` on its thread. */
export type SideChatModelCall = (input: {
  candidate: WakeLlmCandidate;
  prompt: StepPrompt;
  messages: ModelMessage[];
  threadId: string;
  signal: AbortSignal;
  at: LlmAttempt;
}) => Promise<{ text: string; cutOff: boolean }>;

export const sideChatModelCall = (now: () => number): SideChatModelCall => async ({ candidate, prompt, messages, threadId, signal, at }) => {
  const recorder = candidate.llmCallRecorder;
  const startedAt = now();
  const callId = recorder?.startCall({
    purpose: "side_chat",
    scopeType: "agent_thread",
    scopeId: threadId,
    metadata: { provider: candidate.meta?.provider, model: candidate.meta?.model, threadScope: "side_chat", ...llmAttemptMetadata(at, {}) }
  }) ?? null;
  try {
    const result = await callTextModelForProvider(candidate.meta?.provider ?? "", {
      ...candidateCallOptions(candidate, threadId, { askSummary: false }),
      tools: prompt.tools,
      system: prompt.system,
      messages,
      maxRetries: 0,
      abortSignal: signal,
      timeout: DEFAULT_TEXT_MODEL_LLM_TIMEOUT
    }, candidate.meta?.supportsReasoning, { streamIdleTimeoutMs: LLM_STREAM_IDLE_TIMEOUT_MS });
    recorder?.finishCall(callId, { status: "succeeded", result: usageOf(result), latencyMs: now() - startedAt });
    return { text: result.text, cutOff: result.finishReason === "length" };
  } catch (error) {
    recorder?.finishCall(callId, { status: "failed", error, latencyMs: now() - startedAt });
    throw error;
  }
};

/** What a side call's record keeps: its usage, how it finished and the
 *  response's headers (a gateway's reported cost is one), never its words
 *  (the request log is no way for a side chat to outlive it). */
export function usageOf(result: TextModelCallResult): Partial<TextModelCallResult> {
  const headers = (result.response as { headers?: unknown } | undefined)?.headers;
  return {
    usage: result.usage, totalUsage: result.totalUsage, providerMetadata: result.providerMetadata,
    finishReason: result.finishReason, rawFinishReason: result.rawFinishReason, firstOutputMs: result.firstOutputMs,
    ...(headers !== undefined ? { response: { headers } } : {})
  };
}
