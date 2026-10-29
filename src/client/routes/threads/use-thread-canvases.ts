import { useEffect, useState } from "react";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";
import type { CanvasListItemDto, ThreadCanvasesResponse } from "@shared/api-contracts";

/** A manager thread's canvases (its manager's and its workers'), newest
 *  first, kept current: read again when any canvas is published or deleted
 *  (bursts coalesce; which thread it belongs to is not in the event), when
 *  the thread's workers change (one restored here or moved away brings or
 *  takes its canvases; `workers` names them, and a restore or move anywhere
 *  says so too: an archived worker leaving was never among them) and after
 *  an SSE reconnect. */
export function useThreadCanvases(threadId: string, workers: string): { canvases: CanvasListItemDto[] | null; error: string | null } {
  const [result, setResult] = useState<{ threadId: string; canvases: CanvasListItemDto[] | null; error: string | null } | null>(null);

  useEffect(() => {
    let disposed = false;
    let dirty = false;
    let timer: number | undefined;
    let request: AbortController | undefined;

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
        const res = await fetch(api.threadCanvases(threadId), { signal: controller.signal });
        const payload = (await res.json()) as ThreadCanvasesResponse;
        if (controller.signal.aborted) return;
        if (!res.ok || "error" in payload) {
          setResult({ threadId, canvases: null, error: "error" in payload ? payload.error : res.statusText });
        } else {
          setResult({ threadId, canvases: payload.canvases, error: null });
        }
      } catch (err) {
        if (!controller.signal.aborted && !dirty) setResult({ threadId, canvases: null, error: errorText(err) });
      } finally {
        request = undefined;
        if (dirty) schedule();
      }
    };

    const onChange = () => schedule();
    schedule(0);
    window.addEventListener("mandate:canvas-updated", onChange);
    window.addEventListener("mandate:thread-workers-changed", onChange);
    window.addEventListener("mandate:sse-open", onChange);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      request?.abort();
      window.removeEventListener("mandate:canvas-updated", onChange);
      window.removeEventListener("mandate:thread-workers-changed", onChange);
      window.removeEventListener("mandate:sse-open", onChange);
    };
  }, [threadId, workers]);

  return {
    canvases: result?.threadId === threadId ? result.canvases : null,
    error: result?.threadId === threadId ? result.error : null
  };
}
