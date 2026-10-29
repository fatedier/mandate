import { type JSONValue, type ModelMessage, type ToolResultPart } from "ai";
import { formatAgentTime } from "../../platform/time/agent-time.js";
import type { AgentMessage, AgentMessageAttachment } from "./agent-store.js";
import type { AssistantContent, ToolImageResultContent } from "../../../shared/agent-message-types.js";
import { limitToolText } from "./tool-result-format.js";
import { featureMessageMetadata } from "../../../shared/feature-message.js";
import { subagentTaskOf } from "../../../shared/subagent-task.js";
import { answersOf, questionInOneLine, writtenBeforeOf } from "../../../shared/questions.js";
import { mentionsOf } from "../../../shared/mentions.js";
import { mentionModelLines } from "./mentions.js";
import { runtimeContextKind } from "./wake-runtime-context.js";
import { isRecord } from "../../../shared/guards.js";

/** What the model is given of one tool result inline. A longer one is saved
 *  to a file at the call (tool-output-spool.ts), so this cut, made at every
 *  rebuild, only reaches results stored before that. */
export const MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS = 30_000;

type ToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JSONValue }
  | {
      type: "content";
      value: Array<
        | { type: "text"; text: string }
        | { type: "file"; data: { type: "data"; data: string }; mediaType: string; filename?: string }
      >;
    }
  | { type: "error-text"; value: string };

/** What of a model's earlier steps the receiving model gets back. */
export interface ReplayTarget {
  includeProviderState?: boolean;
  /** The model id the history goes to: a step's stored provider state
   *  (reasoning items, encrypted content, signatures) is replayed only when
   *  that model wrote it, whatever the provider; any other model, and a step
   *  that does not say who wrote it, gets the visible step. Unset: as stored. */
  replayTo?: string;
  /** The receiving model's id, when it needs its reasoning back on every
   *  step (needsReasoningPlaceholder): a step not replayed with its provider
   *  state and written by another model (or not saying who wrote it) opens
   *  with a one-space reasoning part. Its own steps never do. */
  reasoningPlaceholderFor?: string;
  /** The provider-options key the receiving package reads a step's stored
   *  state under (the Open Responses package's name). A step stored on
   *  @ai-sdk/openai keeps its item ids and encrypted reasoning under
   *  `openai`; replayed, they are copied under this key, where it has none. */
  providerStateKey?: string;
}

interface PrepareAiSdkMessageOptions extends ReplayTarget {
  includeImages: boolean;
  /** What to send in an image's place, told by the image and the message it
   *  is in (one made small enough for a model, model-images.ts); null, or
   *  unset, sends it as stored. */
  imageForModel?: (image: { id: string; data: string; mediaType: string }, messageId: string) => { data: string; mediaType: string } | null;
  includeToolResultImages?: boolean;
  /** The zone the model reads times in: each incoming message opens with the
   *  time it arrived, and a tool result that finished long after the last
   *  time shown ends with its own. Unset: no times. */
  timeZone?: string;
}

/** How long after the last time shown a tool result shows its own. */
export const TOOL_RESULT_TIME_GAP_MS = 5 * 60_000;

export function prepareAiSdkMessages(
  active: AgentMessage[],
  opts: PrepareAiSdkMessageOptions
): ModelMessage[] {
  const nonSystem = modelVisibleContextMessages(active.filter((m) => m.role !== "system"));
  const resultByCallId = new Map<string, AgentMessage>();
  for (const m of nonSystem) {
    if (m.role !== "tool" || m.content.type !== "tool_result") continue;
    if (!resultByCallId.has(m.content.toolCallId)) {
      resultByCallId.set(m.content.toolCallId, m);
    }
  }

  const consumedToolResultIds = new Set<string>();
  const ordered: AgentMessage[] = [];
  for (const m of nonSystem) {
    if (m.role === "tool" && m.content.type === "tool_result") {
      if (consumedToolResultIds.has(m.id)) continue;
      continue;
    }

    if (m.role === "assistant" && m.content.type === "assistant" && (m.content.toolCalls?.length ?? 0) > 0) {
      const resultMessages: AgentMessage[] = [];
      let hasEveryResult = true;
      for (const tc of m.content.toolCalls ?? []) {
        const result = resultByCallId.get(tc.toolCallId);
        if (!result) {
          hasEveryResult = false;
          break;
        }
        resultMessages.push(result);
      }

      if (!hasEveryResult) {
        const text = m.content.text?.trim();
        if (text) {
          ordered.push({
            ...m,
            content: { type: "assistant", text }
          });
        }
        continue;
      }

      ordered.push(m);
      for (const result of resultMessages) {
        ordered.push(result);
        consumedToolResultIds.add(result.id);
      }
      continue;
    }

    ordered.push(m);
  }

  const timeZone = opts.timeZone;
  if (!timeZone) return ordered.flatMap((m) => toAiSdkMessages(m, opts));
  // Every time comes from what is stored, so a history reads the same each
  // time it is built and its prompt cache holds.
  let lastShownMs: number | null = null;
  return ordered.flatMap((m) => {
    const prepared = toAiSdkMessages(m, opts);
    const shownMs = timeShownOn(m, lastShownMs);
    const label = shownMs === null ? null : formatAgentTime(shownMs, timeZone);
    if (shownMs === null || label === null) return prepared;
    lastShownMs = lastShownMs === null ? shownMs : Math.max(lastShownMs, shownMs);
    return prepared.map((message) => withTime(message, `[${label}]`));
  });
}

