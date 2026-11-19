import type { ConversationScope } from "../../../shared/api/agents.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { AgentStore, AgentThread } from "./agent-store.js";
import type { BackgroundTaskStore } from "./background-task-store.js";
import { threadDisplayTitle } from "./manager-threads.js";

/** A subagent's thread reaches the thread that started it through its task:
 *  threads carry no parent link of their own. */
export interface SubagentThreadDeps {
  agentStore: Pick<AgentStore, "getThreadById">;
  backgroundTasks: Pick<BackgroundTaskStore, "getByChildThread">;
}

/** The thread a subagent works for: a conversation, never a subagent's. */
export type SubagentParent = AgentThread & { scope: ConversationScope };

/** The thread a subagent's thread works for; null for any other thread, and
 *  for a subagent whose task or parent is gone. */
export function subagentParentOf(deps: SubagentThreadDeps, threadId: string): SubagentParent | null {
  const task = deps.backgroundTasks.getByChildThread(threadId);
  if (!task) return null;
  const parent = deps.agentStore.getThreadById(task.parentThreadId);
  // No nesting: a subagent never starts another; nor does a side chat.
  return parent && parent.scope !== "subagent" && parent.scope !== "side_chat" ? (parent as SubagentParent) : null;
}

/** The scope a thread's model calls and input checks follow: its own, for
 *  a subagent's thread its parent's, for a side chat the personal agent's. Undefined for a thread that is gone,
 *  and for a subagent whose parent is. */
export function conversationScopeOf(deps: SubagentThreadDeps, threadId: string): ConversationScope | undefined {
  const thread = deps.agentStore.getThreadById(threadId);
  if (!thread) return undefined;
  if (thread.scope === "side_chat") return "personal";
  if (thread.scope !== "subagent") return thread.scope;
  return subagentParentOf(deps, threadId)?.scope;
}

/** Who a subagent's task says handed it over: a manager thread by the title
 *  a person sees, a worker by its worker's name, the personal agent as itself. */
export function subagentAskedBy(
  deps: { agentStore: AgentStore; workersStore: Pick<WorkersStore, "getById"> },
  parent: AgentThread
): string {
  if (parent.scope === "personal") return "Personal agent";
  if (parent.scope === "worker") {
    const worker = parent.scopeId ? deps.workersStore.getById(parent.scopeId) : null;
    return worker?.name ?? "a worker";
  }
  return threadDisplayTitle(deps.agentStore, parent.id);
}
