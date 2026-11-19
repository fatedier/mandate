import { z } from "zod";

export const READ_TRANSCRIPT_SCHEMA = z.object({
  thread: z.string().optional().describe("The conversation's thread, or one of its subagents' threads. Default: the conversation."),
  from_seq: z.number().int().describe("The first message number to read."),
  to_seq: z.number().int().describe("The last message number to read.")
});

export const READ_SKILL_SCHEMA = z.object({
  name: z.string().min(1).describe("The skill's name, as in the skills list.")
});

export const FINISH_SCHEMA = z.object({
  outcome: z.enum(["none", "created", "changed", "restored"]).describe("What you did: none, created, changed or restored."),
  reason: z.string().min(1).describe("One sentence: what you changed and why, or why nothing should change.")
});

// The tidy's own: its changes are manage_skill's (manage-skill-schema.ts).
export const FINISH_TIDY_SCHEMA = z.object({
  reason: z.string().min(1).describe("One sentence: what you changed, or why nothing needed to change.")
});
