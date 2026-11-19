import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { formatErrorMessage } from "../../platform/errors.js";
import { isRecord } from "../../../shared/guards.js";

type ContentEnd = Extract<LanguageModelV4StreamPart, { type: "text-end" | "reasoning-end" }>;

/** Keep Codex terminal facts that the general Responses SDK does not expose. */
export function codexResponsesStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
  signal?: AbortSignal,
  includeRawChunks = false
): ReadableStream<LanguageModelV4StreamPart> {
  let terminalType: string | undefined;
  let endTurn: boolean | undefined;
  // Terminal output may supply encrypted reasoning or phase that was absent
  // from item.done. Keep end metadata open until that authoritative event;
  // deltas still stream immediately and content retains its original order.
  const pendingEnds = new Map<string, ContentEnd>();
  const pendingToolCalls = new Set<number>();

  return stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
    transform(part, controller) {
      if (part.type === "raw") {
        const event = part.rawValue;
        if (isRecord(event) && isRecord(event.item) && event.item.type === "function_call"
          && typeof event.output_index === "number") {
          // Match the SDK's assembly key: relays may rewrite item.id on done.
          if (event.type === "response.output_item.added") pendingToolCalls.add(event.output_index);
          if (event.type === "response.output_item.done") pendingToolCalls.delete(event.output_index);
        }
        if (isRecord(event) && isRecord(event.response)) {
          if (event.type === "response.completed" || event.type === "response.incomplete"
            || event.type === "response.failed") {
            terminalType = event.type;
            endTurn = event.type === "response.completed" && typeof event.response.end_turn === "boolean"
              ? event.response.end_turn : undefined;
            const output: unknown[] = Array.isArray(event.response.output) ? event.response.output : [];
            for (const end of pendingEnds.values()) controller.enqueue(withTerminalItem(end, output));
            pendingEnds.clear();
          }
        }
        if (includeRawChunks) controller.enqueue(part);
        return;
      }
      if (part.type === "text-start" || part.type === "reasoning-start") {
        const type = part.type === "text-start" ? "text-end" : "reasoning-end";
        pendingEnds.set(`${type}:${part.id}`, { type, id: part.id, providerMetadata: part.providerMetadata });
      }
      if (part.type === "text-end" || part.type === "reasoning-end") {
        pendingEnds.set(`${part.type}:${part.id}`, part);
        return;
      }
      if (part.type === "error") {
        throw part.error instanceof Error ? part.error
          : new Error(formatErrorMessage(part.error, "Codex Responses stream failed."), { cause: part.error });
      }
      if (part.type === "finish") {
        signal?.throwIfAborted();
        const failure = finishFailure(pendingToolCalls.size, terminalType, part.finishReason.unified);
        if (failure) throw new Error(failure);
        if (endTurn !== undefined) {
          part = {
            ...part,
            providerMetadata: {
              ...part.providerMetadata,
              codex: { ...part.providerMetadata?.codex, endTurn }
            }
          };
        }
      }
      controller.enqueue(part);
    }
  }));
}

/** An end part with what the terminal response says of its item: a reasoning
 *  item's encrypted content, a text item's phase. Unchanged otherwise. */
function withTerminalItem(end: ContentEnd, output: unknown[]): ContentEnd {
  const metadata = end.providerMetadata?.openai;
  const itemId = metadata?.itemId ?? end.id;
  const item = output.find(item => isRecord(item) && item.id === itemId);
  if (!isRecord(item)) return end;
  const extra = end.type === "reasoning-end" && typeof item.encrypted_content === "string"
    ? { reasoningEncryptedContent: item.encrypted_content }
    : end.type === "text-end" && (item.phase === "commentary" || item.phase === "final_answer")
      ? { phase: item.phase }
      : undefined;
  return extra ? {
    ...end,
    providerMetadata: { ...end.providerMetadata, openai: { ...metadata, ...extra } }
  } : end;
}

/** Why a finished stream is not a usable response, or null when it is. A
 *  reply cut off at the output token limit is one: the call it was writing
 *  never finished, and the turn says so to the model. */
function finishFailure(pendingToolCalls: number, terminalType: string | undefined, finishReason: string): string | null {
  const cutOff = terminalType === "response.incomplete" && finishReason === "length";
  if (pendingToolCalls > 0 && !cutOff) return "Codex Responses stream ended with unresolved tool calls.";
  if (!terminalType) return "Codex Responses stream ended before a terminal response event.";
  if (terminalType === "response.failed" || finishReason === "error" || finishReason === "content-filter") {
    return "Codex Responses stream failed.";
  }
  return null;
}
