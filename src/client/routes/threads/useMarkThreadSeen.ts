import { useEffect } from "react";
import { useAgentChatStore } from "@/store/agent-chat";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useReadPoint } from "@/routes/window/chat/new-replies";

/** A thread's conversation is seen while on screen (`inSight`): opening it,
 *  and every new row that lands while it is. A hidden browser tab does not
 *  count, and neither does a transcript still loading: nothing has been
 *  shown yet, even when a live row has already landed in it. An archived
 *  thread is not marked. */
export function useMarkThreadSeen(threadId: string, inSight: boolean): void {
  const markSeen = useManagerThreadsStore((s) => s.markSeen);
  const lastVisibleSeq = useManagerThreadsStore((s) => s.threads.get(threadId)?.lastVisibleSeq ?? null);
  const shown = useAgentChatStore((s) => s.threadsByScope.get(`manager:${threadId}`)?.loaded ?? false);
  useEffect(() => {
    if (!inSight || !shown || lastVisibleSeq === null) return;
    const mark = () => { if (document.visibilityState === "visible") markSeen(threadId, lastVisibleSeq); };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [markSeen, threadId, lastVisibleSeq, shown, inSight]);
}

/** Where the user had read the thread to when it came into sight: taken
 *  before useMarkThreadSeen moves it on. An archived thread has none. */
export function useThreadReadPoint(threadId: string, inSight: boolean): number | null {
  const seenSeq = useManagerThreadsStore((s) => s.threads.get(threadId)?.seenSeq ?? null);
  return useReadPoint(threadId, seenSeq, inSight);
}
