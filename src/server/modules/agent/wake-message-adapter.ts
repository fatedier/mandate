import { type JSONValue, type ModelMessage } from "ai";
import type { AgentMessage, AgentMessageAttachment } from "./agent-store.js";
import type { ToolImageResultContent } from "../../../shared/agent-message-types.js";
import { limitToolText } from "./tool-result-format.js";
import type { WorkItemRefSnapshot } from "../../../shared/api/work-items.js";
import { featureMessageMetadata } from "../../../shared/feature-message.js";

export const MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS = 20_000;
export const MODEL_VISIBLE_WORK_ITEM_SUMMARY_MAX_CHARS = 800;

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

interface PrepareAiSdkMessageOptions {
  includeImages: boolean;
  includeToolResultImages?: boolean;
  includeProviderState?: boolean;
}

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

  return ordered.flatMap((m) => toAiSdkMessages(m, opts));
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

function runtimeContextKind(message: AgentMessage): "initial" | "update" | null {
  if (message.source !== "runtime-context") return null;
  if (message.content.type !== "text") return "update";
  const explicit = message.content.metadata?.runtimeContextKind;
  if (explicit === "initial" || explicit === "update") return explicit;
  const text = message.content.text.trimStart();
  if (text.startsWith("[initial_context]")) return "initial";
  return "update";
}

export function positiveNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toAiSdkMessages(m: AgentMessage, opts: PrepareAiSdkMessageOptions): ModelMessage[] {
  const c = m.content;

  if (m.role === "user") {
    if (c.type === "summary") {
      return [{ role: "user", content: `[Compressed conversation summary]\n${c.summary}` }];
    }
    if (c.type === "text") {
      if (m.source === "feature-message") {
        const metadata = featureMessageMetadata(c);
        const sender = metadata?.featureName || metadata?.featureId || "worker";
        return [{
          role: "user",
          content: `[Worker message from ${sender}]\n${formatUserTextForModel(c)}`
        }];
      }
      if ((c.attachments?.length ?? 0) > 0) {
        return [{ role: "user", content: textContentToUserParts(c, opts.includeImages) }];
      }
      return [{ role: "user", content: formatUserTextForModel(c) }];
    }
    if (c.type === "feature_event") {
      return [{
        role: "user",
        content: [{
          type: "text",
          text: formatFeatureEventForModel(c)
        }]
      }];
    }
    return [{ role: "user", content: "" }];
  }

  if (m.role === "assistant") {
    if (c.type !== "assistant") return [{ role: "assistant", content: "" }];
    if (opts.includeProviderState !== false && c.sdkAssistantMessages?.length) {
      return c.sdkAssistantMessages;
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
    return [{ role: "assistant", content: parts.length > 0 ? parts : "" }];
  }

  if (m.role === "tool" && c.type === "tool_result") {
    return [{
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        output: toToolResultOutput(c, opts)
      }]
    }];
  }

  return [{ role: "user", content: "" }];
}

function formatFeatureEventForModel(
  content: Extract<AgentMessage["content"], { type: "feature_event" }>
): string {
  const header = content.kind === "completion"
    ? `[feature_event] ${content.label} (completion): ${content.summary}`
    : content.kind === "limit_reached"
      ? `[feature_event] ${content.label} (limit_reached, stepCount=${content.stepCount}): ${content.summary}`
      : `[feature_event] ${content.label} (escalation, signal=${content.signal ?? "blocked"}): ${content.summary}`;
  const lines = [header];
  if (content.artifacts?.length) {
    lines.push("", "Artifacts:");
    for (const artifact of content.artifacts) {
      if (artifact.type === "canvas") {
        const role = artifact.role ? `, role=${artifact.role}` : "";
        lines.push(`- canvas: ${artifact.title} (${artifact.path}, canvasId=${artifact.canvasId}${role})`);
      }
    }
  }
  return lines.join("\n");
}

function toToolResultOutput(
  content: Extract<AgentMessage["content"], { type: "tool_result" }>,
  opts: PrepareAiSdkMessageOptions
): ToolResultOutput {
  if (content.isError) return { type: "error-text", value: limitModelVisibleToolText(content.error ?? "error") };
  if (isToolImageResultContent(content.result)) {
    return toolImageResultToOutput(content.result, opts.includeToolResultImages ?? opts.includeImages);
  }
  return toSuccessToolResultOutput(content.result);
}

function toolImageResultToOutput(result: ToolImageResultContent, includeImages: boolean): ToolResultOutput {
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
        data: { type: "data", data: result.image.data },
        mediaType: result.image.mediaType,
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

function textContentToUserParts(
  content: Extract<AgentMessage["content"], { type: "text" }>,
  includeImages: boolean
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
      data: { type: "data", data: attachment.data },
      mediaType: attachment.mediaType,
      ...(attachment.name ? { filename: attachment.name } : {})
    });
  }
  return parts;
}

function formatUserTextForModel(content: Extract<AgentMessage["content"], { type: "text" }>): string {
  const ref = parseWorkItemRefSnapshot(content.metadata?.workItemRef);
  if (!ref) return content.text;

  const lines = [
    "[Attached work item]",
    "The user message below refers to this work item unless explicitly stated otherwise.",
    `id: ${ref.itemId}`
  ];
  if (ref.title) lines.push(`title: ${ref.title}`);
  if (ref.projectId) lines.push(`projectId: ${ref.projectId}`);
  if (ref.featureId) lines.push(`featureId: ${ref.featureId}`);
  if (ref.phase) lines.push(`phase: ${formatNullableDetail(ref.phase, ref.phaseDetail)}`);
  if (ref.needsUser !== undefined) lines.push(`needsUser: ${ref.needsUser ?? "none"}`);
  const summary = typeof ref.summary === "string" ? ref.summary.trim() : "";
  if (summary) {
    lines.push(`summary: ${limitToolText(summary, MODEL_VISIBLE_WORK_ITEM_SUMMARY_MAX_CHARS).text}`);
  }
  lines.push(`snapshotAt: ${ref.snapshotAt}`);

  const text = content.text.trim();
  if (text) {
    lines.push("", "User message:", text);
  }
  return lines.join("\n");
}

function parseWorkItemRefSnapshot(value: unknown): WorkItemRefSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const itemId = typeof record.itemId === "string" ? record.itemId.trim() : "";
  const snapshotAt = typeof record.snapshotAt === "string" ? record.snapshotAt.trim() : "";
  if (!itemId || !snapshotAt) return null;
  return {
    itemId,
    snapshotAt,
    title: optionalString(record.title),
    summary: optionalNullableString(record.summary),
    projectId: optionalString(record.projectId),
    featureId: optionalString(record.featureId),
    needsUser: record.needsUser === "review" || record.needsUser === "input" || record.needsUser === null
      ? record.needsUser
      : undefined,
    phase: isWorkItemPhase(record.phase) ? record.phase : undefined,
    phaseDetail: optionalNullableString(record.phaseDetail)
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalString(value);
}

function isWorkItemPhase(value: unknown): value is NonNullable<WorkItemRefSnapshot["phase"]> {
  return value === "design" ||
    value === "working" ||
    value === "verifying" ||
    value === "done";
}

function formatNullableDetail(value: string, detail: string | null | undefined): string {
  return detail ? `${value} (${detail})` : value;
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
