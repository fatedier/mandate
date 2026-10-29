import { z } from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { AgentStore, AgentMessage } from "../agent-store.js";
import { ManagerThreadService } from "../manager-threads.js";
import { cutKeepingWhole } from "../tool-output-spool.js";
import { isModelOnlySource } from "../../../../shared/agent-message-types.js";

const readParams = z.object({
  threadId: z.string().min(1),
  limit: z.number().int().positive().max(50).optional()
});

/** A thread as a person reads it: a manager's (a thread it was given as
 *  background) and Your agent's (which reuses it by name). */
export function buildReadThreadTool(deps: { agentStore: AgentStore }): ToolDefinition<z.infer<typeof readParams>, unknown> {
  const threads = new ManagerThreadService({ agentStore: deps.agentStore });
  return {
    name: "read_thread",
    description: "Read the last N rows a person would see in a thread (the user's messages, the manager's replies, worker reports). Default 10, max 50. An archived thread can be read too; the answer then says when it was archived.",
    parameters: readParams,
    handler: async ({ threadId, limit }, ctx) => {
      const thread = threads.dto(threadId);
      if (!thread) return { error: `not an open manager thread: ${threadId}` };
      const visible = deps.agentStore.getActiveMessages(threadId).filter(isVisibleRow);
      const owner = ctx.project ? { kind: "project" as const, projectId: ctx.project.id } : { kind: "global" as const };
      const messages = visible.slice(-(limit ?? 10)).map((message) => visibleRow(message, { threadId: ctx.threadId, owner }));
      return thread.archivedAt ? { archivedAt: thread.archivedAt, messages } : { messages };
    }
  };
}

function isVisibleRow(message: AgentMessage): boolean {
  if (isModelOnlySource(message.source)) return false;
  if (message.content.type === "text") return message.role === "user" && Boolean(message.content.text.trim());
  if (message.content.type === "assistant") return Boolean(message.content.text?.trim());
  return false;
}

/** What a reader is given of one long row: its first 4,000 characters, the
 *  whole saved under the reading thread. */
const ROW_TEXT_MAX = 4000;

function visibleRow(message: AgentMessage, reader: Parameters<typeof cutKeepingWhole>[2]) {
  const raw = message.content.type === "text" ? message.content.text : message.content.type === "assistant" ? message.content.text ?? "" : "";
  return {
    seq: message.seq,
    role: message.role,
    source: message.source,
    createdAt: message.createdAt,
    text: cutKeepingWhole(raw, ROW_TEXT_MAX, reader),
    ...(raw.length > ROW_TEXT_MAX ? { textTruncated: true } : {})
  };
}
