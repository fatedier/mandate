import { z } from "zod";

export const listThreadsParams = z.object({
  archived: z.boolean().optional().describe("true lists the archived threads instead of the open ones.")
}).strict();

/** A tool that takes nothing. */
export const noParams = z.object({}).strict();

export const messageWorkerParams = z.object({
  workerId: z.string().min(1).describe("The worker's id, from list_workers."),
  text: z.string().trim().min(1).max(20_000).describe("What to tell the worker, written for it. Put the user's own words in quotation marks.")
});

// The two ways to name where it goes take a blank or null as not given: a
// model fills the one it does not mean.
export const sendToThreadParams = z.object({
  threadId: z.string().nullable().optional().describe("An open thread from list_threads."),
  newThreadTitle: z.string().max(80).nullable().optional().describe("A short title, to open a new thread for this instead."),
  text: z.string().trim().min(1).max(20_000).describe("The message. Put the user's own words in quotation marks. A thread already on the matter needs only those and what it has not seen; a new one also needs what the user wants. Add no requirements of your own."),
  answers: z.string().trim().min(1).optional().describe("When the message answers a question this thread's manager asked the user: that question's id, as its notice shows it (q_…). Leave it out for anything else, a question you asked the user yourself included: put their answer in the message."),
  taskId: z.string().nullable().optional().describe("Optional: the task this work is for. The thread it goes to is linked to the task, a new thread included.")
});

export const awaitStopParams = z.object({
  threadId: z.string().nullable().optional().describe("An open thread from list_threads."),
  workerId: z.string().nullable().optional().describe("A worker's id, from list_workers.")
});

export const archiveThreadParams = z.object({
  threadId: z.string().min(1).describe("An open thread from list_threads."),
  confirmedByUser: z.boolean().optional()
});

export const labelThreadParams = z.object({
  threadId: z.string().min(1).describe("A thread from list_threads, open or archived."),
  label: z.string().describe("The label, at most 40 characters."),
  remove: z.boolean().optional().describe("true takes the label off instead of adding it.")
});
