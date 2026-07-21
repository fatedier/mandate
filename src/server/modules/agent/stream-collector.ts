import type { ToolCall } from "./agent-store.js";
import { formatErrorMessage } from "../../platform/errors.js";

interface StreamCollectorResult {
  text: string;
  toolCalls: ToolCall[];
  /** A completed Codex response may request another sampling step. */
  endTurn?: boolean;
  /** Normalized to Mandate's legacy prompt/completion names so callers don't
   *  have to handle multiple AI SDK usage shapes downstream.
   *  inputTokenDetails / outputTokenDetails are passed through verbatim so
   *  llm-call-logging can persist cache + reasoning tokens. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    inputTokenDetails?: unknown;
    outputTokenDetails?: unknown;
  };
}

interface CollectStreamOptions {
  /** Called for every text-delta with both the incremental delta and the
   *  running total so far. Lets the caller stream text to clients without
   *  re-stitching state inside the loop. */
  onTextDelta?: (delta: string, totalText: string) => void;
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
 *  records the failure. Stream event types Mandate doesn't consume (start,
 *  text-start/end, tool-input-*, reasoning, file, source, etc.) are ignored.
 *  Provider continuation state is preserved via AI SDK response messages. */
export async function collectStream(
  fullStream: AsyncIterable<unknown>,
  options: CollectStreamOptions = {}
): Promise<StreamCollectorResult> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  let rawUsage: unknown = null;
  let sawFinish = false;
  let endTurn: boolean | undefined;

  for await (const rawPart of fullStream) {
    if (!isStreamPart(rawPart)) continue;
    const part = rawPart;
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
      case "tool-call": {
        toolCalls.push({
          toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : "",
          toolName: typeof part.toolName === "string" ? part.toolName : "",
          args: part.input ?? {}
        });
        break;
      }
      case "finish-step": {
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

  // AI SDK reports inputTokens/outputTokens; older collector consumers still
  // expect promptTokens/completionTokens. Also pass through
  // inputTokenDetails / outputTokenDetails so the llm-call recorder can persist
  // cache + reasoning tokens — extractUsage pulls them from those nested fields.
  const u = isRecord(rawUsage) ? rawUsage : {};
  return {
    text,
    toolCalls,
    ...(endTurn !== undefined ? { endTurn } : {}),
    usage: {
      promptTokens: numberOrZero(u.inputTokens ?? u.promptTokens),
      completionTokens: numberOrZero(u.outputTokens ?? u.completionTokens),
      inputTokenDetails: u.inputTokenDetails,
      outputTokenDetails: u.outputTokenDetails
    }
  };
}

function isStreamPart(value: unknown): value is StreamPart {
  return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
