import type { AgentThreadResponse } from "@shared/api-contracts";
import { endpointBase } from "./agent-chat-api";
import { compareTimelineMessages, newThreadState, scopeKey } from "./agent-chat-utils";
import type {
  AgentChatGet,
  AgentChatScope,
  AgentChatSet,
  AgentChatStore,
  ThreadState
} from "./agent-chat-types";

export function updateThread(
  set: AgentChatSet,
  scope: AgentChatScope,
  mutate: (t: ThreadState) => ThreadState
) {
  set((state: AgentChatStore) => {
    const key = scopeKey(scope);
    const current = state.threadsByScope.get(key) ?? newThreadState();
    const updated = mutate(current);
    if (updated === current) return {};
    const next = new Map(state.threadsByScope);
    next.set(key, updated);
    return { threadsByScope: next };
  });
}

export function findScopeKeyByThreadId(state: AgentChatStore, threadId: string): string | null {
  for (const [k, t] of state.threadsByScope) {
    if (t.threadId === threadId) return k;
  }
  return null;
}

export function updateThreadByKey(
  set: AgentChatSet,
  key: string,
  mutate: (t: ThreadState) => ThreadState
) {
  set((state: AgentChatStore) => {
    const next = new Map(state.threadsByScope);
    const current = next.get(key);
    if (!current) return {};
    next.set(key, mutate(current));
    return { threadsByScope: next };
  });
}

export async function refetchScopeSince(
  set: AgentChatSet,
  get: AgentChatGet,
  scope: AgentChatScope,
  since: number
): Promise<void> {
  const threadId = get().threadsByScope.get(scopeKey(scope))?.threadId;
  if (!threadId) return;
  const r = await fetch(`${endpointBase(scope)}/thread?since=${since}`);
  if (!r.ok) return;
  const body = await r.json() as AgentThreadResponse;
  if ("error" in body || body.thread?.id !== threadId) return;
  if (get().threadsByScope.get(scopeKey(scope))?.threadId !== threadId) return;
  updateThread(set, scope, (t) => ({
    ...t,
    contextUsage: body.contextUsage ?? t.contextUsage
  }));
  const sorted = [...body.messages].sort(compareTimelineMessages);
  for (const m of sorted) {
    get().onMessageAppended(m.threadId, m, true);
  }
}
