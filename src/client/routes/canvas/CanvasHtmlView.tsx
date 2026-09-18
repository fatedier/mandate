import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CanvasDocumentDto } from "@shared/api-contracts";
import { useResolvedTheme } from "@/lib/theme";
import { api } from "@/lib/api-paths";
import {
  buildCanvasSrcDoc,
  submitCanvasEvent,
  type CanvasHeightMessage,
  type CanvasSubmitMessage
} from "./canvas-bridge";
import { computeCanvasFit, type CanvasFit } from "./canvas-fit";
import { FRAME_LOAD_TIMEOUT_MS, reduceFrameReadiness, type FrameReadiness } from "./frame-readiness";

interface CanvasHtmlViewProps {
  canvas: CanvasDocumentDto;
  /** When true, the iframe fills its parent (e.g. the full-page CanvasPage).
   *  When false (default), the iframe auto-grows to its body height via
   *  postMessage from the bridge script — used by inline embeds like the
   *  feature Overview tab. */
  fillParent?: boolean;
  /** Completed frames stay mounted when inactive. Unfinished frames are
   * discarded and documents received while hidden wait for a visible viewport. */
  active?: boolean;
  className?: string;
  /** Auto-size mode only: reports loading / ready / failed as the bridge's
   *  first height arrives or fails to. The full-page view (`fillParent`)
   *  never uses it. */
  onReadinessChange?: (readiness: FrameReadiness) => void;
  /** Auto-size mode only: how long to wait for the first height. */
  loadTimeoutMs?: number;
  /** Auto-size mode only: bump to remount the frame (Retry). */
  retryToken?: number;
  /** Auto-size mode only: the fit computed from the bridge's reported width
   *  against the wrapper's width; null until the first report. */
  onFitChange?: (fit: CanvasFit | null) => void;
  /** Test hook: overrides the measured wrapper width (happy-dom has no layout). */
  containerWidth?: number;
}

/** Renders an agent-authored HTML canvas inside a sandboxed iframe. The
 *  iframe is the right container for free-form HTML (LLMs naturally write
 *  full documents with <head>/<script>/<style>); inline rendering breaks
 *  because innerHTML drops <script> execution and the document structure is
 *  flattened by the parent's parsing rules.
 *
 *  Height bridge: a script in the iframe (canvas-bridge) measures body
 *  scrollHeight on load + ResizeObserver and posts it back. This component
 *  listens and sets the iframe element height to match, so the canvas grows
 *  naturally with content. */