/** The time a message shows the model, or null for none: an incoming
 *  message its arrival (runtime context and summaries none), a tool result
 *  its own when it finished long after the last time shown. */
function timeShownOn(m: AgentMessage, lastShownMs: number | null): number | null {
  const c = m.content;
  if (m.role === "user" && c.type === "text" && runtimeContextKind(m) === null) {
    const at = Date.parse(c.arrivedAt ?? m.createdAt);
    return Number.isFinite(at) ? at : null;
  }
  if (m.role === "tool" && c.type === "tool_result") {
    const at = Date.parse(m.createdAt);
    if (!Number.isFinite(at)) return null;
    return lastShownMs === null || at - lastShownMs >= TOOL_RESULT_TIME_GAP_MS ? at : null;
  }
  return null;
}

/** An incoming message opens with its time; a tool result ends with it. */
function withTime(message: ModelMessage, stamp: string): ModelMessage {
  if (message.role === "user") {
    if (typeof message.content === "string") return { ...message, content: `${stamp}\n${message.content}` };
    const [first, ...rest] = message.content;
    return first?.type === "text"
      ? { ...message, content: [{ ...first, text: `${stamp}\n${first.text}` }, ...rest] }
      : { ...message, content: [{ type: "text", text: stamp }, ...message.content] };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: message.content.map((part) => part.type === "tool-result" ? { ...part, output: outputWithTime(part.output, stamp) } : part)
    };
  }
  return message;
}

function outputWithTime(output: ToolResultPart["output"], stamp: string): ToolResultPart["output"] {
  switch (output.type) {
    case "text":
    case "error-text":
      return { ...output, value: `${output.value}\n\n${stamp}` };
    case "json":
      return { type: "text", value: `${JSON.stringify(output.value)}\n\n${stamp}` };
    case "content":
      return { ...output, value: [...output.value, { type: "text", text: stamp }] };
    default:
      return output;
  }
}

function modelVisibleContextMessages(messages: AgentMessage[]): AgentMessage[] {
  const keepContextIndexes = new Set<number>();
  let latestInitialIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    if (runtimeContextKind(messages[i]!) === "initial") {
      latestInitialIndex = i;
    }
  }

  if (latestInitialIndex >= 0) keepContextIndexes.add(latestInitialIndex);

  const runtimeWindowStart = latestInitialIndex >= 0 ? latestInitialIndex + 1 : 0;
  for (let i = runtimeWindowStart; i < messages.length; i++) {
    if (runtimeContextKind(messages[i]!) === "update") keepContextIndexes.add(i);
  }

  return messages.filter((message, index) => {
    if (runtimeContextKind(message) === null) return true;
    return keepContextIndexes.has(index);
  });
}

/** A message the user's agent wrote for them says so to the model, as the
 *  page's "via <name>" label says it to a person. */
function relayLine(content: Extract<AgentMessage["content"], { type: "text" }>): string {
  if (!content.relay) return "";
  return content.relay.name ? `[via ${content.relay.name}, the user's agent]\n` : "[via the user's agent]\n";
}

function toAiSdkMessages(m: AgentMessage, opts: PrepareAiSdkMessageOptions): ModelMessage[] {
  const c = m.content;

  if (m.role === "user") {
    if (c.type === "summary") {
      return [{ role: "user", content: `[Compressed conversation summary]\n${c.summary}` }];
    }
    if (c.type === "text") {
      // A subagent's task is headed by who handed it over, as a worker's
      // message is by its worker.
      const subagentTask = m.source === "subagent-task" ? subagentTaskOf(c) : null;
      if (subagentTask) {
        const where = subagentTask.workingDir ? `Working directory: ${subagentTask.workingDir}.\n` : "";
        return [{ role: "user", content: `[Task from ${subagentTask.askedBy}]\n${where}${formatUserTextForModel(c)}` }];
      }
      if (m.source === "feature-message") {
        const metadata = featureMessageMetadata(c);
        // A note of what the user told a worker says so itself.
        if (metadata?.direction === "note") return [{ role: "user", content: formatUserTextForModel(c) }];
        const sender = metadata?.featureName || metadata?.featureId || "worker";
        return [{
          role: "user",
          content: `[Worker message from ${sender}]\n${formatUserTextForModel(c)}`
        }];
      }
      if ((c.attachments?.length ?? 0) > 0) {
        return [{ role: "user", content: textContentToUserParts(c, opts.includeImages, imagesOf(opts, m.id)) }];
      }
      return [{ role: "user", content: relayLine(c) + formatUserTextForModel(c) }];
    }
    return [{ role: "user", content: "" }];
  }

  if (m.role === "assistant") {
    if (c.type !== "assistant") return [{ role: "assistant", content: "" }];
    return assistantMessagesForModel(c, opts);
  }

  if (m.role === "tool" && c.type === "tool_result") {
    return [{
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        output: toToolResultOutput(c, opts, m.id)
      }]
    }];
  }

  return [{ role: "user", content: "" }];
}

