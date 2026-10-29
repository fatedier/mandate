import { InvalidToolInputError, JSONParseError } from "ai";
import type { ToolCall } from "./agent-store.js";
import { formatErrorMessage } from "../../platform/errors.js";
import { isRecord } from "../../../shared/guards.js";
import { CallFactsCollector, type CallFactCandidates } from "../pricing/call-facts.js";

interface StreamCollectorResult {
  text: string;
  toolCalls: ToolCall[];
  /** A completed Codex response may request another sampling step. */
  endTurn?: boolean;
  /** Why the response ended, as the AI SDK words it: "length" when it
   *  stopped at the output token limit. */
  finishReason?: string;
  /** Calls whose arguments are not JSON (in a reply cut off at the limit,
   *  the call it was writing). Not a call whose JSON breaks its schema: the
   *  SDK marks both invalid, and says which by its error's cause. */
  unreadableToolCallIds?: string[];
  /** Calls whose arguments started streaming and that never came through:
   *  a provider drops the one it was writing when the reply is cut off. */
  unfinishedToolCalls?: number;
  /** The reasoning summary, a paragraph per part, and the time from the
   *  first reasoning start to the last reasoning end. Absent when none. */
  reasoning?: { text: string; ms: number };
  /** What the response said about its own price (a reported cost, the
   *  1-hour cache writes, the service tier). Absent when it said nothing. */
  facts?: CallFactCandidates;
  /** The AI SDK's input/output counts under Mandate's prompt/completion
   *  names. inputTokenDetails / outputTokenDetails are passed through
   *  verbatim so llm-call-logging can persist cache + reasoning tokens. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    /** The prompt the model read, when it differs from the billed input: a
     *  Google reply continued in further requests sums their prompts. What
     *  the context meter and the compaction gate read. */
    contextPromptTokens?: number;
    inputTokenDetails?: unknown;
    outputTokenDetails?: unknown;
  };
}

interface CollectStreamOptions {
  /** Called for every text-delta with both the incremental delta and the
   *  running total so far. Lets the caller stream text to clients without
   *  re-stitching state inside the loop. */
  onTextDelta?: (delta: string, totalText: string) => void;
  /** Called with the reasoning summary so far, on every delta of it. */
  onReasoningDelta?: (totalText: string) => void;
  onPart?: (part: StreamPart) => void;
}

type StreamPart = Record<string, unknown> & { type: string };

export function isVisibleOutputStreamPart(part: StreamPart): boolean {
  switch (part.type) {
    case "text-delta":
      return textDelta(part).length > 0;
    case "tool-call":
      return true;
    default:
      return false;
  }
}

/** Drain an AI SDK `streamText` fullStream into the structured outputs
 *  Mandate persists. Throws on `error` events so the caller's catch block
 *  records the failure. Reasoning parts give the summary text and timing
 *  (their encrypted state rides in the AI SDK response messages, not here).
 *  A tool-input-start is counted until its call arrives, for a call the
 *  provider never finished. Other event types (start, text-start/end, the
 *  other tool-input parts, file, source, etc.) are ignored.
 *  Provider continuation state is preserved via AI SDK response messages.
 *  A thrown error carries `facts` and `usageSoFar`: a call that failed may
 *  still have been billed for what the provider had read. */
export async function collectStream(
  fullStream: AsyncIterable<unknown>,
  options: CollectStreamOptions = {}
): Promise<StreamCollectorResult> {
  const facts = new CallFactsCollector();
  try {
    return await collect(fullStream, options, facts);
  } catch (err) {
    if (err && typeof err === "object") {
      // Best effort: a frozen error is rethrown as it was, without them.
      try {
        const carrier = err as { facts?: CallFactCandidates; usageSoFar?: unknown };
        carrier.facts = facts.candidates();
        const usage = facts.usageSoFar();
        if (usage) carrier.usageSoFar = usage;
      } catch {
        /* the original error matters more than what it would have carried */
      }
    }
    throw err;
  }
}

