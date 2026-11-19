import { z } from "zod";

export const params = z.object({
  title: z.string().trim().min(1).max(120).describe("A short title the user sees first."),
  text: z.string().trim().max(4000).describe("The message: what happened and what, if anything, they need to do."),
  threadId: z.string().nullable().optional().describe("The thread this is about, if any. Omit or pass an empty string otherwise."),
  workerId: z.string().nullable().optional().describe("The worker this is about, if any. Omit or pass an empty string otherwise."),
  level: z.enum(["needs_you", "news"]).optional().describe("needs_you (the default) when they must act; news when nothing is asked of them."),
  channels: z.array(z.string()).nullable().optional().describe("Channel names from \"Notification channels\" in your context. Leave this out and Mandate chooses: it knows whether the user is at their desk and what they are looking at, and you do not. Name channels only where the user has said they want to be told, in this conversation or as a standing preference. Named channels get it at once, wherever the user is, and keep it after the user has seen it.")
});
