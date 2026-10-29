import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureChangesResponse } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";
import { ChangesDiffCache } from "./changes-diff-cache";
import { errorText } from "@shared/error-text";

type CompareMode = FeatureChangesResponse["compare"];
type Context = { featureId: string; compare: CompareMode };
interface ChangesView {
  context: Context;
  data: FeatureChangesResponse | null;
  diffs: ChangesDiffCache | null;
  revision: number;
  error: string;
  /** The server's name for the failure, when it has one (worktree_missing). */
  errorCode: string | null;
  refreshing: boolean;
}

export function useChanges(featureId: string, compare: CompareMode, planStamp: string) {
  const context = useMemo(() => ({ featureId, compare }), [featureId, compare]);
  const [view, setView] = useState<ChangesView | null>(null);
  const sequence = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const displayedCache = useRef<ChangesDiffCache | null>(null);

  const load = useCallback(async () => {
    listRequest.current?.abort();
    const controller = new AbortController();
    listRequest.current = controller;
    const revision = ++sequence.current;
    const { signal } = controller;
    setView((previous) => ({
      context,
      data: previous?.context === context ? previous.data : null,
      diffs: previous?.context === context ? previous.diffs : null,
      revision: previous?.revision ?? 0,
      error: "",
      errorCode: null,
      refreshing: true
    }));
    try {
      const res = await fetch(api.featureChanges(context.featureId, context.compare), { signal });
      if (!res.ok) {
        let message = `request failed (${res.status})`;
        let code: string | null = null;
        try {
          const body = (await res.json()) as { error?: string; code?: string };
          if (body.error) message = body.error;
          code = body.code ?? null;
        } catch {
          // Keep the status fallback for non-JSON error bodies.
        }
        throw Object.assign(new Error(message), { code });
      }
      const data = (await res.json()) as FeatureChangesResponse;
      if (signal.aborted) return;
      // The old list stays interactive during refresh. Retire its cache only
      // when the replacement is ready, including any unfinished patch reads.
      const diffs = new ChangesDiffCache(context.featureId, context.compare);
      displayedCache.current?.dispose();
      displayedCache.current = diffs;
      setView({ context, data, diffs, revision, error: "", errorCode: null, refreshing: false });
    } catch (error) {
      if (signal.aborted) return;
      setView((previous) => previous?.context === context ? {
        ...previous,
        error: errorText(error, "failed to load changes"),
        errorCode: (error as { code?: string | null }).code ?? null,
        refreshing: false
      } : previous);
    }
  }, [context]);

  useEffect(() => {
    // Work-item transitions invalidate working-tree patches even if HEAD and
    // file counts have not changed. Defer state updates until after the effect.
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => {
      window.clearTimeout(timer);
      listRequest.current?.abort();
    };
  }, [load, planStamp]);

  useEffect(() => () => {
    displayedCache.current?.dispose();
    displayedCache.current = null;
  }, [context]);

  return { view: view?.context === context ? view : null, load };
}
