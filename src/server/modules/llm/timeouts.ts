import type { LanguageModel, TimeoutConfiguration, ToolSet } from "ai";
import { isOpenResponsesModel } from "./open-responses-model.js";

const MINUTE_MS = 60_000;
/** How long any model call's stream may go quiet before it is cut: an
 *  agent's step, a dream step, memory extraction, a compaction's summary:
 *  the same for all. */
export const LLM_STREAM_IDLE_TIMEOUT_MS = 2 * MINUTE_MS;

export const AGENT_WAKE_STEP_LLM_TIMEOUT = {
  totalMs: 5 * MINUTE_MS,
  chunkMs: LLM_STREAM_IDLE_TIMEOUT_MS
} satisfies TimeoutConfiguration<ToolSet>;

/** The background reads (a dream step; memory extraction and compression's
 *  summary, by the default below) take hundreds of thousands of tokens and
 *  ran into their old limits (3 and 5 minutes) on large inputs, each time
 *  paying for the whole read and starting over. Nobody waits on them as on
 *  an agent's step, so they get longer. A manager check's judge passes its
 *  own minute (manager-checks/judge.ts). */
const BACKGROUND_READ_MS = 8 * MINUTE_MS;

export const MEMORY_DREAM_STEP_LLM_TIMEOUT = {
  totalMs: BACKGROUND_READ_MS,
  chunkMs: LLM_STREAM_IDLE_TIMEOUT_MS
} satisfies TimeoutConfiguration<ToolSet>;

export const DEFAULT_TEXT_MODEL_LLM_TIMEOUT = {
  totalMs: BACKGROUND_READ_MS,
  chunkMs: LLM_STREAM_IDLE_TIMEOUT_MS
} satisfies TimeoutConfiguration<ToolSet>;

/**
 * The SDK's timeouts for a step on `model`. The SDK's chunk timer resets only
 * on parts it emits, and the Open Responses package emits none while a tool
 * call's arguments stream: its models drop the chunk timer and leave a stall
 * to the idle guard, which counts the provider's deltas
 * (idleGuardedStreamOptions).
 */
export function stepTimeoutFor(model: LanguageModel, timeout: TimeoutConfiguration<ToolSet>): TimeoutConfiguration<ToolSet> {
  if (!isOpenResponsesModel(model) || typeof timeout === "number" || timeout.chunkMs === undefined) return timeout;
  const { chunkMs: _dropped, ...rest } = timeout;
  return rest;
}
