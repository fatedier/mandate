import type { AgentStore } from "../agent/agent-store.js";
import type { WorkersStore } from "./workers-store.js";
import { threadDisplayTitle } from "../agent/manager-threads.js";

/** Null when the caller may direct this worker; otherwise the sentence the
 *  tool answers with. */
export function ownerRefusal(
  deps: { workersStore: Pick<WorkersStore, "getById">; agentStore: AgentStore },
  workerId: string,
  caller: string
): string | null {
  const worker = deps.workersStore.getById(workerId);
  if (!worker?.ownerThreadId || worker.ownerThreadId === caller) return null;
  const title = threadDisplayTitle(deps.agentStore, worker.ownerThreadId);
  return `Worker "${worker.name}" belongs to the thread "${title}". Ask the user to continue there.`;
}

function isOpenManagerThread(agentStore: Pick<AgentStore, "getThreadById">, threadId: string | null | undefined): threadId is string {
  if (!threadId) return false;
  const t = agentStore.getThreadById(threadId);
  return Boolean(t && t.scope === "manager" && !t.archivedAt);
}

/** An active worker always has an open owner thread.
 *  Takes `preferred` when it is an open manager thread; otherwise keeps a
 *  current owner that is still open; otherwise opens a thread named after the
 *  worker. Null when the worker does not exist. */
export function ensureOpenOwner(
  deps: {
    workersStore: Pick<WorkersStore, "getById" | "setOwner">;
    agentStore: Pick<AgentStore, "getThreadById" | "createManagerThread">;
  },
  workerId: string,
  preferred: string | null = null
): { ownerThreadId: string; changed: boolean } | null {
  const worker = deps.workersStore.getById(workerId);
  if (!worker) return null;
  if (isOpenManagerThread(deps.agentStore, preferred) && preferred !== worker.ownerThreadId) {
    deps.workersStore.setOwner(workerId, preferred);
    return { ownerThreadId: preferred, changed: true };
  }
  if (isOpenManagerThread(deps.agentStore, worker.ownerThreadId)) {
    return { ownerThreadId: worker.ownerThreadId, changed: false };
  }
  const thread = deps.agentStore.createManagerThread(worker.name);
  deps.workersStore.setOwner(workerId, thread.id);
  return { ownerThreadId: thread.id, changed: true };
}
