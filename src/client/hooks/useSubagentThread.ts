import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { errorText } from "@shared/error-text";
import { generationOf, scopeKey, useAgentChatStore, type ChatThreadScope, type ThreadState } from "@/store/agent-chat";

/** The older page each subagent's conversation has asked for, by thread: its
 *  cursor, the entry it was asked for (generationOf: one let go and read
 *  again asks anew, and hears nothing of a request from before), and why it
 *  failed (null while on its way). One request per page whichever view asks
 *  (StrictMode runs effects twice; a closed and reopened view is a new one),
 *  or both answers would join its steps; and every view of it hears how that
 *  request ended. A failed page stays asked for until Retry. */
interface OlderRead {
  cursor: number;
  generation: number;
  failed: string | null;
}
const olderReads = new Map<string, OlderRead>();
const olderListeners = new Set<() => void>();
function setOlderRead(threadId: string, read: OlderRead | null): void {
  if (read) olderReads.set(threadId, read);
  else olderReads.delete(threadId);
  for (const listener of olderListeners) listener();
}
function subscribeOlder(listener: () => void): () => void {
  olderListeners.add(listener);
  return () => { olderListeners.delete(listener); };
}

/** A subagent's conversation, read only: loaded as the chat scope
 *  `{ type: "subagent", threadId }`, so its live events land in it (the store
 *  drops events for a thread it has not loaded), and held while a view shows
 *  it: let go when none does. `whole`: every page of it,
 *  older ones one after another until its start, for its full list of steps;
 *  each page asked for once. `error`: why its first page could not be read,
 *  until `retry` reads it again; `olderError`: why an older page could not,
 *  until `retryOlder` asks for it again. The thread is null for no thread,
 *  and until its entry exists. */
export function useSubagentConversation(
  threadId: string | null,
  { whole = false }: { whole?: boolean } = {}
): { thread: ThreadState | null; error: string | null; retry: () => void; olderError: string | null; retryOlder: () => void } {
  const scope = useMemo<ChatThreadScope | null>(() => (threadId === null ? null : { type: "subagent", threadId }), [threadId]);
  const key = scope === null ? null : scopeKey(scope);
  const thread = useAgentChatStore((s) => (key === null ? null : s.threadsByScope.get(key) ?? null));
  // Keyed by thread and attempt: another thread's failure never stands here,
  // and a retry clears it.
  const [failure, setFailure] = useState<{ key: string; attempt: number; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (scope === null || key === null) return;
    let live = true;
    // Held while shown: no view showing it, it is let go (holdThread).
    const release = useAgentChatStore.getState().holdThread(scope);
    useAgentChatStore.getState().ensureThreadLoaded(scope).catch((err: unknown) => {
      if (live) setFailure({ key, attempt, message: errorText(err) });
    });
    return () => { live = false; release(); };
  }, [scope, key, attempt]);
  const oldest = thread?.oldestSeqLoaded ?? null;
  const more = thread?.loaded === true && thread.hasMoreOlder;
  // What was asked for this entry only: one from before it was let go is none.
  const asked = useSyncExternalStore(subscribeOlder, () => (threadId === null ? null : olderReads.get(threadId) ?? null));
  const older = asked && key !== null && asked.generation === generationOf(key) ? asked : null;
  useEffect(() => {
    if (!whole || scope === null || key === null || threadId === null || !more || oldest === null) return;
    // Asked for already: on its way, or failed until Retry. Read now, not
    // from the render: under StrictMode the run before this one has asked.
    const generation = generationOf(key);
    const current = olderReads.get(threadId);
    if (current?.cursor === oldest && current.generation === generation) return;
    setOlderRead(threadId, { cursor: oldest, generation, failed: null });
    const ours = () => {
      const read = olderReads.get(threadId);
      return read?.cursor === oldest && read.generation === generation;
    };
    void useAgentChatStore.getState().loadOlder(scope).then(
      () => { if (ours()) setOlderRead(threadId, null); },
      (err: unknown) => { if (ours()) setOlderRead(threadId, { cursor: oldest, generation, failed: errorText(err) }); }
    );
  }, [whole, scope, key, threadId, more, oldest, older]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const retryOlder = useCallback(() => {
    if (threadId !== null && olderReads.get(threadId)?.failed != null) setOlderRead(threadId, null);
  }, [threadId]);
  const error = failure && failure.key === key && failure.attempt === attempt && thread?.loaded !== true ? failure.message : null;
  const olderError = more && older?.cursor === oldest ? older.failed : null;
  return { thread, error, retry, olderError, retryOlder };
}

/** A subagent's conversation, as `useSubagentConversation` reads it. */
export function useSubagentThread(threadId: string | null, options: { whole?: boolean } = {}): ThreadState | null {
  return useSubagentConversation(threadId, options).thread;
}
