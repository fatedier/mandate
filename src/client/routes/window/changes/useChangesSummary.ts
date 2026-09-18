import { useEffect, useState } from "react";
import type { FeatureChangesResponse } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";

export interface ChangesSummary {
  additions: number;
  deletions: number;
  files: number;
  compare: "head";
}

interface CacheEntry { stamp: string; summary: ChangesSummary }

/** Last summary per feature. Keyed on the work-item stamp the Changes tab
 *  already uses to invalidate its own data, so a phase transition refreshes
 *  the line the same way it refreshes the tab. */
const cache = new Map<string, CacheEntry>();

export function resetChangesSummaryCache(): void {
  cache.clear();
}

function toSummary(data: FeatureChangesResponse): ChangesSummary {
  return { additions: data.totalAdditions, deletions: data.totalDeletions, files: data.files.length, compare: "head" };
}

export function useChangesSummary(featureId: string | null, workItemStamp: string) {
  const cached = featureId ? cache.get(featureId) : undefined;
  const fresh = cached?.stamp === workItemStamp;
  const [state, setState] = useState<{ featureId: string; summary: ChangesSummary | null; error: string | null; loading: boolean } | null>(null);

  useEffect(() => {
    if (!featureId) return;
    let disposed = false;
    const controller = new AbortController();
    const load = async () => {
      setState({ featureId, summary: cache.get(featureId)?.summary ?? null, error: null, loading: true });
      try {
        const res = await fetch(api.featureChanges(featureId, "head"), { signal: controller.signal });
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        const data = (await res.json()) as FeatureChangesResponse;
        if (disposed) return;
        const summary = toSummary(data);
        cache.set(featureId, { stamp: workItemStamp, summary });
        setState({ featureId, summary, error: null, loading: false });
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        setState({ featureId, summary: null, error: error instanceof Error ? error.message : String(error), loading: false });
      }
    };
    // A fresh cache skips the initial load only. The reconnect listener is
    // registered regardless — the server may have moved while the socket was
    // down, and the cache cannot know that.
    if (cache.get(featureId)?.stamp !== workItemStamp) void load();
    const onReconnect = () => { void load(); };
    window.addEventListener("mandate:sse-open", onReconnect);
    return () => {
      disposed = true;
      controller.abort();
      window.removeEventListener("mandate:sse-open", onReconnect);
    };
  }, [featureId, workItemStamp]);

  if (!featureId) return { summary: null, error: null, loading: false };
  if (fresh && cached) return { summary: cached.summary, error: null, loading: false };
  if (state?.featureId === featureId) return { summary: state.summary, error: state.error, loading: state.loading };
  return { summary: cached?.summary ?? null, error: null, loading: true };
}
