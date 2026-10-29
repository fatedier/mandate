import { expect, test } from "bun:test";
import {
  AGENT_WAKE_STEP_LLM_TIMEOUT,
  DEFAULT_TEXT_MODEL_LLM_TIMEOUT,
  LLM_STREAM_IDLE_TIMEOUT_MS,
  MEMORY_DREAM_STEP_LLM_TIMEOUT
} from "../src/server/modules/llm/timeouts.js";

const MINUTE_MS = 60_000;

// Extraction, compression's summary and the dream read hundreds of thousands
// of tokens and ran into their old limits (5, 5 and 3 minutes) on large
// windows; they get 8. An agent's own step keeps its 5 minutes.
test("the long reads (extraction, compression, the checks, the dream) get 8 minutes; an agent's step keeps 5", () => {
  expect(DEFAULT_TEXT_MODEL_LLM_TIMEOUT.totalMs).toBe(8 * MINUTE_MS);
  expect(MEMORY_DREAM_STEP_LLM_TIMEOUT.totalMs).toBe(8 * MINUTE_MS);
  // A stream that stops sending is given up on after the same 2 quiet
  // minutes, an agent's step's as a dream step's.
  expect(LLM_STREAM_IDLE_TIMEOUT_MS).toBe(2 * MINUTE_MS);
  expect(MEMORY_DREAM_STEP_LLM_TIMEOUT.chunkMs).toBe(LLM_STREAM_IDLE_TIMEOUT_MS);
  expect(AGENT_WAKE_STEP_LLM_TIMEOUT).toEqual({ totalMs: 5 * MINUTE_MS, chunkMs: LLM_STREAM_IDLE_TIMEOUT_MS });
});
