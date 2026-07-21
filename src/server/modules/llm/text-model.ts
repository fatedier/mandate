import { streamText } from "ai";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { DEFAULT_TEXT_MODEL_LLM_TIMEOUT } from "./timeouts.js";
import { providerOptionsWithReasoningForAiSdk } from "./reasoning.js";

export type TextModelCallArgs = Parameters<typeof streamText>[0];

export interface TextModelCallResult {
  text: string;
  usage?: unknown;
  totalUsage?: unknown;
  finishReason?: unknown;
  rawFinishReason?: unknown;
  warnings?: unknown;
  request?: unknown;
  response?: unknown;
  providerMetadata?: unknown;
}

export function textGenerationApiMode(provider: string): "generateText" | "streamText" {
  void provider;
  return "streamText";
}

export async function callTextModelForProvider(
  provider: string,
  args: TextModelCallArgs,
  supportsReasoning?: boolean
): Promise<TextModelCallResult> {
  const callArgs = {
    ...args,
    providerOptions: providerOptionsWithReasoningForAiSdk(
      args.providerOptions,
      provider,
      args.reasoning as ReasoningEffort | undefined,
      supportsReasoning
    ),
    maxRetries: args.maxRetries ?? 0,
    timeout: args.timeout ?? DEFAULT_TEXT_MODEL_LLM_TIMEOUT
  };

  const result = streamText(callArgs);
  const [
    text,
    usage,
    totalUsage,
    finishReason,
    rawFinishReason,
    warnings,
    request,
    response,
    providerMetadata
  ] = await Promise.all([
    result.text,
    result.usage,
    result.totalUsage,
    result.finishReason,
    result.rawFinishReason,
    result.warnings,
    result.request,
    result.response,
    result.providerMetadata
  ]);

  return {
    text,
    usage,
    totalUsage,
    finishReason,
    rawFinishReason,
    warnings,
    request,
    response,
    providerMetadata
  };
}
