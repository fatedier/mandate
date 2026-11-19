import { z } from "zod";

export const subagentParams = z.object({
  title: z.string().trim().min(1).max(120).describe("A short name for this job, 3 to 6 words, shown to the user: for example \"Find the retry call sites\"."),
  task: z.string().describe("Everything the subagent needs, in full. It sees nothing else of this conversation.")
});

export const personalSubagentParams = subagentParams.extend({
  type: z.enum(["general", "page"]).optional().describe("'general' (the default) for a job as described above; 'page' for a change to your page.")
});

export const stopTaskParams = z.object({
  taskId: z.string().trim().min(1).describe("The taskId the call that started it returned.")
});

export const listTasksParams = z.object({}).strict();
