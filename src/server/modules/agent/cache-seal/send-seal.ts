import { streamText, type TimeoutConfiguration, type ToolSet } from "ai";
import { AGENT_WAKE_STEP_LLM_TIMEOUT, LLM_STREAM_IDLE_TIMEOUT_MS } from "../../llm/timeouts.js";
import { idleGuardedStreamOptions } from "../../llm/stream-timeout.js";
import type { AgentLlmCallRecorder } from "../../activity/llm-call-recorder.js";
import { extractUsage } from "../../activity/llm-call-logging.js";
import { collectStream } from "../stream-collector.js";
import { candidateCallOptions, type WakeLlmCandidate } from "../wake-llm-attempts.js";
import type { SealResult, SealSend } from "./cache-sealer.js";

/**
 * Sends a seal as a call of its own: the step's call options, system and
 * tools, the sealed messages, one output token (a streamed request may not
 * ask for none), no retries, and a wake step's time limits: one the provider
 * never finishes fails, and the safety net counts it. Recorded as `agent_cache_seal` in its thread,
 * with the lifetime its mark asked for. Its output is not kept.
 */
export function createSealSender(deps: {
  recorderFor(candidate: WakeLlmCandidate): AgentLlmCallRecorder | null;
  threadScope(threadId: string): string | null;
  now(): number;
  /** A wake step's, unless a test passes its own. */
  timeout?: TimeoutConfiguration<ToolSet>;
}): (send: SealSend) => Promise<SealResult> {
  return async (send) => {
    const recorder = deps.recorderFor(send.candidate);
    const callId = recorder?.startCall({
      purpose: "agent_cache_seal",
      scopeType: "agent_thread",
      scopeId: send.threadId,
      metadata: { threadScope: deps.threadScope(send.threadId), cacheTtl: "1h" }
    }) ?? null;
    const startedAt = deps.now();
    // Cut when quiet, as every model call is.
    const idle = idleGuardedStreamOptions({ model: send.candidate.model, timeout: deps.timeout ?? AGENT_WAKE_STEP_LLM_TIMEOUT, idleMs: LLM_STREAM_IDLE_TIMEOUT_MS });
    try {
      const stream = streamText({
        ...candidateCallOptions(send.candidate, send.threadId, { askSummary: false }),
        system: send.system,
        tools: send.tools,
        messages: send.messages,
        maxOutputTokens: 1,
        maxRetries: 0,
        ...idle.options
      });
      const collected = await collectStream(stream.fullStream);
      recorder?.finishCall(callId, { status: "succeeded", result: collected, usage: collected.usage, latencyMs: deps.now() - startedAt });
      const usage = extractUsage(collected.usage);
      return {
        ok: true,
        outputTokens: usage.outputTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        cacheWrite1h: collected.facts?.cacheWrite1h,
        finishedAt: deps.now()
      };
    } catch (error) {
      recorder?.finishCall(callId, { status: "failed", error, latencyMs: deps.now() - startedAt });
      return { ok: false, error };
    } finally {
      idle.cleanup();
    }
  };
}
