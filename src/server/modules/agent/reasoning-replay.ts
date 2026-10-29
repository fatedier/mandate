import type { AiSdkAssistantMessage } from "../../../shared/agent-message-types.js";
import { isRecord } from "../../../shared/guards.js";
import { OPEN_RESPONSES_NAME } from "../llm/open-responses-model.js";

type Part = Record<string, unknown>;

/** The provider-options key an OpenAI Responses reasoning part carries, or null. */
function openAiKey(part: unknown): "openai" | "azure" | null {
  if (!isRecord(part) || part.type !== "reasoning" || !isRecord(part.providerOptions)) return null;
  if (isRecord(part.providerOptions.openai)) return "openai";
  if (isRecord(part.providerOptions.azure)) return "azure";
  return null;
}

/**
 * An assistant message as it is kept for replay to the model. Asking for
 * reasoning summaries changed two things about OpenAI reasoning parts; this
 * puts both back as they were before:
 * - each part carried its summary text, which would then be sent back to the
 *   model — blanked (the summary is kept server-side, on the step);
 * - an item streamed as several summary parts became several parts, each with
 *   a copy of the encrypted state (counted again by the context estimate) —
 *   collapsed to one per item, with the newest encrypted state, which is what
 *   the AI SDK's own merge by item id ends with.
 * The Open Responses package keeps a model's raw reasoning both as the part's
 * text and under its own key; the key's copy goes when it is the text again,
 * and the package then reads the text (keptOnce). Other providers' reasoning
 * (Anthropic's signed thinking) is left as it came.
 */
export function forReplay(message: AiSdkAssistantMessage): AiSdkAssistantMessage {
  if (!Array.isArray(message.content)) return message;
  const content: unknown[] = [];
  const byItem = new Map<string, Part>();
  for (const raw of message.content as unknown[]) {
    const key = openAiKey(raw);
    if (!key) { content.push(keptOnce(raw)); continue; }
    const part = raw as Part;
    const options = (part.providerOptions as Record<string, Part>)[key]!;
    const itemId = typeof options.itemId === "string" ? options.itemId : null;
    const kept = itemId ? byItem.get(itemId) : undefined;
    if (kept) {
      if (options.reasoningEncryptedContent != null) {
        (kept.providerOptions as Record<string, Part>)[key]!.reasoningEncryptedContent = options.reasoningEncryptedContent;
      }
      continue;
    }
    const blank: Part = { ...part, text: "", providerOptions: { ...(part.providerOptions as Part), [key]: { ...options } } };
    if (itemId) byItem.set(itemId, blank);
    content.push(blank);
  }
  return { ...message, content } as AiSdkAssistantMessage;
}

/**
 * A raw reasoning part of the Open Responses package with its key's copy of
 * the text dropped when that copy is the part's text, whole, in one piece and
 * not empty:
 * with no copy the package sends the text as the item's reasoning content,
 * the same request. A Chat provider reads only the text, which stays (the
 * same model id on another connection replays it). A part whose copy is
 * null (only a summary came back) keeps it: without it the package would
 * send the text as content.
 */
function keptOnce(part: unknown): unknown {
  // An empty text is not sent as content: its copy is the only way the
  // package sends an empty reasoning content.
  if (!isRecord(part) || part.type !== "reasoning" || typeof part.text !== "string" || part.text === "" || !isRecord(part.providerOptions)) return part;
  const state = part.providerOptions[OPEN_RESPONSES_NAME];
  if (!isRecord(state) || !Array.isArray(state.reasoningContent) || state.reasoningContent.length !== 1) return part;
  const [only] = state.reasoningContent as unknown[];
  if (!isRecord(only) || only.type !== "reasoning_text" || only.text !== part.text) return part;
  const { reasoningContent: _copy, ...rest } = state;
  return { ...part, providerOptions: { ...part.providerOptions, [OPEN_RESPONSES_NAME]: rest } };
}

/** A reply cut off at the output token limit, as it is kept for replay: the
 *  reasoning it ended on has nothing after it — the Responses API refuses a
 *  reasoning item without its following item, Anthropic a thinking block cut
 *  before its signature — so it goes, and a message left empty with it. */
export function withoutTrailingReasoning(messages: readonly AiSdkAssistantMessage[]): AiSdkAssistantMessage[] {
  const kept = [...messages];
  while (kept.length > 0) {
    const last = kept.at(-1)!;
    if (!Array.isArray(last.content)) break;
    const content = [...last.content];
    while (content.length > 0 && isRecord(content.at(-1)) && (content.at(-1) as Part).type === "reasoning") content.pop();
    if (content.length === last.content.length) break;
    if (content.length > 0) {
      kept[kept.length - 1] = { ...last, content };
      break;
    }
    kept.pop();
  }
  return kept;
}