/** A model's step as the receiving model takes it back: the step's stored
 *  provider state when that model wrote it, else its text and tool calls
 *  (with a reasoning placeholder for a model that needs one). The agent's
 *  wakes and the memory dream both replay steps this way. */
export function assistantMessagesForModel(
  c: Pick<AssistantContent, "text" | "toolCalls" | "sdkAssistantMessages" | "writtenBy">,
  target: ReplayTarget
): ModelMessage[] {
  const sameModel = target.replayTo === undefined || c.writtenBy?.model === target.replayTo;
  if (target.includeProviderState !== false && sameModel && c.sdkAssistantMessages?.length) {
    const key = target.providerStateKey;
    return key ? c.sdkAssistantMessages.map((message) => withOpenAiStateUnder(message, key)) : c.sdkAssistantMessages;
  }
  const parts: NonNullable<Extract<ModelMessage, { role: "assistant" }>["content"]> extends infer Content
    ? Content extends unknown[] ? Content : never
    : never = [];
  if (c.text) parts.push({ type: "text", text: c.text });
  for (const tc of c.toolCalls ?? []) {
    parts.push({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.args
    });
  }
  if (parts.length > 0 && target.reasoningPlaceholderFor !== undefined && c.writtenBy?.model !== target.reasoningPlaceholderFor) {
    parts.unshift({ type: "reasoning", text: " " });
  }
  return [{ role: "assistant", content: parts.length > 0 ? parts : "" }];
}

/** A stored step's parts with the item id and encrypted reasoning they keep
 *  under `openai` copied under `key`, on a part that has nothing there. */
function withOpenAiStateUnder(message: ModelMessage, key: string): ModelMessage {
  if (message.role !== "assistant" || typeof message.content === "string") return message;
  return {
    ...message,
    content: message.content.map((part) => {
      if (!("providerOptions" in part)) return part;
      const options = part.providerOptions;
      const stored = options?.openai;
      if (!options || !isRecord(stored) || options[key] !== undefined) return part;
      const state = Object.fromEntries(
        (["itemId", "reasoningEncryptedContent"] as const)
          .filter((field) => typeof stored[field] === "string")
          .map((field) => [field, stored[field] as string])
      );
      return Object.keys(state).length ? { ...part, providerOptions: { ...options, [key]: state } } : part;
    })
  };
}

type SendImage = (image: { id: string; data: string; mediaType: string }) => { data: string; mediaType: string } | null;

/** The images of one message as sent: imageForModel, told which message. */
function imagesOf(opts: PrepareAiSdkMessageOptions, messageId: string): SendImage | undefined {
  const imageForModel = opts.imageForModel;
  return imageForModel ? (image) => imageForModel(image, messageId) : undefined;
}

function toToolResultOutput(
  content: Extract<AgentMessage["content"], { type: "tool_result" }>,
  opts: PrepareAiSdkMessageOptions,
  messageId: string
): ToolResultOutput {
  if (content.isError) return { type: "error-text", value: limitModelVisibleToolText(content.error ?? "error") };
  if (isToolImageResultContent(content.result)) {
    return toolImageResultToOutput(content.result, opts.includeToolResultImages ?? opts.includeImages, imagesOf(opts, messageId));
  }
  return toSuccessToolResultOutput(content.result);
}

function toolImageResultToOutput(
  result: ToolImageResultContent,
  includeImages: boolean,
  imageForModel: SendImage | undefined
): ToolResultOutput {
  if (!includeImages) {
    return {
      type: "text",
      value: `[Image from view_image omitted because the current model path does not support image tool-result input: ${formatToolImageLabel(result)}]`
    };
  }
  return {
    type: "content",
    value: [
      { type: "text", text: result.message },
      {
        type: "file",
        ...sentImage(result.image, imageForModel),
        filename: result.image.name
      }
    ]
  };
}

