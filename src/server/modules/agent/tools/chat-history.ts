import { z } from "zod";
import type { AgentScope } from "../agent-store.js";
import type { ToolDefinition } from "../tool-registry.js";
import { AgentHistoryStore } from "../history-store.js";
import type { Database } from "bun:sqlite";
import { workerSearchParams, managerSearchParams, readParams } from "./chat-history-schema.js";
type SearchParams = z.infer<typeof managerSearchParams> | z.infer<typeof workerSearchParams>;

export function buildChatHistoryTools(input: { db: Database; scope: AgentScope }): ToolDefinition[] {
  const history = new AgentHistoryStore(input.db);
  return [chatHistorySearchTool(history, input.scope), chatHistoryReadTool(history)];
}

function chatHistorySearchTool(
  history: AgentHistoryStore,
  scope: AgentScope
): ToolDefinition<SearchParams, ReturnType<AgentHistoryStore["search"]>> {
  const workerScope = scope === "worker";
  return {
    name: "chat_history_search",
    description: workerScope
      ? "Search historical Mandate agent chat messages inside this worker's current project. "
        + "Project scope is applied automatically; this tool does not accept projectId, workerId, or threadId. "
        + "It also searches this project's task records — what each worker was asked, did and left open — archived workers' included, and returns them as records with their first line; read one whole with memory_read. "
        + "Use includeOwnThread=true to include your own thread. "
        + "Example: {\"query\":\"meta version\",\"timeRange\":{\"preset\":\"projectLifetime\"},\"includeOwnThread\":true,\"limit\":10}. "
        + "Returns threads and their hits; read around a hit with chat_history_read and the hit's threadId and seq."
      : "Search historical Mandate agent chat messages. "
        + "Pass the exact projectId to search a project's chats; do not pass a project name, slug, or path. "
        + "Without projectId it searches the task records of every project and the conversations outside any project: manager threads and the user's personal agent's. "
        + "Task records come back as records with their first line; read one whole with memory_read. "
        + "Optional workerId/threadId are exact filters only; omit them when you do not have the real id or do not need that narrow a search. "
        + "Example: {\"projectId\":\"proj_...\",\"query\":\"meta version\",\"timeRange\":{\"preset\":\"projectLifetime\"},\"limit\":10}. "
        + "Each thread says its kind (worker, manager, or personal: the user's personal agent) and its hits; read around a hit with chat_history_read and the hit's threadId and seq.",
    parameters: (workerScope ? workerSearchParams : managerSearchParams) as z.ZodType<SearchParams>,
    // Its reads in a worker of their own: a search over every project's word
    // matches does not hold the server's thread.
    handler: async (args, ctx) => history.searchAway({
      callerThreadId: ctx.threadId,
      projectId: "projectId" in args ? args.projectId : undefined,
      query: args.query,
      workerId: "workerId" in args ? args.workerId : undefined,
      threadId: "threadId" in args ? args.threadId : undefined,
      timeRange: args.timeRange,
      includeArchived: args.includeArchived,
      includeOwnThread: args.includeOwnThread,
      limit: args.limit,
      snippetsPerThread: args.snippetsPerThread
    })
  };
}

function chatHistoryReadTool(
  history: AgentHistoryStore
): ToolDefinition<z.infer<typeof readParams>, ReturnType<AgentHistoryStore["read"]>> {
  return {
    name: "chat_history_read",
    description:
      "Read a small window of historical chat messages around one message: the threadId and seq of a chat_history_search hit. " +
      "Only threads your search could return can be read.",
    parameters: readParams,
    handler: async (args, ctx) => history.read({
      callerThreadId: ctx.threadId,
      threadId: args.threadId,
      seq: args.seq,
      limitBefore: args.limitBefore,
      limitAfter: args.limitAfter,
      includeTools: args.includeTools,
      maxCharsPerMessage: args.maxCharsPerMessage
    })
  };
}
