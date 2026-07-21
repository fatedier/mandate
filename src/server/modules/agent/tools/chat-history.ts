import { z } from "zod";
import type { AgentScope } from "../agent-store.js";
import type { ToolDefinition } from "../tool-registry.js";
import { AgentHistoryStore } from "../history-store.js";
import type { Database } from "bun:sqlite";

const timeRangeParams = z.object({
  preset: z.enum(["last7d", "last30d", "last90d", "projectLifetime", "all"]).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  reason: z.string().optional()
}).optional();

const searchBaseParams = {
  query: z.string().min(2).describe("Search query over project-scoped historical agent chat messages."),
  timeRange: timeRangeParams.describe(
    "Time range. Defaults to { preset: 'last90d' }. Preset 'all' requires reason and is recorded in audit."
  ),
  includeArchived: z.boolean().optional().describe("Include archived project/feature/thread history. Defaults false."),
  includeCurrentLineage: z.boolean().optional().describe(
    "Include the current thread and its direct caller/child lineage. Defaults false."
  ),
  limit: z.number().int().positive().max(10).optional().describe("Max thread results. Default 5, max 10."),
  snippetsPerThread: z.number().int().positive().max(5).optional().describe("Max snippets per thread. Default 2, max 5.")
} satisfies z.ZodRawShape;

const overviewSearchParams = z.object({
  projectId: z.string().min(1).describe(
    "Exact project id to search. Required for the manager. Do not pass a project name, slug, or path."
  ),
  ...searchBaseParams,
  // Overrides the shared description: the manager's own conversation is
  // the global history this search exists to reach, so it is never excluded.
  includeCurrentLineage: z.boolean().optional().describe(
    "No-op for you: your own manager conversation is always searchable and no flag excludes it. "
    + "The flag only gates a worker's own thread and its direct caller/child lineage."
  ),
  featureId: z.string().optional().describe(
    "Optional exact feature id filter. Must belong to the searched project. "
    + "Omit or pass an empty string unless you intentionally want to narrow to one feature. Never invent an id."
  ),
  threadId: z.string().optional().describe(
    "Optional exact agent thread id filter, such as thr_... . "
    + "Omit or pass an empty string unless you have a real thread id. Never invent an id."
  )
}).strict();

const featureSearchParams = z.object(searchBaseParams).strict();
type SearchParams = z.infer<typeof overviewSearchParams> | z.infer<typeof featureSearchParams>;

const readParams = z.object({
  handle: z.string().min(1).describe(
    "Opaque readHandle returned by chat_history_search. Reads are restricted to that handle's project/thread/time range."
  ),
  limitBefore: z.number().int().positive().max(20).optional().describe("Messages before the hit. Default 5, max 20."),
  limitAfter: z.number().int().positive().max(20).optional().describe("Messages after the hit. Default 5, max 20."),
  includeTools: z.boolean().optional().describe(
    "Include safe tool result summaries. Raw tool payloads are never returned. Defaults false."
  ),
  maxCharsPerMessage: z.number().int().positive().max(4000).optional().describe(
    "Per-message text cap. Default 2000, max 4000."
  )
});

export function buildChatHistoryTools(input: { db: Database; scope: AgentScope }): ToolDefinition[] {
  const history = new AgentHistoryStore(input.db);
  return [chatHistorySearchTool(history, input.scope), chatHistoryReadTool(history)];
}

function chatHistorySearchTool(
  history: AgentHistoryStore,
  scope: AgentScope
): ToolDefinition<SearchParams, ReturnType<AgentHistoryStore["search"]>> {
  const featureScope = scope === "worker";
  return {
    name: "chat_history_search",
    description: featureScope
      ? "Search historical Mandate agent chat messages inside this feature's current project. "
        + "Project scope is applied automatically; this tool does not accept projectId, featureId, or threadId. "
        + "Use includeCurrentLineage=true when you want to include the current thread and direct caller/child lineage. "
        + "Example: {\"query\":\"meta version\",\"timeRange\":{\"preset\":\"projectLifetime\",\"reason\":\"Verify prior schema discussion.\"},\"includeCurrentLineage\":true,\"limit\":10}. "
        + "Returns snippets/provenance/read handles only; use chat_history_read with a returned handle to inspect a bounded window."
      : "Search historical Mandate agent chat messages inside one project. "
        + "The manager must pass the exact projectId. Do not pass a project name, slug, or path. "
        + "Optional featureId/threadId are exact filters only; omit them when you do not have the real id or do not need that narrow a search. "
        + "Example: {\"projectId\":\"proj_...\",\"query\":\"meta version\",\"timeRange\":{\"preset\":\"projectLifetime\",\"reason\":\"Verify prior schema discussion.\"},\"limit\":10}. "
        + "Returns snippets/provenance/read handles only; use chat_history_read with a returned handle to inspect a bounded window.",
    parameters: (featureScope ? featureSearchParams : overviewSearchParams) as z.ZodType<SearchParams>,
    approval: "never",
    handler: async (args, ctx) => history.search({
      callerThreadId: ctx.threadId,
      wakeId: ctx.wakeId,
      projectId: "projectId" in args ? args.projectId : undefined,
      query: args.query,
      featureId: "featureId" in args ? args.featureId : undefined,
      threadId: "threadId" in args ? args.threadId : undefined,
      timeRange: args.timeRange,
      includeArchived: args.includeArchived,
      includeCurrentLineage: args.includeCurrentLineage,
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
      "Read a small bounded window of project-scoped historical chat messages using a readHandle from chat_history_search. " +
      "The handle binds project, thread, and time range; this tool cannot expand a default-window search into arbitrary all-history reads.",
    parameters: readParams,
    approval: "never",
    handler: async (args, ctx) => history.read({
      callerThreadId: ctx.threadId,
      wakeId: ctx.wakeId,
      handle: args.handle,
      limitBefore: args.limitBefore,
      limitAfter: args.limitAfter,
      includeTools: args.includeTools,
      maxCharsPerMessage: args.maxCharsPerMessage
    })
  };
}
