import type { AgentStore } from "../agent/agent-store.js";
import type { FeaturesStore } from "./features-store.js";
import { threadDisplayTitle } from "../agent/manager-threads.js";

/** Null when the caller may direct this worker; otherwise the sentence the
 *  tool answers with. A worker without an owner — only
 *  ones archived before threads existed — is anyone's. */
export function ownerRefusal(
  deps: { featuresStore: Pick<FeaturesStore, "getById">; agentStore: AgentStore },
  featureId: string,
  caller: string
): string | null {
  const feature = deps.featuresStore.getById(featureId);
  if (!feature?.ownerThreadId || feature.ownerThreadId === caller) return null;
  const title = threadDisplayTitle(deps.agentStore, feature.ownerThreadId);
  return `Worker "${feature.name}" belongs to the thread "${title}". Ask the user to continue there.`;
}

function isOpenManagerThread(agentStore: Pick<AgentStore, "getThreadById">, threadId: string | null | undefined): threadId is string {
  if (!threadId) return false;
  const t = agentStore.getThreadById(threadId);
  return Boolean(t && t.scope === "manager" && !t.archivedAt);
}

/** An active worker always has an open owner thread.
 *  Takes `preferred` when it is an open manager thread; otherwise keeps a
 *  current owner that is still open; otherwise opens a thread named after the
 *  worker. Null when the feature does not exist. */
export function ensureOpenOwner(
  deps: {
    featuresStore: Pick<FeaturesStore, "getById" | "setOwner">;
    agentStore: Pick<AgentStore, "getThreadById" | "createManagerThread">;
  },
  featureId: string,
  preferred: string | null = null
): { ownerThreadId: string; changed: boolean } | null {
  const feature = deps.featuresStore.getById(featureId);
  if (!feature) return null;
  if (isOpenManagerThread(deps.agentStore, preferred) && preferred !== feature.ownerThreadId) {
    deps.featuresStore.setOwner(featureId, preferred);
    return { ownerThreadId: preferred, changed: true };
  }
  if (isOpenManagerThread(deps.agentStore, feature.ownerThreadId)) {
    return { ownerThreadId: feature.ownerThreadId, changed: false };
  }
  const thread = deps.agentStore.createManagerThread(feature.name);
  deps.featuresStore.setOwner(featureId, thread.id);
  return { ownerThreadId: thread.id, changed: true };
}
