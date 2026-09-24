import { NoOutputGeneratedError, streamText } from "ai";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { DEFAULT_TEXT_MODEL_LLM_TIMEOUT } from "./timeouts.js";
import { providerOptionsWithReasoningForAiSdk } from "./reasoning.js";

/** An `onError` passed here is replaced: `callTextModelForProvider` owns it,
 *  because it is how the provider's own error is recovered (see below). */
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

  // streamText reports a stream error only to onError; its result promises then
  // reject with a generic NoOutputGeneratedError that carries no status and no
  // provider message. Keep the original so the caller's retry policy and the
  // activity log see what the provider actually said (an overload, a refusal).
  let streamError: { error: unknown } | null = null;
  const result = streamText({
    ...callArgs,
    onError: ({ error }) => {
      streamError ??= { error };
    }
  });
  let settled;
  try {
    settled = await Promise.all([
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
  } catch (error) {
    const recorded = streamError as { error: unknown } | null;
    if (recorded && NoOutputGeneratedError.isInstance(error)) throw recorded.error;
    throw error;
  }
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
  ] = settled;

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
