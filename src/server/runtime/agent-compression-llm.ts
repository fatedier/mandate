import type { LanguageModel, ModelMessage } from "ai";
import type { ReasoningEffort } from "../../shared/settings.js";
import {
  callTextModelForProvider,
  textGenerationApiMode,
  type TextModelCallArgs,
  type TextModelCallResult
} from "../modules/llm/text-model.js";
import { LLM_STREAM_IDLE_TIMEOUT_MS, DEFAULT_TEXT_MODEL_LLM_TIMEOUT } from "../modules/llm/timeouts.js";
import type { TimeoutConfiguration, ToolSet } from "ai";

/** A test passes short ones; by default the background reads' 8 minutes in
 *  all and 2 quiet ones. */
interface CompactionTimeouts {
  llmTimeout?: TimeoutConfiguration<ToolSet>;
  streamIdleTimeoutMs?: number;
}
import { reasoningForAiSdk } from "../modules/llm/reasoning.js";
import { throwIfCutOff } from "../modules/llm/output-limit-failure.js";
import { candidateCallOptions, type WakeLlmCandidate } from "../modules/agent/wake-llm-attempts.js";
import type { StepPrompt } from "../modules/agent/wake-loop.js";

export async function runAgentCompressionLlm(input: {
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  system: string;
  messages: ModelMessage[];
} & CompactionTimeouts) {
  const args: TextModelCallArgs = {
    model: input.model,
    system: input.system,
    messages: input.messages,
    reasoning: reasoningForAiSdk(input.reasoningEffort, input.supportsReasoning),
    maxRetries: 0,
    timeout: input.llmTimeout ?? DEFAULT_TEXT_MODEL_LLM_TIMEOUT
  };

  const result = await callTextModelForProvider(input.provider, args, input.supportsReasoning, {
    streamIdleTimeoutMs: input.streamIdleTimeoutMs ?? LLM_STREAM_IDLE_TIMEOUT_MS
  });
  assertCompressionFinished(result);
  return result;
}

/** A compaction sent as the thread's next step would be sent, its prompt
 *  with the compaction prompt after it: what the step's prompt cache holds is
 *  read, not written again. The step's tools go with it, as the cache keys on
 *  them too; a call the model makes anyway is not run, and its text is the
 *  summary. The reasoning summary is not asked for: a gateway may refuse it. */
export async function runAgentCompressionOnStepPrompt(input: {
  candidate: WakeLlmCandidate;
  threadId: string;
  prompt: Pick<StepPrompt, "tools" | "system">;
  messages: ModelMessage[];
} & CompactionTimeouts) {
  const { candidate } = input;
  const args: TextModelCallArgs = {
    ...candidateCallOptions(candidate, input.threadId, { askSummary: false }),
    tools: input.prompt.tools,
    system: input.prompt.system,
    messages: input.messages,
    maxRetries: 0,
    timeout: input.llmTimeout ?? DEFAULT_TEXT_MODEL_LLM_TIMEOUT
  };
  const result = await callTextModelForProvider(candidate.meta?.provider ?? "", args, candidate.meta?.supportsReasoning, {
    streamIdleTimeoutMs: input.streamIdleTimeoutMs ?? LLM_STREAM_IDLE_TIMEOUT_MS
  });
  assertCompressionFinished(result);
  return result;
}

export function compressionApiMode(provider: string) {
  return textGenerationApiMode(provider);
}

function assertCompressionFinished(result: TextModelCallResult): void {
  const finishReason = stringValue(result.finishReason);
  const rawFinishReason = stringValue(result.rawFinishReason);
  if (finishReason === "error" || rawFinishReason === "error") {
    throw new Error("compression LLM finished with error");
  }
  throwIfCutOff(finishReason);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
