import { z } from "zod";
import type { ToolDefinition, ToolContext } from "../tool-registry.js";
import type { WorkItemStore } from "../work-item-store.js";
import type { AgentSseEmitter } from "../../sse/sse-events.js";
import { SSE_EVENTS } from "../../../../shared/api/sse.js";
import { toWorkItemDto } from "../work-item-dto.js";
import type { FeaturesStore } from "../../features/features-store.js";
import type { AgentStore } from "../agent-store.js";
import { ownerRefusal } from "../../features/ownership.js";
import type { PlanStore } from "../../plans/plan-store.js";
import { clearWorkerQuestions } from "../clear-worker-questions.js";

const dismissParams = z.object({
  id: z.string(),
  reason: z.string().optional()
});

interface WorkItemToolDeps {
  workStore: WorkItemStore;
  sse: AgentSseEmitter;
  /** The workers' plans: dismissing also clears the questions a plan asks. */
  planStore?: Pick<PlanStore, "get" | "update">;
  /** With both, a thread may only dismiss its own workers' questions. */
  featuresStore?: Pick<FeaturesStore, "getById">;
  agentStore?: AgentStore;
}

function refuseOthers(deps: WorkItemToolDeps, itemId: string, ctx: ToolContext): string | null {
  const item = deps.workStore.get(itemId);
  if (!item || !deps.featuresStore || !deps.agentStore) return null;
  return ownerRefusal({ featuresStore: deps.featuresStore, agentStore: deps.agentStore }, item.featureId, ctx.threadId);
}

export function buildWorkItemTools(deps: WorkItemToolDeps): Array<ToolDefinition<unknown, unknown>> {
  return [buildDismissTool(deps)];
}

function buildDismissTool(deps: WorkItemToolDeps): ToolDefinition<z.infer<typeof dismissParams>, { ok?: boolean; error?: string }> {
  return {
    name: "dismiss_work_item",
    description:
      "Clear the open questions in a worker's plan when they no longer need an answer " +
      "(answered another way, or no longer needed).",
    parameters: dismissParams,
    handler: async (input, ctx: ToolContext) => {
      const refusal = refuseOthers(deps, input.id, ctx);
      if (refusal) return { error: refusal };
      // A touch of the work item: its activity time moves, and whoever
      // listens for worker changes (the managers' sweep) looks again.
      const item = deps.workStore.touch(input.id);
      if (!item) return { error: `work_item not found: ${input.id}` };
      // What a worker asks is in its plan; only the worker writes it otherwise.
      clearWorkerQuestions(deps, item.featureId);
      deps.sse.emit(SSE_EVENTS.workItemUpdated, { item: toWorkItemDto(item) });
      return { ok: true };
    }
  };
}
