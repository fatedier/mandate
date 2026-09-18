import { useEffect, useState } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { useWorkItemsStore } from "@/store/work-items";
import { api } from "@/lib/api-paths";
import { RelativeTime } from "@/components/RelativeTime";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { CanvasListItemDto, CanvasUpdatedPayload, FeatureCanvasesResponse } from "@shared/api-contracts";

interface Props { featureId: string; }

/** Lists every canvas scoped to this feature — the bound dashboard plus any
 *  one-off artifacts the agent created (reports, plans, task_complete outputs)
 *  that otherwise had no home on the feature page. Clicking opens the canvas
 *  in the fullscreen modal. */
export function FeatureArtifactsTab({ featureId }: Props) {
  const boundCanvasId = useWorkItemsStore((s) => {
    for (const v of s.items.values()) {
      if (v.featureId === featureId) return v.canvasId;
    }
    return null;
  });

  const [result, setResult] = useState<{
    featureId: string;
    canvases: CanvasListItemDto[] | null;
    error: string | null;
  } | null>(null);
  // Bumped by the Retry button; the fetch effect keys on it so a manual retry
  // re-runs the same debounced schedule the listeners use.
  const [retryToken, setRetryToken] = useState(0);
  const canvases = result?.featureId === featureId ? result.canvases : null;
  const error = result?.featureId === featureId ? result.error : null;
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let disposed = false;
    let dirty = false;
    let timer: number | undefined;
    let request: AbortController | undefined;

    // Use a fixed window so bursts coalesce without postponing refresh forever.
    const schedule = (delay = 100) => {
      if (disposed) return;
      dirty = true;
      if (request || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void refresh();
      }, delay);
    };
    const refresh = async () => {
      dirty = false;
      const controller = new AbortController();
      request = controller;
      try {
        const res = await fetch(api.featureCanvases(featureId), { signal: controller.signal });
        const payload = (await res.json()) as FeatureCanvasesResponse;
        // Requests are serialized, so a slow response cannot overwrite a later
        // one. Still display progress when updates keep arriving during fetches.
        if (controller.signal.aborted) return;
        if (!res.ok || "error" in payload) {
          setResult({ featureId, canvases: null, error: "error" in payload ? payload.error : res.statusText });
        } else {
          setResult({ featureId, canvases: payload.canvases, error: null });
        }
      } catch (err) {
        if (!controller.signal.aborted && !dirty) {
          setResult({ featureId, canvases: null, error: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        request = undefined;
        if (dirty) schedule();
      }
    };

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<CanvasUpdatedPayload>).detail;
      if (detail?.featureId !== featureId) return;
      schedule();
    };
    const onReconnect = () => schedule();
    schedule(0);
    window.addEventListener("mandate:canvas-updated", handler);
    window.addEventListener("mandate:sse-open", onReconnect);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      request?.abort();
      window.removeEventListener("mandate:canvas-updated", handler);
      window.removeEventListener("mandate:sse-open", onReconnect);
    };
  }, [featureId, retryToken]);

  const open = (id: string) => {
    navigate(`/canvas/${id}`, { state: { backgroundLocation: location } });
  };

  if (error) {
    return (
      <div data-slot="canvas-list-failed" className="flex items-center gap-3 py-2 text-xs text-faint">
        <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
        <Button variant="ghost" size="xs" aria-label="Retry canvases" onClick={() => { setResult(null); setRetryToken((t) => t + 1); }}>Retry</Button>
      </div>
    );
  }

  if (!canvases) {
    return (
      <div data-slot="canvas-list" aria-busy="true" aria-label="Loading canvases" className="overflow-hidden rounded-lg border border-border-soft bg-panel">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-13 items-center gap-3 border-t border-border-soft px-3.5 first:border-t-0">
            <Skeleton className="size-4 rounded-xs bg-sel" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-48 rounded-xs bg-sel" />
              <Skeleton className="h-3 w-24 rounded-xs bg-sel" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (canvases.length === 0) {
    return (
      <p data-slot="canvas-empty" className="m-0 py-2 text-xs text-faint">
        No canvases yet. The agent's canvases for this feature will show up here.
      </p>
    );
  }

  return (
    <ul data-slot="canvas-list" className="overflow-hidden rounded-lg border border-border-soft bg-panel">
      {canvases.map((canvas) => {
        const isDashboard = canvas.id === boundCanvasId;
        return (
          <li key={canvas.id} data-slot="canvas-row" className="border-t border-border-soft first:border-t-0">
            <button
              type="button"
              onClick={() => open(canvas.id)}
              className="group flex h-13 w-full items-center gap-3 px-3.5 text-left transition-colors hover:bg-sel"
              aria-label={`Open canvas: ${canvas.title}`}
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-xs font-medium text-foreground">{canvas.title}</span>
                  {isDashboard && <span className="pill pill-neutral">Dashboard</span>}
                </span>
                <span className="mt-0.5 block text-2xs text-faint">
                  Updated <RelativeTime value={canvas.updatedAt} />
                </span>
              </span>
              <ArrowUpRight className="size-3.5 shrink-0 text-faint transition-colors group-hover:text-foreground" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
