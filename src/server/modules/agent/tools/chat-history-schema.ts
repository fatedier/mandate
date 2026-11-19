import { z } from "zod";

export const timeRangeParams = z.object({
  preset: z.enum(["last7d", "last30d", "last90d", "projectLifetime", "all"]).optional(),
  since: z.string().optional(),
  until: z.string().optional()
}).optional();

export const searchBaseParams = {
  query: z.string().min(2).describe("Search query over historical agent chat messages."),
  timeRange: timeRangeParams.describe(
    "Time range. Defaults to { preset: 'last90d' }."
  ),
  includeArchived: z.boolean().optional().describe("Include archived project/worker/thread history. Defaults false."),
  includeOwnThread: z.boolean().optional().describe(
    "Include your own thread. Defaults false."
  ),
  limit: z.number().int().positive().max(10).optional().describe("Max thread results. Default 5, max 10."),
  snippetsPerThread: z.number().int().positive().max(5).optional().describe("Max snippets per thread. Default 2, max 5.")
} satisfies z.ZodRawShape;

export const managerSearchParams = z.object({
  projectId: z.string().min(1).optional().describe(
    "Exact project id to search. Omit it to search every project's task records and the conversations outside any project. Do not pass a project name, slug, or path."
  ),
  ...searchBaseParams,
  // Overrides the shared description: the manager's own conversation is
  // what this search exists to reach, so it is never excluded.
  includeOwnThread: z.boolean().optional().describe(
    "No-op for you: your own manager conversation is always searchable and no flag excludes it. "
    + "The flag only gates a worker's own thread."
  ),
  workerId: z.string().optional().describe(
    "Optional exact worker id filter. Must belong to the searched project. "
    + "Omit or pass an empty string unless you intentionally want to narrow to one worker. Never invent an id."
  ),
  threadId: z.string().optional().describe(
    "Optional exact agent thread id filter, such as thr_... . "
    + "Omit or pass an empty string unless you have a real thread id. Never invent an id."
  )
}).strict();

export const workerSearchParams = z.object(searchBaseParams).strict();

export const readParams = z.object({
  threadId: z.string().min(1).describe("The thread id of a chat_history_search hit."),
  seq: z.number().int().describe("The seq of the hit to read around."),
  limitBefore: z.number().int().positive().max(20).optional().describe("Messages before the hit. Default 5, max 20."),
  limitAfter: z.number().int().positive().max(20).optional().describe("Messages after the hit. Default 5, max 20."),
  includeTools: z.boolean().optional().describe(
    "Include safe tool result summaries. Raw tool payloads are never returned. Defaults false."
  ),
  maxCharsPerMessage: z.number().int().positive().max(4000).optional().describe(
    "Per-message text cap. Default 2000, max 4000."
  )
});
