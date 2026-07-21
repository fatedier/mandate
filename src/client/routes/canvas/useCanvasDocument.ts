import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-paths";
import type { CanvasDocumentDto, CanvasDocumentResponse, CanvasUpdatedPayload } from "@shared/api-contracts";

type Update =
  | { type: "loading" }
  | { type: "unavailable" }
  | { type: "loaded"; canvas: CanvasDocumentDto }
  | { type: "error"; error: string; clear: boolean };
type Listener = (update: Update) => void;
interface RequestEntry {
  canvasId: string;
  listeners: Set<Listener>;
  request: AbortController | null;
  dirty: boolean;
  dispose: () => void;
}

// Only mounted readers and their current requests live here. Completed
// documents remain in the components; this adds no document cache or TTL.
const entries = new Map<string, RequestEntry>();

function notify(entry: RequestEntry, update: Update) {
  for (const listener of entry.listeners) listener(update);
}

async function load(entry: RequestEntry) {
  if (!entry.listeners.size) return;
  const controller = new AbortController();
  entry.request = controller;
  entry.dirty = false;
  notify(entry, { type: "loading" });
  let clear = false;
  try {
    const response = await fetch(api.canvasById(entry.canvasId), { signal: controller.signal });
    if (controller.signal.aborted) return;
    clear = [401, 403, 404, 410].includes(response.status);
    if (clear) notify(entry, { type: "unavailable" });
    const payload = await response.json() as CanvasDocumentResponse;
    if (controller.signal.aborted) return;
    if (!response.ok || "error" in payload) {
      notify(entry, { type: "error", error: "error" in payload ? payload.error : response.statusText, clear });
    } else {
      // Requests stay serialized through body parsing. Display completed
      // responses even during continuous updates so readers still make progress.
      notify(entry, { type: "loaded", canvas: payload.canvas });
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      notify(entry, { type: "error", error: error instanceof Error ? error.message : String(error), clear });
    }
  } finally {
    entry.request = null;
    if (entry.dirty && entry.listeners.size) void load(entry);
  }
}

function refresh(entry: RequestEntry) {
  if (entry.request) entry.dirty = true;
  else void load(entry);
}

function subscribe(canvasId: string, listener: Listener): () => void {
  let entry = entries.get(canvasId);
  if (!entry) {
    const created: RequestEntry = { canvasId, listeners: new Set(), request: null, dirty: false, dispose: () => {} };
    const onUpdate = (event: Event) => {
      if ((event as CustomEvent<CanvasUpdatedPayload>).detail?.canvasId === canvasId) refresh(created);
    };
    const onReconnect = () => refresh(created);
    window.addEventListener("mandate:canvas-updated", onUpdate);
    window.addEventListener("mandate:sse-open", onReconnect);
    created.dispose = () => {
      window.removeEventListener("mandate:canvas-updated", onUpdate);
      window.removeEventListener("mandate:sse-open", onReconnect);
    };
    entries.set(canvasId, created);
    entry = created;
  }
  entry.listeners.add(listener);
  // Joining a request is not an invalidation and must not schedule a follow-up.
  if (entry.request) listener({ type: "loading" });
  else void load(entry);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size) return;
    entry.dispose();
    entries.delete(canvasId);
    entry.request?.abort();
  };
}

interface DocumentState {
  canvasId: string;
  canvas: CanvasDocumentDto | null;
  error: string | null;
  loading: boolean;
}

export function useCanvasDocument(canvasId: string) {
  const [state, setState] = useState<DocumentState | null>(null);
  useEffect(() => {
    if (!canvasId) return;
    return subscribe(canvasId, (update) => setState((previous) => {
      const canvas = previous?.canvasId === canvasId ? previous.canvas : null;
      if (update.type === "loading") return { canvasId, canvas, error: null, loading: true };
      if (update.type === "unavailable") return { canvasId, canvas: null, error: null, loading: true };
      if (update.type === "loaded") return { canvasId, canvas: update.canvas, error: null, loading: false };
      return { canvasId, canvas: update.clear ? null : canvas, error: update.error, loading: false };
    }));
  }, [canvasId]);

  const reload = useCallback((clear = false) => {
    const entry = entries.get(canvasId);
    if (!entry) return;
    // The full-page Refresh control explicitly rebuilds its own frame. Other
    // readers keep their drafts while sharing the same document request.
    if (clear) setState({ canvasId, canvas: null, error: null, loading: true });
    refresh(entry);
  }, [canvasId]);

  return {
    canvas: state?.canvasId === canvasId ? state.canvas : null,
    error: !canvasId ? "Canvas id is missing." : state?.canvasId === canvasId ? state.error : null,
    loading: Boolean(canvasId) && (state?.canvasId !== canvasId || state.loading),
    refresh: reload
  };
}
