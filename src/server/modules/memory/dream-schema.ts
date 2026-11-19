import { z } from "zod";

export const ACTION_SCHEMA = z.object({
  type: z.enum(["merge", "update", "archive", "move", "split"]),
  memoryId: z.string().min(1),
  reason: z.string().min(1),
  targetMemoryId: z.string().min(1).optional().describe("merge: the memory that remains."),
  content: z.string().min(1).optional().describe("update: the new text. merge: the merged text, when the source adds something."),
  entryType: z.enum(["preference", "knowledge"]).optional().describe("update: a corrected type."),
  scope: z.enum(["user", "project"]).optional().describe("move: where to."),
  projectId: z.string().min(1).optional().describe("move to a project: its id."),
  parts: z.array(z.string().min(1)).max(8).optional().describe("split: each part becomes its own memory.")
});

export const LIST_SCHEMA = z.object({ type: z.enum(["preference", "knowledge"]).optional() });

export const SEARCH_SCHEMA = z.object({ query: z.string().min(1), maxResults: z.number().int().min(1).max(20).optional() });

export const READ_SCHEMA = z.object({ memoryId: z.string().min(1) });

export const BRIEF_SCHEMA = z.object({
  content: z.string().min(1),
  summary: z.string().min(1).optional().describe("One sentence on what this run changed, for the user's activity log.")
});
