import { z } from "zod";
import { SSE_EVENTS, type AgentScope } from "../../../shared/api-contracts.js";
import { renderPlanText } from "../../../shared/plan-text.js";
import { planForPage } from "../../../shared/plan-rounds.js";
import type { MandateStore } from "../../app/store.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { AgentStore } from "../agent/agent-store.js";
import type { ToolContext, ToolDefinition } from "../agent/tool-registry.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import { toWorkItemDto } from "../agent/work-item-dto.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import { PlanStore } from "./plan-store.js";

interface PlanToolDeps {
  scope: AgentScope;
  store?: MandateStore;
  agentStore?: AgentStore;
  featuresStore?: FeaturesStore;
  workStore?: WorkItemStore;
  sse?: AgentSseEmitter;
  /** The worker wrote questions that were not in its plan before: its
   *  manager is told of them now, not at the end of the worker's turn. */
  onQuestionAsked?: (featureId: string, questions: string[]) => void;
}

const STATUS = z.enum(["pending", "in_progress", "blocked", "done"]);
/** A step id. The plan shows steps as `#3`, and some models send ids as
 *  strings: "3" and "#3" read as 3. The schema the model sees stays an integer. */
const STEP_ID = z.preprocess(
  (v) => (typeof v === "string" && /^\s*#?\d+\s*$/.test(v) ? Number(v.trim().replace(/^#/, "")) : v),
  z.number().int().positive()
);

const updateParams = z.object({
  goal: z.string().optional().describe("What the feature is to achieve. May name several aims. Set it when you start; change it only when the aim changes (earlier goals are kept)."),
  conclusion: z.string().optional().describe("Where the feature stands, in one sentence. Update it whenever the picture changes."),
  openQuestions: z.array(z.string()).optional().describe("Questions that need the user or the manager to decide (at most 5). Replaces the list; send [] to clear it."),
  steps: z.array(z.object({
    id: STEP_ID.optional().describe("The step to change. Leave it out to add a new step."),
    title: z.string().optional().describe("A short line saying what the step is. Required for a new step."),
    status: STATUS.optional().describe("pending, in_progress, blocked or done."),
    note: z.string().optional().describe("Free text with links. For done: the result and the evidence (commit, PR, test output, report). For blocked: what it waits on, and who. May name the pane doing the work (%133)."),
    after: STEP_ID.optional().describe("Place the step after this step id. Without it a new step goes at the end.")
  }).strict()).optional().describe("Steps to add or change. Steps you do not mention stay as they are."),
  delete: z.array(STEP_ID).optional().describe("Ids of steps to remove for good: ones added by mistake or no longer meaningful.")
}).strict();

const UPDATE_DESCRIPTION = [
  "Keep this feature's plan: its goal, a one-sentence conclusion, open questions, and a list of steps. The user reads the plan to see where the feature stands, the manager reads it to coordinate, and you read it after your context is compacted, so it must always be true.",
  "",
  "Statuses: pending = not started yet (a new step starts pending); in_progress = being worked on now; blocked = waiting on something outside you; done = finished, with its result in the note.",
  "",
  "When to use it:",
  "- On new work (a message from the manager, a request from the user), write or extend the plan before acting: the goal, the conclusion, and the steps you will take. A one-step plan is fine.",
  "- Mark a step in_progress when you start it. Several steps may be in progress at once when different panes work in parallel.",
  "- Mark it done as soon as it is done, with a note holding the result and the evidence. Do not batch completions later.",
  "- Never mark a step done while its tests fail, the work is partial, or an error is unresolved; keep it in_progress, or mark it blocked.",
  "- Mark a step blocked when it waits on something outside you (an upstream change, a review, a decision); the note must say what and who.",
  "- Update the conclusion whenever the overall picture changes. Put questions that need the manager or the user to decide in openQuestions: the manager is told at once, and a question stays open until you clear it.",
  "- Delete a step only when it was added by mistake or no longer means anything. Do not let open steps pile up.",
  "",
  "One call may set the header fields and add, change or delete any number of steps; steps you do not mention are unchanged. The call is all or nothing: if anything is wrong, nothing is applied and every problem is listed. The answer is one line; call read_plan to see the whole plan."
].join("\n");

const READ_DESCRIPTION_WORKER = "Read this feature's plan: the goal, the conclusion, open questions and the steps with their notes. Older completed steps are folded into a count; pass includeHistory to list every step and the earlier goals. Read it when you are unsure where the work stands, for example after your context was compacted.";
const READ_DESCRIPTION_MANAGER = "Read a feature's plan, which its worker keeps: the goal, the conclusion, open questions and the steps with their notes. Older completed steps are folded into a count; pass includeHistory to list them. The plan is read-only for you: to change it, send the worker a message with feature_message_send.";

function workerFeatureId(ctx: ToolContext, deps: PlanToolDeps): string {
  if (ctx.feature?.id) return ctx.feature.id;
  const thread = deps.agentStore?.getThreadById(ctx.threadId);
  if (thread?.scope === "worker" && thread.scopeId) return thread.scopeId;
  throw new Error("this thread is not scoped to a feature");
}

export function buildPlanToolPacks(deps: PlanToolDeps): ToolPack[] {
  if (!deps.store) return [];
  const plans = new PlanStore(deps.store.db);

  if (deps.scope === "manager") {
    const readParams = z.object({
      featureId: z.string().min(1).describe("The feature whose plan to read."),
      includeHistory: z.boolean().optional()
    }).strict();
    const read: ToolDefinition<z.infer<typeof readParams>, string | { error: string }> = {
      name: "read_plan",
      description: READ_DESCRIPTION_MANAGER,
      parameters: readParams,
      handler: async ({ featureId, includeHistory }) => {
        const feature = deps.featuresStore?.getById(featureId);
        if (!feature || feature.archivedAt) return { error: `feature not found: ${featureId}` };
        return renderPlanText(plans.get(featureId), { includeHistory });
      }
    };
    return [toolPack("plans.read", ["manager"], [read])];
  }

  const update: ToolDefinition<z.infer<typeof updateParams>, string> = {
    name: "update_plan",
    description: UPDATE_DESCRIPTION,
    parameters: updateParams,
    handler: async (input, ctx) => {
      const featureId = workerFeatureId(ctx, deps);
      const before = plans.get(featureId);
      const result = plans.update(featureId, input);
      if (!result.ok) throw new Error(result.errors.join("; "));
      deps.sse?.emit(SSE_EVENTS.featurePlanUpdated, { plan: planForPage(result.plan) });
      if (result.changed) {
        // The plan is the feature's activity: the work item's activity time
        // moves with it. Finishing it asks nothing of the user: the manager
        // hears it in the worker's report and decides what the user hears.
        const item = deps.workStore?.getByFeature(featureId);
        const touched = item ? deps.workStore!.touch(item.id) : null;
        if (touched) deps.sse?.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(touched) });
        // A question that was not there before goes to the manager now: the
        // worker may work on for minutes before its turn ends.
        const known = new Set(before.openQuestions);
        const asked = result.plan.openQuestions.filter((question) => !known.has(question));
        if (asked.length > 0) deps.onQuestionAsked?.(featureId, asked);
      }
      return result.summary;
    }
  };
  const readParams = z.object({ includeHistory: z.boolean().optional() }).strict();
  const read: ToolDefinition<z.infer<typeof readParams>, string> = {
    name: "read_plan",
    description: READ_DESCRIPTION_WORKER,
    parameters: readParams,
    handler: async ({ includeHistory }, ctx) => renderPlanText(plans.get(workerFeatureId(ctx, deps)), { includeHistory })
  };
  return [toolPack("plans.worker", ["worker"], [update, read])];
}
