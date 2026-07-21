import type { AgentMessage, AgentStore } from "../modules/agent/agent-store.js";
import { isToolImageResultContent } from "../modules/agent/wake-message-adapter.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { MemoryExtractionSource } from "../modules/memory/extraction.js";
import type { ProjectsStore } from "../modules/projects/projects-store.js";

export function buildCompressionMemorySource(
  threadId: string,
  summaryMessage: AgentMessage,
  deps: {
    agentStore: AgentStore;
    projectsStore: ProjectsStore;
    featuresStore: FeaturesStore;
  }
): MemoryExtractionSource | null {
  try {
    const thread = deps.agentStore.getThreadById(threadId);
    if (!thread || thread.kind === "side") return null;
    const feature = thread.scope === "worker" && thread.scopeId
      ? deps.featuresStore.getById(thread.scopeId)
      : null;
    const project = feature
      ? deps.projectsStore.getById(feature.projectId)
      : null;
    const content = compressionSummaryContent(summaryMessage);
    if (!content) return null;
    return {
      scope: feature ? "feature" : project ? "project" : "global",
      projectId: feature?.projectId ?? project?.id ?? null,
      featureId: feature?.id ?? null,
      threadId,
      messageIds: [summaryMessage.id],
      summaryMessageId: summaryMessage.id,
      content,
      metadata: {
        sourceKind: "compressionSummary",
        replacedRange: summaryMessage.content.type === "summary"
          ? summaryMessage.content.replacedRange
          : null,
        replacedCount: summaryMessage.content.type === "summary"
          ? summaryMessage.content.replacedCount
          : null
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mandate] memory compression source build failed: ${msg}`);
    return null;
  }
}

export function buildNewChatMemorySource(
  threadId: string,
  deps: {
    agentStore: AgentStore;
    projectsStore: ProjectsStore;
    featuresStore: FeaturesStore;
  }
): MemoryExtractionSource | null {
  try {
    const thread = deps.agentStore.getThreadById(threadId);
    if (!thread || thread.kind === "side") return null;
    const feature = thread.scope === "worker" && thread.scopeId
      ? deps.featuresStore.getById(thread.scopeId)
      : null;
    const project = feature
      ? deps.projectsStore.getById(feature.projectId)
      : null;
    const messages = deps.agentStore.getActiveMessages(threadId);
    if (messages.length === 0) return null;
    const content = newChatContent(messages);
    if (!content) return null;
    return {
      scope: feature ? "feature" : project ? "project" : "global",
      projectId: feature?.projectId ?? project?.id ?? null,
      featureId: feature?.id ?? null,
      threadId,
      messageIds: messages.map((message) => message.id),
      content,
      metadata: {
        sourceKind: "newChatArchive"
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mandate] memory new-chat source build failed: ${msg}`);
    return null;
  }
}

export function buildFeatureArchiveMemorySource(
  featureId: string,
  deps: {
    agentStore: AgentStore;
    projectsStore: ProjectsStore;
    featuresStore: FeaturesStore;
  }
): MemoryExtractionSource | null {
  try {
    const feature = deps.featuresStore.getById(featureId);
    if (!feature) return null;
    const project = deps.projectsStore.getById(feature.projectId);
    const thread = deps.agentStore.getThreadByScope("worker", featureId);
    if (!thread) return null;
    const messages = deps.agentStore.getActiveMessages(thread.id);
    if (messages.length === 0) return null;
    const content = featureArchiveContent(feature, messages);
    if (!content) return null;
    return {
      scope: "feature",
      projectId: feature.projectId,
      featureId: feature.id,
      threadId: thread.id,
      messageIds: messages.map((message) => message.id),
      content,
      metadata: {
        sourceKind: "featureArchive",
        featureName: feature.name,
        projectName: project?.name ?? null
      }
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mandate] memory feature-archive source build failed: ${msg}`);
    return null;
  }
}

function compressionSummaryContent(message: AgentMessage): string {
  if (message.content.type !== "summary") return "";
  const summary = message.content.summary.trim();
  if (!summary) return "";
  return `Compressed conversation summary:\n${summary}`;
}

function newChatContent(messages: AgentMessage[]): string {
  const lines = messages
    .map(formatNewChatArchiveMessage)
    .filter(Boolean);
  if (lines.length === 0) return "";
  return [
    "New chat archive transcript. The user intentionally started a fresh conversation after this thread.",
    "Extract durable preferences, decisions, project facts, or lessons only if they should help future sessions.",
    lines.join("\n")
  ].join("\n");
}

function featureArchiveContent(
  feature: { name: string; mode: string; branch: string | null; worktreePath: string | null },
  messages: AgentMessage[]
): string {
  const lines = messages
    .map(formatNewChatArchiveMessage)
    .filter(Boolean);
  if (lines.length === 0) return "";
  return [
    "Feature archive transcript. The user or manager is closing this feature.",
    "Extract durable preferences, decisions, project facts, or lessons only if they should help future sessions after this feature is gone.",
    `Feature: ${feature.name}`,
    `Mode: ${feature.mode}`,
    feature.branch ? `Branch: ${feature.branch}` : "",
    feature.worktreePath ? `Worktree: ${feature.worktreePath}` : "",
    lines.join("\n")
  ].filter(Boolean).join("\n");
}

function formatNewChatArchiveMessage(message: AgentMessage): string {
  if (message.content.type === "summary") {
    return compactLine(`${message.role}/${message.source}`, `summary: ${message.content.summary}`);
  }
  return formatTaskCompletionMessage(message);
}

function formatTaskCompletionMessage(message: AgentMessage): string {
  const role = `${message.role}/${message.source}`;
  switch (message.content.type) {
    case "text":
      return compactLine(role, message.content.text);
    case "assistant": {
      const text = message.content.text?.trim() ?? "";
      const tools = message.content.toolCalls?.map((call) => call.toolName).join(", ") ?? "";
      return compactLine(role, [text, tools ? `tool calls: ${tools}` : ""].filter(Boolean).join("; "));
    }
    case "tool_result":
      return compactLine(role, `${message.content.toolName}: ${formatToolResultForArchive(message.content)}`);
    case "feature_event":
      return compactLine(role, `${message.content.label} ${message.content.kind}: ${message.content.summary}`);
    case "summary":
      return "";
  }
}

function formatToolResultForArchive(content: Extract<AgentMessage["content"], { type: "tool_result" }>): string {
  if (content.isError) return content.error ?? "error";
  if (isToolImageResultContent(content.result)) {
    return `${content.result.message} (${content.result.image.mediaType}, ${content.result.image.sizeBytes} bytes)`;
  }
  return JSON.stringify(content.result ?? null);
}

function compactLine(role: string, text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  const max = 1200;
  const clipped = normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
  return `- [${role}] ${clipped}`;
}
