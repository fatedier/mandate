import { NoOutputGeneratedError, streamText } from "ai";
import { DEFAULT_TEXT_MODEL_LLM_TIMEOUT } from "./timeouts.js";
import { idleGuardedStreamOptions } from "./stream-timeout.js";
import { providerOptionsWithReasoningForAiSdk } from "./reasoning.js";
import { carryFirstOutput, firstOutputClock } from "./first-output.js";

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
  /** Milliseconds from the request to the provider's first part, or null
   *  when it sent none: the call's time to first token. */
  firstOutputMs: number | null;
}

export async function callTextModelForProvider(
  provider: string,
  args: TextModelCallArgs,
  supportsReasoning?: boolean,
  /** With `streamIdleTimeoutMs`, a stream quiet that long is cut, as every
   *  model call's is (idleGuardedStreamOptions). */
  opts: { streamIdleTimeoutMs?: number } = {}
): Promise<TextModelCallResult> {
  const timeout = args.timeout ?? DEFAULT_TEXT_MODEL_LLM_TIMEOUT;
  // Every chunk the SDK hands on is the provider's: the first is the call's
  // first output.
  const firstOutput = firstOutputClock();
  const onChunk: TextModelCallArgs["onChunk"] = (event) => {
    firstOutput.note(event.chunk.type);
    return args.onChunk?.(event);
  };
  const idle = opts.streamIdleTimeoutMs
    ? idleGuardedStreamOptions({ model: args.model, timeout, idleMs: opts.streamIdleTimeoutMs, parentSignal: args.abortSignal, onChunk: onChunk as never })
    : null;
  const callArgs = {
    ...args,
    providerOptions: providerOptionsWithReasoningForAiSdk(
      args.providerOptions,
      provider,
      supportsReasoning
    ),
    maxRetries: args.maxRetries ?? 0,
    timeout,
    onChunk,
    ...(idle?.options ?? {})
  };

  // streamText reports a stream error only to onError; its result promises then
  // reject with a generic NoOutputGeneratedError that carries no status and no
  // provider message. Keep the original so the caller's retry policy and the
  // activity log see what the provider actually said (an overload, a refusal).
  let streamError: { error: unknown } | null = null;
  let settled;
  try {
    // Made inside the try: a call the SDK refuses at once still cleans up.
    const result = streamText({
      ...callArgs,
      onError: ({ error }) => {
        streamError ??= { error };
      }
    });
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
    const thrown = recorded && NoOutputGeneratedError.isInstance(error) ? recorded.error : error;
    carryFirstOutput(thrown, firstOutput.ms());
    throw thrown;
  } finally {
    idle?.cleanup();
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
  // A provider can fail the response in the stream and the SDK still resolve
  // (the Open Responses package does): the reply is the failure, not an empty answer.
  if (finishReason === "error" && streamError) {
    const failed = (streamError as { error: unknown }).error;
    carryFirstOutput(failed, firstOutput.ms());
    throw failed;
  }

  return {
    text,
    usage,
    totalUsage,
    finishReason,
    rawFinishReason,
    warnings,
    request,
    response,
    providerMetadata,
    firstOutputMs: firstOutput.ms()
  };
}
