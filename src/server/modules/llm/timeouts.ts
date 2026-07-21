import type { TimeoutConfiguration, ToolSet } from "ai";

const MINUTE_MS = 60_000;
export const LLM_STREAM_IDLE_TIMEOUT_MS = 90_000;

export const AGENT_WAKE_STEP_LLM_TIMEOUT = {
  totalMs: 5 * MINUTE_MS,
  chunkMs: LLM_STREAM_IDLE_TIMEOUT_MS
} satisfies TimeoutConfiguration<ToolSet>;

export const MEMORY_DREAM_STEP_LLM_TIMEOUT = {
  totalMs: 3 * MINUTE_MS,
  chunkMs: LLM_STREAM_IDLE_TIMEOUT_MS
} satisfies TimeoutConfiguration<ToolSet>;

export const DEFAULT_TEXT_MODEL_LLM_TIMEOUT = {
  totalMs: 5 * MINUTE_MS
} satisfies TimeoutConfiguration<ToolSet>;
