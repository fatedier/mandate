import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { AgentStore, AgentMessage } from "../../agent/agent-store.js";
import type { FeaturesStore } from "../features-store.js";
import { compactToolValue, limitToolText } from "../../agent/tool-result-format.js";
import {
  compactToolImageResultContent,
  isToolImageResultContent
} from "../../agent/wake-message-adapter.js";

const params = z.object({
  featureId: z.string().min(1),
  limit: z.number().int().positive().max(50).optional()
});

interface Result {
  messages?: Array<ReturnType<typeof serializeMessageForAgent>>;
  error?: string;
}

export interface ReadFeatureThreadDeps {
  agentStore: AgentStore;
  featuresStore: FeaturesStore;
}

export function buildReadFeatureThreadTool(
  deps: ReadFeatureThreadDeps
): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "read_feature_thread",
    description: "Read compact summaries of the last N active feature-thread messages. Default 10, max 50.",
    parameters: params,
    approval: "never",
    handler: async ({ featureId, limit }) => {
      const feature = deps.featuresStore.getById(featureId);
      if (!feature || feature.archivedAt) return { error: `feature not found: ${featureId}` };
      const thread = deps.agentStore.getThreadByScope("worker", featureId);
      if (!thread) return { messages: [] };
      const all = deps.agentStore.getActiveMessages(thread.id);
      const n = limit ?? 10;
      return { messages: all.slice(-n).map(serializeMessageForAgent) };
    }
  };
}

function serializeMessageForAgent(message: AgentMessage) {
  return {
    seq: message.seq,
    role: message.role,
    source: message.source,
    createdAt: message.createdAt,
    content: serializeContent(message.content)
  };
}

function serializeContent(content: AgentMessage["content"]) {
  switch (content.type) {
    case "text": {
      const text = limitToolText(content.text, 3000);
      return {
        type: "text" as const,
        text: text.text,
        ...(text.truncated ? { textTruncated: true } : {}),
        ...(content.attachments?.length ? { attachmentCount: content.attachments.length } : {})
      };
    }
    case "assistant": {
      const text = content.text ? limitToolText(content.text, 3000) : null;
      return {
        type: "assistant" as const,
        ...(text ? { text: text.text, ...(text.truncated ? { textTruncated: true } : {}) } : {}),
        ...(content.toolCalls?.length
          ? {
              toolCalls: content.toolCalls.map((call) => {
                const args = compactToolValue(call.args, 1200);
                return {
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  args: args.text,
                  ...(args.truncated ? { argsTruncated: true } : {})
                };
              })
            }
          : {})
      };
    }
    case "tool_result": {
      const error = content.error ? limitToolText(content.error, 1200) : null;
      const result = content.result === undefined
        ? null
        : compactToolValue(
          isToolImageResultContent(content.result)
            ? compactToolImageResultContent(content.result)
            : content.result,
          3000
        );
      return {
        type: "tool_result" as const,
        toolCallId: content.toolCallId,
        toolName: content.toolName,
        ...(content.isError ? { isError: true } : {}),
        ...(error ? { error: error.text, ...(error.truncated ? { errorTruncated: true } : {}) } : {}),
        ...(result ? { result: result.text, ...(result.truncated ? { resultTruncated: true } : {}) } : {})
      };
    }
    case "summary": {
      const summary = limitToolText(content.summary, 3000);
      return {
        type: "summary" as const,
        summary: summary.text,
        replacedRange: content.replacedRange,
        replacedCount: content.replacedCount,
        ...(summary.truncated ? { summaryTruncated: true } : {})
      };
    }
    case "feature_event": {
      const summary = limitToolText(content.summary, 3000);
      return {
        type: "feature_event" as const,
        kind: content.kind,
        ...("taskId" in content ? { taskId: content.taskId } : {}),
        featureId: content.featureId,
        workItemId: content.workItemId,
        label: content.label,
        summary: summary.text,
        ...(content.kind === "escalation" && content.signal ? { signal: content.signal } : {}),
        ...(content.kind === "limit_reached" ? { stepCount: content.stepCount } : {}),
        ...(content.artifacts?.length ? { artifacts: content.artifacts } : {}),
        ...(summary.truncated ? { summaryTruncated: true } : {})
      };
    }
  }
}
