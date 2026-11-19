import { useEffect, useState } from "react";
import type { WorkerChangesResponse } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";

interface ChangesSummary {
  additions: number;
  deletions: number;
  files: number;
}

interface CacheEntry { stamp: string; summary: ChangesSummary }

/** Last summary per worker. Keyed on the plan stamp the Changes tab
 *  already uses to invalidate its own data, so a plan change refreshes the
 *  line the same way it refreshes the tab. */
const cache = new Map<string, CacheEntry>();

export function resetChangesSummaryCache(): void {
  cache.clear();
}

function toSummary(data: WorkerChangesResponse): ChangesSummary {
  return { additions: data.totalAdditions, deletions: data.totalDeletions, files: data.files.length };
}

export function useChangesSummary(workerId: string | null, planStamp: string) {
  const cached = workerId ? cache.get(workerId) : undefined;
  const fresh = cached?.stamp === planStamp;
  const [state, setState] = useState<{ workerId: string; summary: ChangesSummary | null; error: string | null; loading: boolean } | null>(null);

  useEffect(() => {
    if (!workerId) return;
    let disposed = false;
    const controller = new AbortController();
    const load = async () => {
      setState({ workerId, summary: cache.get(workerId)?.summary ?? null, error: null, loading: true });
      try {
        const res = await fetch(api.workerChanges(workerId, "head"), { signal: controller.signal });
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        const data = (await res.json()) as WorkerChangesResponse;
        if (disposed) return;
        const summary = toSummary(data);
        cache.set(workerId, { stamp: planStamp, summary });
        setState({ workerId, summary, error: null, loading: false });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setState({ workerId, summary: null, error: errorText(error), loading: false });
      }
    };
    // A fresh cache skips the initial load only. The reconnect listener is
    // registered regardless — the server may have moved while the socket was
    // down, and the cache cannot know that.
    if (cache.get(workerId)?.stamp !== planStamp) void load();
    const onReconnect = () => { void load(); };
    window.addEventListener("mandate:sse-open", onReconnect);
    return () => {
      disposed = true;
      controller.abort();
      window.removeEventListener("mandate:sse-open", onReconnect);
    };
  }, [workerId, planStamp]);

  if (!workerId) return { summary: null, error: null, loading: false };
  if (fresh && cached) return { summary: cached.summary, error: null, loading: false };
  if (state?.workerId === workerId) return { summary: state.summary, error: state.error, loading: state.loading };
  return { summary: cached?.summary ?? null, error: null, loading: true };
}
