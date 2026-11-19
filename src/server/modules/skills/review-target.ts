import type { AgentStore } from "../agent/agent-store.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { LearnedSkillStore } from "./learned-skill-store.js";
import type { SkillScope } from "./skill-frontmatter.js";

/** Messages a never-reviewed conversation's review starts from the end of. */
export const REVIEW_RECENT_MESSAGES = 300;

export interface ReviewTarget {
  threadId: string;
  title: string;
  fromSeq: number;
  toSeq: number;
}

interface Deps {
  agentStore: Pick<AgentStore, "getThreadById" | "getThreadByScope" | "listOpenManagerThreads" | "lastSeq">;
  workersStore: Pick<WorkersStore, "getById" | "listAllActive" | "listActiveOwnedBy" | "listArchivedOwnedBy">;
  store: Pick<LearnedSkillStore, "reviewMark">;
}

/**
 * The conversation a review request names, if the requester may ask for it:
 * its own (left blank), or one it handed work to — a manager its workers',
 * the personal agent any manager's or worker's (who asks is its thread's
 * kind). By id (a thread's or a worker's), archived ones count too; by name,
 * the ones the requester's context lists: a manager's workers, archived ones
 * included, or for the personal agent the active workers and the open
 * manager threads by title. The range runs from just past the last review
 * (or, never reviewed or nothing new since, the last REVIEW_RECENT_MESSAGES)
 * to the newest message.
 */
export function resolveReviewTarget(deps: Deps, requesterThreadId: string, ref: string | undefined): ReviewTarget | null {
  const own = deps.agentStore.getThreadById(requesterThreadId);
  if (!own || (own.scope !== "manager" && own.scope !== "personal")) return null;
  const requester = { threadId: own.id, scope: own.scope as SkillScope };
  const wanted = ref?.trim() ?? "";
  const thread = wanted === "" || wanted === requester.threadId ? own : findThread(deps, requester, wanted);
  if (!thread) return null;
  const toSeq = deps.agentStore.lastSeq(thread.id);
  if (toSeq <= 0) return null;
  const mark = deps.store.reviewMark(thread.id);
  const recent = Math.max(1, toSeq - REVIEW_RECENT_MESSAGES + 1);
  const fromSeq = mark !== null && mark < toSeq ? mark + 1 : recent;
  return { threadId: thread.id, title: thread.title ?? thread.id, fromSeq, toSeq };
}

function findThread(deps: Deps, requester: { threadId: string; scope: SkillScope }, wanted: string) {
  const workerThread = (workerId: string) => {
    if (requester.scope !== "personal" && deps.workersStore.getById(workerId)?.ownerThreadId !== requester.threadId) return null;
    return deps.agentStore.getThreadByScope("worker", workerId);
  };
  const byId = deps.agentStore.getThreadById(wanted);
  if (byId) {
    if (byId.scope === "worker" && byId.scopeId) return workerThread(byId.scopeId);
    if (byId.scope === "manager" && requester.scope === "personal") return byId;
    return null;
  }
  if (deps.workersStore.getById(wanted)) return workerThread(wanted);
  const lower = wanted.toLowerCase();
  const named = (requester.scope === "personal"
    ? deps.workersStore.listAllActive()
    : [...deps.workersStore.listActiveOwnedBy(requester.threadId), ...deps.workersStore.listArchivedOwnedBy(requester.threadId)])
    .filter((w) => w.name.toLowerCase() === lower)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (named) return workerThread(named.id);
  if (requester.scope === "personal") return deps.agentStore.listOpenManagerThreads().find((t) => (t.title ?? "").toLowerCase() === lower) ?? null;
  return null;
}