export function CanvasHtmlView({
  canvas,
  fillParent = false,
  active = true,
  className,
  onReadinessChange,
  loadTimeoutMs = FRAME_LOAD_TIMEOUT_MS,
  retryToken = 0,
  onFitChange,
  containerWidth
}: CanvasHtmlViewProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // `forWidth` is the container width the report was measured against; a report
  // taken against a different width is stale (see `activeReportedWidth`).
  const [reportedHeight, setReportedHeight] = useState<{ srcDoc: string; value: number; width: number | null; forWidth: number } | null>(null);
  const [loadedSrcDoc, setLoadedSrcDoc] = useState<string | null>(null);
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    iframeRef.current = frame;
    if (!frame) {
      setLoadedSrcDoc(null);
      setReportedHeight(null);
    }
  }, []);
  const theme = useResolvedTheme();
  const [readiness, dispatch] = useReducer(reduceFrameReadiness, "loading" as FrameReadiness);

  const srcDoc = useMemo(
    () => buildCanvasSrcDoc(canvas.html ?? "", canvas.id, {
      theme,
      assetBaseUrl: api.canvasAssetsBase(canvas.id),
      autoSize: !fillParent
    }),
    [canvas.html, canvas.id, fillParent, theme]
  );

  // Auto-size mode measures the wrapper the frame sits in: a canvas laid out
  // wider than that is scaled down to fit rather than clipped. The wrapper is
  // rendered whether or not the frame is mounted yet (a hidden card mounts its
  // frame later), so the observer is attached once and stays attached.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  useEffect(() => {
    if (fillParent || containerWidth != null) return;
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      // A hidden card (WorkerCanvasCache keeps inactive cards mounted) reads 0
      // on hide; taking it would re-lay the frame twice per hide/show.
      if (w <= 0) return;
      setMeasuredWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fillParent, containerWidth]);
  const effectiveWidth = containerWidth ?? measuredWidth;

  useEffect(() => {
    const handle = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.canvasId !== canvas.id) return;
      if (data.type === "mandate.canvas.key" && document.activeElement === iframeRef.current) {
        const zoom = data.key === "Enter" && (data.metaKey === true || data.ctrlKey === true) && data.shiftKey === true;
        const escape = data.key === "Escape" && document.querySelector(
          '[data-pane-mode="worker"], [role="dialog"][aria-label="Canvas"]'
        );
        if (zoom || escape) iframeRef.current?.dispatchEvent(new KeyboardEvent("keydown", {
          key: data.key, metaKey: data.metaKey === true, ctrlKey: data.ctrlKey === true,
          shiftKey: data.shiftKey === true, bubbles: true, cancelable: true
        }));
        return;
      }
      if (isHeightMessage(data)) {
        dispatch({ type: "height" });
        setReportedHeight({
          srcDoc, value: data.value, forWidth: effectiveWidth,
          width: typeof data.width === "number" && data.width > 0 ? data.width : null
        });
        return;
      }
      if (isSubmitMessage(data)) {
        void submitCanvasEvent(canvas.id, data, setSubmitting);
      }
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, [canvas.id, srcDoc, effectiveWidth]);

  // A new document is a new wait: the old height belongs to the old srcDoc.
  // Layout effect so an in-place srcDoc change (theme toggle, html without a
  // revision bump) tells the parent "loading" before a 0px frame can paint.
  useLayoutEffect(() => { dispatch({ type: "reset" }); }, [srcDoc, retryToken]);

  // The frame is only mounted while `active` (hidden cards in WorkerCanvasCache
  // keep no frame until a document has loaded), so the wait only counts while
  // there is a frame that could report: going hidden mid-load clears the timer,
  // becoming visible arms it fresh.
  useEffect(() => {
    if (fillParent || !active || readiness !== "loading") return;
    const timer = window.setTimeout(() => dispatch({ type: "timeout" }), loadTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [fillParent, active, readiness, loadTimeoutMs, srcDoc, retryToken]);

  // Layout effect so a keyed remount tells the parent "loading" before it can
  // paint a frame with content padding around a 0px iframe.
  useLayoutEffect(() => { onReadinessChange?.(readiness); }, [onReadinessChange, readiness]);

  const activeReportedHeight = reportedHeight?.srcDoc === srcDoc ? reportedHeight.value : null;
  // A reported width is floored at the frame's own viewport, so a frame pinned
  // at `frameWidth` keeps reporting that width even after the container grew
  // back (maximise → restore, phone rotation): a responsive canvas would stay
  // shrunk until reload. A width measured against a different container is
  // therefore dropped: the frame returns to 100%, the bridge's body
  // ResizeObserver sees the reflow and posts a fresh measurement at the new
  // viewport. A report taken before the wrapper was measured (forWidth 0) was
  // still laid out at 100% of the real container, so it stays valid.
  const activeReportedWidth = reportedHeight?.srcDoc === srcDoc
    && (reportedHeight.forWidth === 0 || reportedHeight.forWidth === effectiveWidth)
    ? reportedHeight.width
    : null;
  // Before the first height the frame takes no room at all: the parent shows a
  // skeleton (or the failure row) in its place, and a 120px empty box was the
  // "black rectangle" the Overview used to show while the bridge loaded.
  const ready = readiness === "ready" && activeReportedHeight != null;
  // Memoised on the numbers so the notify effect below fires on real changes only.
  const fit = useMemo<CanvasFit | null>(() => (
    !fillParent && ready && activeReportedHeight != null
      ? computeCanvasFit({ contentWidth: activeReportedWidth ?? 0, contentHeight: activeReportedHeight, containerWidth: effectiveWidth })
      : null
  ), [fillParent, ready, activeReportedWidth, activeReportedHeight, effectiveWidth]);
  useEffect(() => { if (!fillParent) onFitChange?.(fit); }, [fillParent, onFitChange, fit]);

  const scaled = fit != null && fit.scale < 1;
  const style = fillParent ? undefined : { height: ready ? `${activeReportedHeight}px` : "0px" };
  const frame = (active || loadedSrcDoc === srcDoc) && <iframe
    key={retryToken}
    ref={attachFrame}
    title={canvas.title || "Canvas"}
    aria-hidden={!fillParent && !ready ? true : undefined}
    tabIndex={!fillParent && !ready ? -1 : undefined}
    srcDoc={srcDoc}
    onLoad={() => setLoadedSrcDoc(srcDoc)}
    sandbox="allow-scripts allow-forms"
    scrolling={fillParent ? "auto" : "no"}
    className={className}
    style={fillParent
      ? { width: "100%", height: "100%", border: "none", background: "transparent", display: "block" }
      : scaled
        ? { width: `${fit.frameWidth}px`, height: `${activeReportedHeight}px`, transform: `scale(${fit.scale})`, transformOrigin: "0 0", border: "none", background: "transparent", display: "block", overflow: "hidden" }
        : { width: "100%", border: "none", background: "transparent", display: "block", overflow: "hidden", ...style }}
  />;

  return (
    <>
      {submitting && (
        <div className="border-b border-border-soft bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
          Sending canvas response...
        </div>
      )}
      {fillParent
        ? frame
        : <div ref={wrapperRef} style={{ height: ready ? `${fit?.wrapperHeight ?? activeReportedHeight}px` : "0px", overflow: "hidden" }}>
          {frame}
        </div>}
    </>
  );
}

function isHeightMessage(data: unknown): data is CanvasHeightMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.type === "mandate.canvas.height" && typeof d.value === "number" && d.value > 0;
}

function isSubmitMessage(data: unknown): data is CanvasSubmitMessage {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return d.type === "mandate.canvas.submit" && typeof d.action === "string" && d.action.trim().length > 0;
}
