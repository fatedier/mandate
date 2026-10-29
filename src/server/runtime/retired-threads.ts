import type { AgentWakeReason } from "../../shared/api-contracts.js";
import type { AgentStore, AgentThread } from "../modules/agent/agent-store.js";
import type { BackgroundTaskStore } from "../modules/agent/background-task-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";

/**
 * A conversation is retired when its feature is archived — on its own, or
 * with its project, which archives every feature in it. Nothing should wake a
 * retired conversation on its own any more; the user still can.
 *
 * Archiving never touched the worker's thread or what it had scheduled, so an
 * archived feature kept polling on its own alarms, long after
 * its archive. Checking at wake time covers every archive path —
 * the feature route, the manager's tool, a project archive — without each of
 * them having to remember a cleanup step.
 *
 * A subagent works for the conversation that started it and is retired with
 * it: once its parent is archived, or retired itself, nobody is left to read
 * what it would write. A project archive stops nothing on its way, and a
 * worker's turn can outlive its feature's archive and ask for one more, so
 * the first wake refused for a retired conversation, or for one of its
 * subagents, stops all of its subagents, unannounced, as an archive does.
 */
export function createRetiredThreadGuard(deps: {
  agentStore: Pick<AgentStore, "getThreadById">;
  featuresStore: Pick<FeaturesStore, "getById">;
  /** Whose a subagent's thread is: its task names the parent. */
  backgroundTasks: Pick<BackgroundTaskStore, "get">;
  /** Cancel the thread's pending alarms, window watches and monitors. */
  cancelThreadWakeSources: (threadId: string) => void;
  /** Stop a conversation's queued and running subagents without telling it. */
  stopBackgroundTasks: (parentThreadId: string) => void;
}) {
  // A worker thread carries its feature's id.
  const featureArchived = (thread: AgentThread): boolean =>
    thread.scope === "worker" && thread.scopeId !== null && Boolean(deps.featuresStore.getById(thread.scopeId)?.archivedAt);
  /** The conversation a subagent's thread works for; null once its task or its parent is gone. */
  const parentOf = (thread: AgentThread): AgentThread | null => {
    const parentId = thread.scopeId ? deps.backgroundTasks.get(thread.scopeId)?.parentThreadId : undefined;
    return parentId ? deps.agentStore.getThreadById(parentId) : null;
  };
  return {
    isThreadRetired(threadId: string): boolean {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread) return false;
      if (thread.scope !== "subagent") return featureArchived(thread);
      const parent = parentOf(thread);
      return !parent || parent.archivedAt !== null || featureArchived(parent);
    },
    onRetiredWakeRefused(threadId: string, reason: AgentWakeReason): void {
      deps.cancelThreadWakeSources(threadId);
      const thread = deps.agentStore.getThreadById(threadId);
      const owner = thread?.scope === "subagent" ? parentOf(thread)?.id ?? null : threadId;
      if (owner) deps.stopBackgroundTasks(owner);
      const why = thread?.scope === "subagent" ? "the conversation it works for is archived or retired" : "its feature is archived";
      console.log(`[mandate] refused a ${reason} wake of ${threadId}: ${why}; cleared its alarms, window watches, monitors and subagents`);
    }
  };
}
