import { z } from "zod";

export const searchParams = z.object({
  query: z.string().min(1).describe("Natural language or keywords."),
  project: z.string().min(1).optional().describe("A project's name or id: search only that project. Omit to search the user's memories and every project."),
  type: z.enum(["preference", "knowledge"]).optional(),
  includeArchived: z.boolean().optional(),
  maxResults: z.number().int().min(1).max(20).optional()
}).strict();

// Only the target's field is read, so the others take a blank or null as a
// model fills them.
export const readParams = z.object({
  target: z.enum(["memory", "project", "user"]).describe("What to read: one memory by its id, a project's brief, or the user brief."),
  id: z.string().nullable().optional().describe("For target \"memory\": the memory's or task record's id."),
  project: z.string().nullable().optional().describe("For target \"project\": the project's name or id.")
}).strict();

export const rememberParams = z.object({
  type: z.enum(["preference", "knowledge"]).describe(
    "preference: how the user wants things done — a working rule. knowledge: a fact the project's files and their history do not show."
  ),
  scope: z.enum(["user", "project"]).describe("user: true everywhere. project: true for one project."),
  project: z.string().min(1).optional().describe("For scope project: the project's name or id. A worker may omit it; its own project is used."),
  content: z.string().min(1).describe("One thing, in a few sentences, in the language it was said in."),
  userQuote: z.string().min(1).optional().describe("When this records what the user told you: their exact words from this conversation. Checked against the user's messages.")
}).strict();

export const updateParams = z.object({
  id: z.string().trim().min(1),
  content: z.string().min(1).describe("The corrected memory, whole."),
  userQuote: z.string().min(1).optional().describe("When the correction comes from the user: their exact words from this conversation. Required to change a memory the user stated.")
}).strict();

export const forgetParams = z.object({
  id: z.string().trim().min(1),
  reason: z.string().min(1).describe("Why, in a sentence: what the user said, or what proved it wrong.")
}).strict();