async function collect(
  fullStream: AsyncIterable<unknown>,
  options: CollectStreamOptions,
  facts: CallFactsCollector
): Promise<StreamCollectorResult> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let rawUsage: unknown = null;
  let sawFinish = false;
  let endTurn: boolean | undefined;
  let finishReason: string | undefined;
  const unreadableToolCallIds: string[] = [];
  // Calls whose input started, until their tool-call part arrives.
  const startedToolInputs = new Set<string>();
  // Summary parts by id, in the order they began: parts may interleave.
  const reasoningParts = new Map<string, string>();
  const reasoningText = () => [...reasoningParts.values()].filter((part) => part).join("\n\n");
  // A Responses summary's next part starts its own paragraph. The Open
  // Responses package streams every part under the item's id and drops the
  // event that opens a part, so it is read from the raw chunk; @ai-sdk/openai
  // gives each part an id of its own (no text under the item's id: no break).
  const newSummaryPart = (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const chunk = raw as { type?: unknown; item_id?: unknown };
    if (chunk.type !== "response.reasoning_summary_part.added" || typeof chunk.item_id !== "string") return;
    // Only a part after text already under the item's id: the first opens it.
    const sofar = reasoningParts.get(chunk.item_id);
    if (sofar) reasoningParts.set(chunk.item_id, `${sofar}\n\n`);
  };
  let contextPromptTokens: number | undefined;
  let reasoningStartedAt: number | null = null;
  let reasoningLastAt: number | null = null;

  for await (const rawPart of fullStream) {
    if (!isStreamPart(rawPart)) continue;
    const part = rawPart;
    // A provider chunk as it came (streamText's includeRawChunks): read for
    // an error the SDK would drop, and not passed on.
    if (part.type === "raw") {
      newSummaryPart(part.rawValue);
      facts.noteRaw(part.rawValue);
      const inBand = inBandProviderError(part.rawValue);
      if (inBand) throw inBand;
      continue;
    }
    options.onPart?.(part);
    switch (part.type) {
      case "text-delta": {
        // Some stream layers emit `text` on text-delta parts while lower-level
        // provider streams may use `delta`. Accept either for resilience.
        const delta = textDelta(part);
        if (!delta) break;
        text += delta;
        options.onTextDelta?.(delta, text);
        break;
      }
      case "reasoning-start": {
        reasoningStartedAt ??= Date.now();
        const id = typeof part.id === "string" ? part.id : "";
        if (!reasoningParts.has(id)) reasoningParts.set(id, "");
        break;
      }
      case "reasoning-delta": {
        const delta = textDelta(part);
        if (!delta) break;
        // Each summary part (headed by its own bolded phrase) is a paragraph.
        const id = typeof part.id === "string" ? part.id : "";
        reasoningParts.set(id, (reasoningParts.get(id) ?? "") + delta);
        reasoningStartedAt ??= Date.now();
        // Timed to the last summary text: a provider may hold reasoning-end
        // back until the whole response completes (the Codex stream does).
        reasoningLastAt = Date.now();
        options.onReasoningDelta?.(reasoningText());
        break;
      }
      case "tool-input-start": {
        if (typeof part.id === "string") startedToolInputs.add(part.id);
        break;
      }
      case "tool-call": {
        const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
        startedToolInputs.delete(toolCallId);
        if (part.invalid === true && isUnreadableInput(part.error)) unreadableToolCallIds.push(toolCallId);
        toolCalls.push({
          toolCallId,
          toolName: typeof part.toolName === "string" ? part.toolName : "",
          args: part.input ?? {}
        });
        break;
      }
      case "finish-step": {
        facts.noteFinishStep(part);
        // The provider's own finish reason "error" (a chat gateway's): the
        // response failed, whatever arrived before it.
        if (part.rawFinishReason === "error") throw new Error("The provider ended the response with an error (finish_reason: error).");
        if (typeof part.finishReason === "string") finishReason = part.finishReason;
        const google = isRecord(part.providerMetadata) && isRecord(part.providerMetadata.google) ? part.providerMetadata.google : null;
        if (google && typeof google.initialPromptTokenCount === "number") contextPromptTokens = google.initialPromptTokenCount;
        const metadata = isRecord(part.providerMetadata) ? part.providerMetadata.codex : undefined;
        endTurn = part.finishReason === "stop" && isRecord(metadata) && typeof metadata.endTurn === "boolean"
          ? metadata.endTurn : undefined;
        break;
      }
      case "finish": {
        rawUsage = part.totalUsage ?? part.usage ?? null;
        sawFinish = true;
        break;
      }
      case "error": {
        const msg = formatErrorMessage(part.error, "stream error");
        const err = new Error(msg) as Error & { cause?: unknown };
        err.cause = part.error;
        throw err;
      }
      case "abort": {
        throw new Error(formatErrorMessage(part.reason, "LLM stream aborted"));
      }
    }
  }

  if (!sawFinish && text.length === 0 && toolCalls.length === 0) {
    throw new Error("LLM stream ended without a finish event or content.");
  }

  // The AI SDK reports inputTokens/outputTokens, kept here as
  // promptTokens/completionTokens. The token details pass through so the
  // llm-call recorder can persist cache + reasoning tokens (extractUsage pulls
  // them from those nested fields).
  const u = isRecord(rawUsage) ? rawUsage : {};
  // Nothing said and nothing counted: the provider never completed the
  // response (a completed one reports its usage). Taken for a reply, it ended
  // the turn in silence, so a stream that closes before its response
  // completes is a failure.
  const counted = numberOrZero(u.inputTokens) > 0 || numberOrZero(u.outputTokens) > 0;
  if (text.length === 0 && toolCalls.length === 0 && !counted) {
    throw new Error("The response ended before the provider finished it: no output and no usage.");
  }
  return {
    text,
    toolCalls,
    ...(endTurn !== undefined ? { endTurn } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(unreadableToolCallIds.length ? { unreadableToolCallIds } : {}),
    ...(startedToolInputs.size ? { unfinishedToolCalls: startedToolInputs.size } : {}),
    ...(facts.hasAny() ? { facts: facts.candidates() } : {}),
    ...(reasoningText().trim()
      ? { reasoning: { text: reasoningText().trim(), ms: Math.max(0, (reasoningLastAt ?? 0) - (reasoningStartedAt ?? 0)) } }
      : {}),
    usage: {
      promptTokens: numberOrZero(u.inputTokens),
      completionTokens: numberOrZero(u.outputTokens),
      ...(contextPromptTokens !== undefined ? { contextPromptTokens } : {}),
      inputTokenDetails: u.inputTokenDetails,
      outputTokenDetails: u.outputTokenDetails
    }
  };
}

