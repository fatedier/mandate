import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { AgentStore, AgentMessage } from "../../agent/agent-store.js";
import type { FeaturesStore } from "../features-store.js";
import { compactToolValue, limitToolText } from "../../agent/tool-result-format.js";
import { cutKeepingWhole } from "../../agent/tool-output-spool.js";
import type { ToolContext } from "../../agent/tool-registry.js";
import {
  compactToolImageResultContent,
  isToolImageResultContent
} from "../../agent/wake-message-adapter.js";
import { isModelOnlySource } from "../../../../shared/agent-message-types.js";

const params = z.object({
  featureId: z.string().min(1),
  limit: z.number().int().positive().max(50).optional()
});

interface Result {
  messages?: Array<ReturnType<typeof serializeMessageForAgent>>;
  error?: string;
}

interface ReadFeatureThreadDeps {
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
    handler: async ({ featureId, limit }, ctx) => {
      const feature = deps.featuresStore.getById(featureId);
      if (!feature || feature.archivedAt) return { error: `feature not found: ${featureId}` };
      const thread = deps.agentStore.getThreadByScope("worker", featureId);
      if (!thread) return { messages: [] };
      // What only the worker's model reads is not its conversation.
      const all = deps.agentStore.getActiveMessages(thread.id).filter((m) => !isModelOnlySource(m.source));
      const n = limit ?? 10;
      const cut = readerCut(ctx);
      return { messages: all.slice(-n).map((message) => serializeMessageForAgent(message, cut)) };
    }
  };
}

/** What a reader is given of one long text: its first 4,000 characters, the
 *  whole saved under the reading thread. */
const MESSAGE_TEXT_MAX = 4000;
type Cut = (text: string) => { text: string; truncated: boolean };

function readerCut(ctx: Pick<ToolContext, "threadId" | "project">): Cut {
  const owner = ctx.project ? { kind: "project" as const, projectId: ctx.project.id } : { kind: "global" as const };
  return (text) => ({ text: cutKeepingWhole(text, MESSAGE_TEXT_MAX, { threadId: ctx.threadId, owner }), truncated: text.length > MESSAGE_TEXT_MAX });
}

function serializeMessageForAgent(message: AgentMessage, cut: Cut) {
  return {
    seq: message.seq,
    role: message.role,
    source: message.source,
    createdAt: message.createdAt,
    content: serializeContent(message.content, cut)
  };
}

function serializeContent(content: AgentMessage["content"], cut: Cut) {
  switch (content.type) {
    case "text": {
      const text = cut(content.text);
      return {
        type: "text" as const,
        text: text.text,
        ...(text.truncated ? { textTruncated: true } : {}),
        ...(content.attachments?.length ? { attachmentCount: content.attachments.length } : {})
      };
    }
    case "assistant": {
      const text = content.text ? cut(content.text) : null;
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
        : cut(textOfValue(
          isToolImageResultContent(content.result)
            ? compactToolImageResultContent(content.result)
            : content.result
        ));
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
      const summary = cut(content.summary);
      return {
        type: "summary" as const,
        summary: summary.text,
        replacedRange: content.replacedRange,
        replacedCount: content.replacedCount,
        ...(summary.truncated ? { summaryTruncated: true } : {})
      };
    }
  }
}

/** A tool's result as text, as compactToolValue renders it. */
function textOfValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
