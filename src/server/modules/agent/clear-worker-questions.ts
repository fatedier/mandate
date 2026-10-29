import { SSE_EVENTS } from "../../../shared/api/sse.js";
import { planForPage } from "../../../shared/plan-rounds.js";
import type { PlanStore } from "../plans/plan-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";

/** Clears the questions a worker's plan asks, for whoever may say they no
 *  longer need an answer: the worker's manager, or the user. Only the worker
 *  writes its plan otherwise, and a question it never cleared would keep it
 *  waiting for an answer for good. Nothing else of the plan is touched, and
 *  a plan that asks nothing is left alone. */
export function clearWorkerQuestions(
  deps: { planStore?: Pick<PlanStore, "get" | "update">; sse: Pick<AgentSseEmitter, "emit"> },
  featureId: string
): void {
  if (!deps.planStore || deps.planStore.get(featureId).openQuestions.length === 0) return;
  const result = deps.planStore.update(featureId, { openQuestions: [] });
  if (result.ok) deps.sse.emit(SSE_EVENTS.featurePlanUpdated, { plan: planForPage(result.plan) });
}