/** An error a provider sent inside an ordinary chat chunk, beside its
 *  `choices`: the AI SDK parses such a chunk as content and drops the error
 *  (kilo sends OpenAI's cyber_policy refusal this way). A bare error chunk is
 *  not one: the SDK raises its own error part for it. */
function inBandProviderError(raw: unknown): Error | null {
  if (!isRecord(raw) || !Array.isArray(raw.choices) || !isRecord(raw.error)) return null;
  const { message, code, statusCode } = raw.error;
  if (typeof message !== "string" || !message) return null;
  const error = new Error(typeof code === "string" && code ? `${message} (${code})` : message) as Error & Record<string, unknown>;
  if (typeof code === "string" && code) error.code = code;
  if (typeof statusCode === "number") error.status = statusCode;
  error.cause = raw.error;
  return error;
}

/** The SDK's error for a call whose arguments did not parse as JSON. */
function isUnreadableInput(error: unknown): boolean {
  return InvalidToolInputError.isInstance(error) && JSONParseError.isInstance(error.cause);
}

function isStreamPart(value: unknown): value is StreamPart {
  return isRecord(value) && typeof value.type === "string";
}

function textDelta(part: StreamPart): string {
  return typeof part.text === "string"
    ? part.text
    : typeof part.delta === "string"
      ? part.delta
      : "";
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
