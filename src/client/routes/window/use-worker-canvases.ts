import { useEffect, useState } from "react";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";
import type { CanvasListItemDto, CanvasUpdatedPayload, WorkerCanvasesResponse } from "@shared/api-contracts";

export interface WorkerCanvasesState {
  /** The worker these canvases belong to. */
  workerId: string;
  canvases: CanvasListItemDto[] | null;
  error: string | null;
  retry(): void;
}

/** Every canvas scoped to a worker, kept current: refetched when one of them
 *  is updated (bursts coalesce) and after an SSE reconnect. */
export function useWorkerCanvases(workerId: string): WorkerCanvasesState {
  const [result, setResult] = useState<{
    workerId: string;
    canvases: CanvasListItemDto[] | null;
    error: string | null;
  } | null>(null);
  // Bumped by the Retry button; the fetch effect keys on it so a manual retry
  // re-runs the same debounced schedule the listeners use.
  const [retryToken, setRetryToken] = useState(0);

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
        const res = await fetch(api.workerCanvases(workerId), { signal: controller.signal });
        const payload = (await res.json()) as WorkerCanvasesResponse;
        // Requests are serialized, so a slow response cannot overwrite a later
        // one. Still display progress when updates keep arriving during fetches.
        if (controller.signal.aborted) return;
        if (!res.ok || "error" in payload) {
          setResult({ workerId, canvases: null, error: "error" in payload ? payload.error : res.statusText });
        } else {
          setResult({ workerId, canvases: payload.canvases, error: null });
        }
      } catch (err) {
        if (!controller.signal.aborted && !dirty) {
          setResult({ workerId, canvases: null, error: errorText(err) });
        }
      } finally {
        request = undefined;
        if (dirty) schedule();
      }
    };

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<CanvasUpdatedPayload>).detail;
      if (detail?.workerId !== workerId) return;
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
  }, [workerId, retryToken]);

  return {
    workerId,
    canvases: result?.workerId === workerId ? result.canvases : null,
    error: result?.workerId === workerId ? result.error : null,
    retry: () => { setResult(null); setRetryToken((t) => t + 1); }
  };
}