export function compactToolImageResultContent(result: ToolImageResultContent): ToolImageResultContent {
  return {
    type: result.type,
    message: result.message,
    image: {
      type: result.image.type,
      id: result.image.id,
      name: result.image.name,
      displayPath: result.image.displayPath,
      mediaType: result.image.mediaType,
      sizeBytes: result.image.sizeBytes,
      data: `[omitted ${result.image.sizeBytes} byte image]`
    }
  };
}

function formatToolImageLabel(result: ToolImageResultContent): string {
  return [result.image.displayPath || result.image.name, result.image.mediaType, `${result.image.sizeBytes} bytes`]
    .filter(Boolean)
    .join(" ");
}

function toSuccessToolResultOutput(value: unknown): ToolResultOutput {
  if (typeof value === "string") return { type: "text", value: limitModelVisibleToolText(value) };
  if (value === undefined) return { type: "text", value: "" };
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return { type: "text", value: "" };
  if (serialized.length > MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS) {
    return { type: "text", value: limitModelVisibleToolText(serialized) };
  }
  return { type: "json", value: JSON.parse(serialized) as JSONValue };
}

function limitModelVisibleToolText(value: string): string {
  return limitToolText(value, MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS).text;
}

/** An image's bytes as sent: the fitted copy when there is one. */
function sentImage(
  image: { id: string; data: string; mediaType: string },
  imageForModel: SendImage | undefined
): { data: { type: "data"; data: string }; mediaType: string } {
  const fitted = imageForModel?.(image) ?? null;
  return { data: { type: "data", data: fitted?.data ?? image.data }, mediaType: fitted?.mediaType ?? image.mediaType };
}

function textContentToUserParts(
  content: Extract<AgentMessage["content"], { type: "text" }>,
  includeImages: boolean,
  imageForModel?: SendImage
): NonNullable<Extract<ModelMessage, { role: "user" }>["content"]> extends infer Content
  ? Content extends unknown[] ? Content : never
  : never {
  const parts: NonNullable<Extract<ModelMessage, { role: "user" }>["content"]> extends infer Content
    ? Content extends unknown[] ? Content : never
    : never = [];
  const text = formatUserTextForModel(content).trim();
  if (text) parts.push({ type: "text", text });

  const attachments = content.attachments ?? [];
  if (!includeImages) {
    parts.push({
      type: "text",
      text: `[Image attachments omitted because the current model does not support image input: ${attachments.map(formatAttachmentLabel).join(", ")}]`
    });
    return parts;
  }

  for (const attachment of attachments) {
    if (attachment.type !== "image") continue;
    parts.push({
      type: "file",
      ...sentImage(attachment, imageForModel),
      ...(attachment.name ? { filename: attachment.name } : {})
    });
  }
  return parts;
}

/** A message sent by picking a suggested answer names the question it
 *  answers: the pick's words alone ("Now", "Yes") do not say which of two
 *  open questions they are for. */
function answerLines(content: Extract<AgentMessage["content"], { type: "text" }>): string {
  return answersOf(content).map((answer) => {
    const shown = questionInOneLine(answer.question);
    return shown ? `[Answer to your question "${shown}"]\n` : "[Answer to your question]\n";
  }).join("");
}

/** A message that waited behind the asker's running turn landed after a
 *  question it was written before: the asker reads the user's words right
 *  after its question, and is told they are not the answer to it. */
function writtenBeforeLines(content: Extract<AgentMessage["content"], { type: "text" }>): string {
  return writtenBeforeOf(content).map((asked) => {
    const shown = questionInOneLine(asked.question);
    return shown ? `[Written before you asked "${shown}"; it does not answer that]\n` : "";
  }).join("");
}

function formatUserTextForModel(content: Extract<AgentMessage["content"], { type: "text" }>): string {
  return answerLines(content) + writtenBeforeLines(content) + mentionModelLines(mentionsOf(content)) + content.text;
}

function formatAttachmentLabel(attachment: AgentMessageAttachment): string {
  const name = attachment.name?.trim();
  const size = Number.isFinite(attachment.sizeBytes) ? `${attachment.sizeBytes} bytes` : "unknown size";
  return [name || attachment.id, attachment.mediaType, size].filter(Boolean).join(" ");
}

export function isToolImageResultContent(value: unknown): value is ToolImageResultContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "view_image_result") return false;
  if (typeof record.message !== "string") return false;
  const image = record.image;
  if (!image || typeof image !== "object" || Array.isArray(image)) return false;
  const img = image as Record<string, unknown>;
  return img.type === "image" &&
    typeof img.id === "string" &&
    typeof img.name === "string" &&
    typeof img.displayPath === "string" &&
    typeof img.mediaType === "string" &&
    typeof img.data === "string" &&
    typeof img.sizeBytes === "number";
}
