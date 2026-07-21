import type { LanguageModel, ModelMessage } from "ai";
import type { ReasoningEffort } from "../../shared/settings.js";
import {
  callTextModelForProvider,
  textGenerationApiMode,
  type TextModelCallArgs,
  type TextModelCallResult
} from "../modules/llm/text-model.js";
import { DEFAULT_TEXT_MODEL_LLM_TIMEOUT } from "../modules/llm/timeouts.js";
import { reasoningForAiSdk } from "../modules/llm/reasoning.js";

export async function runAgentCompressionLlm(input: {
  model: LanguageModel;
  provider: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  system: string;
  messages: ModelMessage[];
}) {
  const args: TextModelCallArgs = {
    model: input.model,
    system: input.system,
    messages: input.messages,
    reasoning: reasoningForAiSdk(input.reasoningEffort, input.supportsReasoning),
    maxRetries: 0,
    timeout: DEFAULT_TEXT_MODEL_LLM_TIMEOUT
  };

  const result = await callTextModelForProvider(input.provider, args, input.supportsReasoning);
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
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}
