import { useEffect, useState } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { useWorkItemsStore } from "@/store/work-items";
import { api } from "@/lib/api-paths";
import { RelativeTime } from "@/components/RelativeTime";
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
  }, [featureId]);

  const open = (id: string) => {
    navigate(`/canvas/${id}`, { state: { backgroundLocation: location } });
  };

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {error}
      </div>
    );
  }

  if (!canvases) {
    return (
      <div className="rounded-lg border border-border-soft bg-muted/30 p-3 text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (canvases.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border-soft px-3 py-10 text-center text-sm text-muted-foreground">
        No canvases yet. The agent's canvases for this feature will show up here.
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {canvases.map((canvas) => {
        const isDashboard = canvas.id === boundCanvasId;
        return (
          <li key={canvas.id}>
            <button
              type="button"
              onClick={() => open(canvas.id)}
              className="group flex w-full items-center gap-3 rounded-lg border border-border-soft bg-card px-3 py-2.5 text-left transition hover:border-border hover:bg-muted/40"
              aria-label={`Open canvas: ${canvas.title}`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-soft bg-muted/40 text-muted-foreground">
                <FileText className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{canvas.title}</span>
                  {isDashboard && (
                    <span className="shrink-0 rounded-xs border border-primary/30 bg-primary/10 px-1.5 py-0.5 label-micro text-primary">
                      Dashboard
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Updated <RelativeTime value={canvas.updatedAt} />
                </span>
              </span>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
