import type { AgentStore } from "../agent/agent-store.js";
import type { FeaturesStore } from "../features/features-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import { ManagerThreadService } from "../agent/manager-threads.js";
import { hasStepInProgress, isAsking, waitingOnYou } from "../../../shared/feature-state.js";
import type { PlanStore } from "../plans/plan-store.js";
import { threadStop, workerStop, type ThreadSignal, type ThreadStop, type ThreadWorkerSignal, type WaitKind } from "../../../shared/thread-dot.js";
import type { ManagerThreadDto } from "../../../shared/api/agents.js";
import type { FeaturePlanDto } from "../../../shared/api/plans.js";

/** What the stop test reads: the stores, and two
 *  things only the runtime knows. */
export interface ThreadSignalDeps {
  agentStore: AgentStore;
  featuresStore: Pick<FeaturesStore, "listActiveOwnedBy">;
  workStore: Pick<WorkItemStore, "getByFeature">;
  /** The workers' plans: a question in one is what the worker asks. */
  planStore: Pick<PlanStore, "get">;
  /** A turn running, or a message waiting to start one. */
  isBusy: (threadId: string) => boolean;
  /** What the thread sleeps on (leadWait), if anything. */
  waitKind: (threadId: string) => WaitKind | null;
}

/** One worker's signal: the one place it is built. */
export function workerSignal(
  deps: Pick<ThreadSignalDeps, "workStore" | "planStore" | "isBusy" | "waitKind"> & { agentStore: Pick<AgentStore, "getThreadByScope"> },
  featureId: string,
  /** Its plan, when the caller has read it already. */
  plan: FeaturePlanDto = deps.planStore.get(featureId)
): ThreadWorkerSignal {
  const item = deps.workStore.getByFeature(featureId);
  const thread = deps.agentStore.getThreadByScope("worker", featureId);
  const asking = isAsking(plan);
  return {
    waiting: waitingOnYou(item?.failedAt ?? null, item?.failedKind ?? null),
    asking,
    running: thread ? deps.isBusy(thread.id) : false,
    watching: thread ? deps.waitKind(thread.id) : null,
    stepInProgress: hasStepInProgress(plan)
  };
}

/** The signals of every active worker a thread owns. */
export function workerSignalsOf(deps: ThreadSignalDeps, ownerThreadId: string): ThreadWorkerSignal[] {
  return deps.featuresStore.listActiveOwnedBy(ownerThreadId).map((f) => workerSignal(deps, f.id));
}

/** A manager thread's own signal. Running means busy: a turn running, a
 *  message waiting to start one, or a follow-up due. */
export function threadSignalOf(deps: Pick<ThreadSignalDeps, "isBusy" | "waitKind">, dto: ManagerThreadDto): ThreadSignal {
  return { running: dto.running || deps.isBusy(dto.id), failed: dto.failed, watching: deps.waitKind(dto.id), asking: dto.questions.length > 0 };
}

/** How the target of a wait has stopped, or null while it has not. The
 *  target is a manager thread (judged with every active worker it owns) or a
 *  worker's own chat (judged alone). One that is gone is not judged here:
 *  the archive paths end its waits. */
export function stopOfTarget(deps: ThreadSignalDeps, threadId: string): ThreadStop | null {
  const thread = deps.agentStore.getThreadById(threadId);
  if (!thread || thread.archivedAt) return null;
  if (thread.scope === "worker") return thread.scopeId ? workerStop(workerSignal(deps, thread.scopeId)) : null;
  const dto = new ManagerThreadService({ agentStore: deps.agentStore }).dto(threadId);
  if (!dto) return null;
  // Its manager's own question to the user: the thread needs them once it has stopped.
  return threadStop({ ...threadSignalOf(deps, dto), running: deps.isBusy(threadId) }, workerSignalsOf(deps, threadId));
}
