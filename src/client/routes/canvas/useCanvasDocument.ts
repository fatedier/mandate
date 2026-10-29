import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-paths";
import type { CanvasDocumentDto, CanvasDocumentResponse, CanvasUpdatedPayload } from "@shared/api-contracts";
import { errorText } from "@shared/error-text";

type Update =
  | { type: "loading" }
  | { type: "unavailable" }
  | { type: "loaded"; canvas: CanvasDocumentDto }
  | { type: "error"; error: string; clear: boolean };
type Listener = (update: Update) => void;
/** A mounted reader: what it is told, and whether it is on screen (a panel
 *  keeps a canvas tab drawn behind another). */
interface Reader {
  listener: Listener;
  shown: boolean;
}
interface RequestEntry {
  canvasId: string;
  listeners: Set<Reader>;
  request: AbortController | null;
  dirty: boolean;
  /** Changed (or the stream came back) while no reader was on screen: read
   *  once a reader shows it. */
  stale: boolean;
  dispose: () => void;
}

// Only mounted readers and their current requests live here. Completed
// documents remain in the components; this adds no document cache or TTL.
const entries = new Map<string, RequestEntry>();

function notify(entry: RequestEntry, update: Update) {
  for (const reader of entry.listeners) reader.listener(update);
}

async function load(entry: RequestEntry) {
  if (!entry.listeners.size) return;
  const controller = new AbortController();
  entry.request = controller;
  entry.dirty = false;
  entry.stale = false;
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
      notify(entry, { type: "error", error: errorText(error), clear });
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

/** A change heard: read now if a reader shows the canvas, else when one does. */
function changed(entry: RequestEntry) {
  if ([...entry.listeners].some((reader) => reader.shown)) refresh(entry);
  else entry.stale = true;
}

function subscribe(canvasId: string, reader: Reader): () => void {
  let entry = entries.get(canvasId);
  if (!entry) {
    const created: RequestEntry = { canvasId, listeners: new Set(), request: null, dirty: false, stale: false, dispose: () => {} };
    const onUpdate = (event: Event) => {
      if ((event as CustomEvent<CanvasUpdatedPayload>).detail?.canvasId === canvasId) changed(created);
    };
    const onReconnect = () => changed(created);
    window.addEventListener("mandate:canvas-updated", onUpdate);
    window.addEventListener("mandate:sse-open", onReconnect);
    created.dispose = () => {
      window.removeEventListener("mandate:canvas-updated", onUpdate);
      window.removeEventListener("mandate:sse-open", onReconnect);
    };
    entries.set(canvasId, created);
    entry = created;
  }
  entry.listeners.add(reader);
  // Joining a request is not an invalidation and must not schedule a follow-up.
  if (entry.request) reader.listener({ type: "loading" });
  else void load(entry);
  return () => {
    entry.listeners.delete(reader);
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
  /** The last read said the canvas is not there (or not readable). */
  missing: boolean;
  loading: boolean;
}

/** A canvas's document, read when mounted and again when it changes or the
 *  event stream comes back. `shown` false (a panel tab behind another): a
 *  change waits, and is read once, when it is shown again. */
export function useCanvasDocument(canvasId: string, shown = true) {
  const [state, setState] = useState<DocumentState | null>(null);
  const reader = useRef<Reader | null>(null);
  useEffect(() => {
    if (!canvasId) return;
    // Shown or not is set by the effect below, which runs right after this one.
    const mine: Reader = {
      shown: true,
      listener: (update) => setState((previous) => {
        const canvas = previous?.canvasId === canvasId ? previous.canvas : null;
        if (update.type === "loading") return { canvasId, canvas, error: null, missing: false, loading: true };
        if (update.type === "unavailable") return { canvasId, canvas: null, error: null, missing: false, loading: true };
        if (update.type === "loaded") return { canvasId, canvas: update.canvas, error: null, missing: false, loading: false };
        return { canvasId, canvas: update.clear ? null : canvas, error: update.error, missing: update.clear, loading: false };
      })
    };
    reader.current = mine;
    const unsubscribe = subscribe(canvasId, mine);
    return () => {
      if (reader.current === mine) reader.current = null;
      unsubscribe();
    };
  }, [canvasId]);
  // Shown again: what changed meanwhile is read now.
  useEffect(() => {
    if (reader.current) reader.current.shown = shown;
    const entry = entries.get(canvasId);
    if (shown && entry?.stale) {
      entry.stale = false;
      refresh(entry);
    }
  }, [canvasId, shown]);

  const reload = useCallback((clear = false) => {
    const entry = entries.get(canvasId);
    if (!entry) return;
    // The full-page Refresh control explicitly rebuilds its own frame. Other
    // readers keep their drafts while sharing the same document request.
    if (clear) setState({ canvasId, canvas: null, error: null, missing: false, loading: true });
    refresh(entry);
  }, [canvasId]);

  return {
    canvas: state?.canvasId === canvasId ? state.canvas : null,
    error: !canvasId ? "Canvas id is missing." : state?.canvasId === canvasId ? state.error : null,
    missing: !canvasId || (state?.canvasId === canvasId && state.missing),
    loading: Boolean(canvasId) && (state?.canvasId !== canvasId || state.loading),
    refresh: reload
  };
}
