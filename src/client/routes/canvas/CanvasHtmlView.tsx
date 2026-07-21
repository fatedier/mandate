import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasDocumentDto } from "@shared/api-contracts";
import { useUIStore } from "@/store/ui";
import { api } from "@/lib/api-paths";
import {
  buildCanvasSrcDoc,
  submitCanvasEvent,
  type CanvasHeightMessage,
  type CanvasSubmitMessage
} from "./canvas-bridge";

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
export function CanvasHtmlView({ canvas, fillParent = false, active = true, className }: CanvasHtmlViewProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reportedHeight, setReportedHeight] = useState<{ srcDoc: string; value: number } | null>(null);
  const [loadedSrcDoc, setLoadedSrcDoc] = useState<string | null>(null);
  const attachFrame = useCallback((frame: HTMLIFrameElement | null) => {
    iframeRef.current = frame;
    if (!frame) {
      setLoadedSrcDoc(null);
      setReportedHeight(null);
    }
  }, []);
  const theme = useUIStore((s) => s.theme);

  const srcDoc = useMemo(
    () => buildCanvasSrcDoc(canvas.html ?? "", canvas.id, {
      theme,
      assetBaseUrl: api.canvasAssetsBase(canvas.id),
      autoSize: !fillParent
    }),
    [canvas.html, canvas.id, fillParent, theme]
  );

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
        setReportedHeight({ srcDoc, value: data.value });
        return;
      }
      if (isSubmitMessage(data)) {
        void submitCanvasEvent(canvas.id, data, setSubmitting);
      }
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, [canvas.id, srcDoc]);

  const activeReportedHeight = reportedHeight?.srcDoc === srcDoc ? reportedHeight.value : null;
  const style = fillParent
    ? undefined
    : { height: activeReportedHeight != null ? `${activeReportedHeight}px` : "120px" };

  return (
    <>
      {submitting && (
        <div className="border-b border-border-soft bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary">
          Sending canvas response...
        </div>
      )}
      {(active || loadedSrcDoc === srcDoc) && <iframe
        ref={attachFrame}
        title={canvas.title || "Canvas"}
        srcDoc={srcDoc}
        onLoad={() => setLoadedSrcDoc(srcDoc)}
        sandbox="allow-scripts allow-forms"
        scrolling={fillParent ? "auto" : "no"}
        className={className}
        style={fillParent
          ? { width: "100%", height: "100%", border: "none", background: "transparent", display: "block" }
          : { width: "100%", border: "none", background: "transparent", display: "block", overflow: "hidden", ...style }}
      />}
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
