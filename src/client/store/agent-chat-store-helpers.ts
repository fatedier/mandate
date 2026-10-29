import { fetchScopeSince } from "./agent-chat-api";
import { compareTimelineMessages, newThreadState, reconcileMonitorsRead, reconcileWakeRead, scopeKey } from "./agent-chat-utils";
import type {
  AgentChatGet,
  AgentChatSet,
  AgentChatStore,
  ChatThreadScope,
  ThreadState
} from "./agent-chat-types";

export function updateThread(
  set: AgentChatSet,
  scope: ChatThreadScope,
  mutate: (t: ThreadState) => ThreadState
) {
  set((state: AgentChatStore) => {
    const key = scopeKey(scope);
    // A conversation's entry is created on first touch.
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

/** Each conversation's entry by when it was read: one let go (holdThread)
 *  and read again is a new one, and a read on its way for the old one writes
 *  nothing into it. */
const generations = new Map<string, number>();
export const generationOf = (key: string): number => generations.get(key) ?? 0;
export function retireEntry(key: string): void {
  generations.set(key, generationOf(key) + 1);
}

export async function refetchScopeSince(
  set: AgentChatSet,
  get: AgentChatGet,
  scope: ChatThreadScope,
  since: number
): Promise<void> {
  const key = scopeKey(scope);
  const threadId = get().threadsByScope.get(key)?.threadId;
  if (!threadId) return;
  const generation = generationOf(key);
  const body = await fetchScopeSince(scope, since);
  if (!body || body.thread?.id !== threadId) return;
  if (get().threadsByScope.get(key)?.threadId !== threadId || generationOf(key) !== generation) return;
  updateThread(set, scope, (t) => reconcileMonitorsRead(reconcileWakeRead({
    ...t,
    contextUsage: body.contextUsage ?? t.contextUsage
  }, body), body));
  const sorted = [...body.messages].sort(compareTimelineMessages);
  for (const m of sorted) {
    get().onMessageAppended(m.threadId, m, true);
  }
}
