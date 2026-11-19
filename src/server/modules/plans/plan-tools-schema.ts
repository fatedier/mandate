import { z } from "zod";
import { PLAN_LIMITS } from "../../../shared/api/plans.js";

export const STATUS = z.enum(["pending", "in_progress", "blocked", "done"]);

/** A step id. The plan shows steps as `#3`, and some models send ids as
 *  strings: "3" and "#3" read as 3. The schema the model sees stays an integer. */
export const STEP_ID = z.preprocess(
  (v) => (typeof v === "string" && /^\s*#?\d+\s*$/.test(v) ? Number(v.trim().replace(/^#/, "")) : v),
  z.number().int().positive()
);

export const updateParams = z.object({
  goal: z.string().optional().describe("What the work is to achieve. May name several aims. Set it when you start; change it only when the aim changes (earlier goals are kept)."),
  conclusion: z.string().optional().describe(`Where the work stands, in one sentence of at most ${PLAN_LIMITS.conclusion} characters. Update it whenever the picture changes.`),
  openQuestions: z.array(z.string()).optional().describe(`Questions that need the user or the manager to decide: at most ${PLAN_LIMITS.openQuestions}, each at most ${PLAN_LIMITS.question} characters. Replaces the list; send [] to clear it.`),
  steps: z.array(z.object({
    id: STEP_ID.optional().describe("The step to change. Leave it out to add a new step."),
    title: z.string().optional().describe("A short line saying what the step is. Required for a new step."),
    status: STATUS.optional().describe("pending, in_progress, blocked or done."),
    note: z.string().optional().describe("Free text with links. For done: the result and the evidence (commit, PR, test output, report). For blocked: what it waits on, and who. May name the pane doing the work (%133)."),
    after: STEP_ID.optional().describe("Place the step after this step id. Without it a new step goes at the end.")
  }).strict()).optional().describe("Steps to add or change. Steps you do not mention stay as they are."),
  delete: z.array(STEP_ID).optional().describe("Ids of steps to remove for good: ones added by mistake or no longer meaningful.")
}).strict();

/** read_plan for a manager: a worker's plan, named by its worker. */
export const managerReadParams = z.object({
  workerId: z.string().min(1).describe("The worker whose plan to read."),
  includeHistory: z.boolean().optional()
}).strict();

/** read_plan for a worker: its own plan. */
export const workerReadParams = z.object({ includeHistory: z.boolean().optional() }).strict();
