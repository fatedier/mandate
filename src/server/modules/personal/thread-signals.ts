import type { AgentStore } from "../agent/agent-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { WorkItemStore } from "../agent/work-item-store.js";
import { ManagerThreadService } from "../agent/manager-threads.js";
import { hasStepInProgress, isAsking, waitingOnYou } from "../../../shared/worker-state.js";
import type { PlanStateView, PlanStore } from "../plans/plan-store.js";
import { threadStop, workerStop, type HeldBackSignal, type ThreadSignal, type ThreadStop, type ThreadWorkerSignal, type WaitKind } from "../../../shared/thread-dot.js";
import type { ManagerThreadDto } from "../../../shared/api/agents.js";

/** What the stop test reads: the stores, and two
 *  things only the runtime knows. */
export interface ThreadSignalDeps {
  agentStore: AgentStore;
  workersStore: Pick<WorkersStore, "listActiveOwnedBy">;
  workStore: Pick<WorkItemStore, "getByWorker">;
  /** The workers' plans: a question in one is what the worker asks. */
  planStore: Pick<PlanStore, "stateOf">;
  /** A turn running, or a message waiting to start one. */
  isBusy: (threadId: string) => boolean;
  /** What the thread sleeps on (leadWait), if anything. */
  waitKind: (threadId: string) => WaitKind | null;
  /** The tool-call review's mark on the thread, if any. Absent: none. */
  heldBack?: (threadId: string) => HeldBackSignal | null;
}

/** One worker's signal: the one place it is built. */
export function workerSignal(
  deps: Pick<ThreadSignalDeps, "workStore" | "isBusy" | "waitKind" | "heldBack"> & { agentStore: Pick<AgentStore, "getThreadByScope"> },
  workerId: string,
  /** Its plan, as its state reads it. */
  plan: PlanStateView
): ThreadWorkerSignal {
  const item = deps.workStore.getByWorker(workerId);
  const thread = deps.agentStore.getThreadByScope("worker", workerId);
  const asking = isAsking(plan);
  return {
    waiting: waitingOnYou(item?.failedAt ?? null, item?.failedKind ?? null),
    asking,
    running: thread ? deps.isBusy(thread.id) : false,
    watching: thread ? deps.waitKind(thread.id) : null,
    stepInProgress: hasStepInProgress(plan),
    heldBack: thread ? deps.heldBack?.(thread.id) ?? null : null
  };
}

/** The signals of every active worker a thread owns. */
export function workerSignalsOf(deps: ThreadSignalDeps, ownerThreadId: string): ThreadWorkerSignal[] {
  return deps.workersStore.listActiveOwnedBy(ownerThreadId).map((w) => workerSignal(deps, w.id, deps.planStore.stateOf(w.id)));
}

/** A manager thread's own signal. Running means busy: a turn running, a
 *  message waiting to start one, or a follow-up due. */
export function threadSignalOf(deps: Pick<ThreadSignalDeps, "isBusy" | "waitKind" | "heldBack">, dto: ManagerThreadDto): ThreadSignal {
  return {
    running: dto.running || deps.isBusy(dto.id), failed: dto.failed, watching: deps.waitKind(dto.id), asking: dto.questions.length > 0,
    heldBack: deps.heldBack?.(dto.id) ?? null
  };
}

/** How the target of a wait has stopped, or null while it has not. The
 *  target is a manager thread (judged with every active worker it owns) or a
 *  worker's own chat (judged alone). One that is gone is not judged here:
 *  the archive paths end its waits. */
export function stopOfTarget(deps: ThreadSignalDeps, threadId: string): ThreadStop | null {
  const thread = deps.agentStore.getThreadById(threadId);
  if (!thread || thread.archivedAt) return null;
  if (thread.scope === "worker") return thread.scopeId ? workerStop(workerSignal(deps, thread.scopeId, deps.planStore.stateOf(thread.scopeId))) : null;
  const dto = new ManagerThreadService({ agentStore: deps.agentStore }).dto(threadId);
  if (!dto) return null;
  // Its manager's own question to the user: the thread needs them once it has stopped.
  return threadStop({ ...threadSignalOf(deps, dto), running: deps.isBusy(threadId) }, workerSignalsOf(deps, threadId));
}

/** How a manager thread has stopped judged on its own, or null while its own
 *  turn runs or waits to start: neither its workers nor what it watches keep
 *  it open. A duty thread is judged so, since each of its turns reports. A
 *  worker's chat is judged as stopOfTarget judges it. */
export function ownStopOf(deps: ThreadSignalDeps, threadId: string): ThreadStop | null {
  const thread = deps.agentStore.getThreadById(threadId);
  if (!thread || thread.archivedAt || thread.scope === "worker") return stopOfTarget(deps, threadId);
  const dto = new ManagerThreadService({ agentStore: deps.agentStore }).dto(threadId);
  if (!dto) return null;
  return threadStop({ ...threadSignalOf(deps, dto), running: deps.isBusy(threadId), watching: null }, []);
}
