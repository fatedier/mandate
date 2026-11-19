import { streamText, type LanguageModel, type ModelMessage, type SystemModelMessage, type TimeoutConfiguration, type ToolSet } from "ai";
import type { AiSdkAssistantMessage } from "../../../shared/agent-message-types.js";
import { isRecord } from "../../../shared/guards.js";
import { idleGuardedStreamOptions, isIdleActivityChunk } from "../llm/stream-timeout.js";
import { createLlmStreamDiagnostics, type LlmStreamDiagnostics, type LlmStreamDiagnosticsInput } from "./llm-stream-diagnostics.js";
import { forReplay } from "./reasoning-replay.js";
import { collectStream, isVisibleOutputStreamPart } from "./stream-collector.js";
import type { candidateCallOptions } from "./wake-llm-attempts.js";

/** One model stream of a wake step: the request, the stream read into what
 *  Mandate keeps, and the replay messages. The same function wherever the
 *  stream runs, so the step behaves the same either way. */

/** What an attempt keeps across its streams (a refused summary request is
 *  streamed again within the same attempt): the idle guard and the stream's
 *  diagnostics. */
export interface AttemptStreamState {
  idle: ReturnType<typeof idleGuardedStreamOptions>;
  diagnostics: LlmStreamDiagnostics;
}

export function openAttemptStreamState(input: {
  model: LanguageModel;
  timeout: TimeoutConfiguration<ToolSet>;
  idleMs: number;
  parentSignal?: AbortSignal;
  diagnostics: LlmStreamDiagnosticsInput;
}): AttemptStreamState {
  return {
    diagnostics: createLlmStreamDiagnostics(input.diagnostics),
    // Cut when quiet, as every model call is. Its raw chunks are kept
    // too, for an error a gateway sends inside an ordinary chunk, which
    // the SDK drops (collectStream).
    idle: idleGuardedStreamOptions({
      model: input.model,
      timeout: input.timeout,
      idleMs: input.idleMs,
      parentSignal: input.parentSignal
    })
  };
}

export interface ModelStreamInput {
  model: LanguageModel;
  tools?: ToolSet;
  system?: string | SystemModelMessage | SystemModelMessage[];
  messages: ModelMessage[];
  /** The call's options besides the model (candidateCallOptions). */
  callOptions: Omit<ReturnType<typeof candidateCallOptions>, "model">;
  askSummary: boolean;
}

export interface ModelStreamHooks {
  /** Once per stream, at its first reasoning delta, heading or not. */
  onReasoning(): void;
  /** Each time the reasoning summary reaches a new heading. */
  onHeading(heading: string): void;
  onTextDelta(delta: string, totalText: string): void;
  /** A stream that asked for the summary: whether its request carried it
   *  (null when the body could not be read), as soon as that is known —
   *  before the replay messages are read. */
  onSummaryInBody?(sent: boolean | null): void;
}

export interface ModelStreamOutput {
  collected: Awaited<ReturnType<typeof collectStream>>;
  sdkAssistantMessages: AiSdkAssistantMessage[];
  /** Whether the request carried the summary option, as summaryInBody reads
   *  it; undefined when the stream did not ask for it. */
  summaryInBody: boolean | null | undefined;
}

export async function streamModelOnce(
  input: ModelStreamInput,
  state: AttemptStreamState,
  hooks: ModelStreamHooks
): Promise<ModelStreamOutput> {
  const stream = streamText({
    model: input.model,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.system !== undefined ? { system: input.system } : {}),
    messages: input.messages,
    ...input.callOptions,
    maxRetries: 0,
    ...state.idle.options,
    // To see whether the SDK put the summary option on the wire.
    ...(input.askSummary ? { include: { requestBody: true } } : {})
  });
  // The page hears the heading the reasoning summary has reached, for its
  // working line, each time it changes — not the summary itself.
  let heading: string | null = null;
  let reasoningHeard = false;
  const collected = await collectStream(stream.fullStream, {
    onReasoningHeading: (next) => {
      if (!reasoningHeard) {
        reasoningHeard = true;
        hooks.onReasoning();
      }
      if (!next || next === heading) return;
      heading = next;
      hooks.onHeading(next);
    },
    onPart: (part) => state.diagnostics.recordPart(part, isIdleActivityChunk(part), isVisibleOutputStreamPart(part)),
    onTextDelta: (delta, totalText) => hooks.onTextDelta(delta, totalText)
  });
  const sent = input.askSummary
    ? summaryInBody((await Promise.resolve(stream.request).catch(() => undefined))?.body)
    : undefined;
  if (sent !== undefined) hooks.onSummaryInBody?.(sent);
  // The summary stays server-side (collected.reasoning): what is replayed to
  // the model is as it was before summaries were asked for.
  const sdkAssistantMessages = assistantMessagesOnly(await stream.responseMessages).map(forReplay);
  return { collected, sdkAssistantMessages, summaryInBody: sent };
}

export function assistantMessagesOnly(messages: readonly unknown[]): AiSdkAssistantMessage[] {
  return messages.filter((message): message is AiSdkAssistantMessage =>
    isRecord(message) && message.role === "assistant"
  );
}

/** Whether a request body carries the reasoning-summary option; null when
 *  the body is not readable (absent, or not JSON). */
export function summaryInBody(body: unknown): boolean | null {
  let value = body;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!isRecord(value)) return null;
  return isRecord(value.reasoning) && value.reasoning.summary != null;
}

/** The request body an error keeps (the AI SDK's API call error does), from
 *  the error or the causes it wraps. */
export function requestBodyOf(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && isRecord(current); depth++) {
    if (current.requestBodyValues !== undefined) return current.requestBodyValues;
    current = current.cause;
  }
  return undefined;
}
