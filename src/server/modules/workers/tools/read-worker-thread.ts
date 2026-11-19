import * as fs from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { AgentStore, AgentMessage } from "../../agent/agent-store.js";
import type { WorkersStore } from "../workers-store.js";
import { compactToolValue, limitToolText } from "../../agent/tool-result-format.js";
import { cutKeepingWhole, persistedOutputPath } from "../../agent/tool-output-spool.js";
import type { ToolContext } from "../../agent/tool-registry.js";
import { redactForReader, redactStringsForReader } from "../../agent/reader-redaction.js";
import {
  compactToolImageResultContent,
  isToolImageResultContent
} from "../../agent/wake-message-adapter.js";
import { isModelOnlySource } from "../../../../shared/agent-message-types.js";
import { params } from "./read-worker-thread-schema.js";

interface Result {
  messages?: Array<ReturnType<typeof serializeMessageForAgent>>;
  error?: string;
}

interface ReadWorkerThreadDeps {
  agentStore: AgentStore;
  workersStore: WorkersStore;
}

export function buildReadWorkerThreadTool(
  deps: ReadWorkerThreadDeps
): ToolDefinition<z.infer<typeof params>, Result> {
  return {
    name: "read_worker_thread",
    description: "Read compact summaries of the last N active messages in a worker's thread. Default 10, max 50.",
    parameters: params,
    handler: async ({ workerId, limit }, ctx) => {
      const worker = deps.workersStore.getById(workerId);
      if (!worker || worker.archivedAt) return { error: `worker not found: ${workerId}` };
      const thread = deps.agentStore.getThreadByScope("worker", workerId);
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
/** `hidden`: its secrets were hidden already (a structured value, string by
 *  string before it became JSON, where a pattern over the escaped text would
 *  run past a line's end and take what follows). */
type Cut = (text: string, hidden?: boolean) => { text: string; truncated: boolean };

function readerCut(ctx: Pick<ToolContext, "threadId" | "project">): Cut {
  const owner = ctx.project ? { kind: "project" as const, projectId: ctx.project.id } : { kind: "global" as const };
  // Its secrets hidden first, in what is given and in what is saved, as a
  // history search hides them (the worker's own chat keeps them).
  return (written, hidden = false) => {
    const text = hidden ? written : redactForReader(written).text;
    return { text: cutKeepingWhole(text, MESSAGE_TEXT_MAX, { threadId: ctx.threadId, owner }), truncated: text.length > MESSAGE_TEXT_MAX };
  };
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
                // Secrets hidden before the cut (one cut through could show half of it).
                const args = compactToolValue(textOfValue(redactStringsForReader(call.args)), 1200);
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
      const error = content.error ? limitToolText(redactForReader(content.error).text, 1200) : null;
      const result = content.result === undefined
        ? null
        : cut(textOfValue(redactStringsForReader(readerSide(
          isToolImageResultContent(content.result)
            ? compactToolImageResultContent(content.result)
            : content.result
        ))), true);
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
/** A result saved whole at the call is stored as a preview and that file's
 *  path: the reader is given the whole instead (hidden and cut as its own,
 *  saved to its own folder), never the original's path. A file gone since
 *  leaves the preview, its path dropped. */
function readerSide(result: unknown): unknown {
  const saved = typeof result === "string" ? persistedOutputPath(result) : null;
  if (!saved || typeof result !== "string") return result;
  try {
    return fs.readFileSync(saved, "utf8");
  } catch {
    return result.replace(saved, "(no longer kept)");
  }
}

function textOfValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
