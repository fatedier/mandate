import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CanvasDocumentDto } from "@shared/api-contracts";
import { useResolvedTheme } from "@/lib/theme";
import { buildCanvasSrcDoc, canvasAssetsUrl } from "./canvas-srcdoc";
import { readCanvasFrameMessage } from "./canvas-bridge";
import {
  ANCHOR_HOLD_MS,
  anchorAt,
  scaleZoom,
  scrollForAnchor,
  wheelZoom,
  type CanvasView,
  type ResolvedCanvasView,
  type ScrollAnchor
} from "./canvas-view";

/** How far the pointer may drift and still be the same pinch. */
const GESTURE_SLOP_PX = 24;

interface CanvasHtmlViewProps {
  canvas: Pick<CanvasDocumentDto, "id" | "html" | "title">;
  view: CanvasView;
  resolved: ResolvedCanvasView;
  onViewChange: (view: CanvasView) => void;
  /** The folder its relative links resolve against; the canvas's own by default. */
  assetsBaseUrl?: string;
  /** A script of the viewer's that runs before the page's (canvas-srcdoc). */
  headScript?: string;
  /** Every message the frame sends, with a way to answer it. */
  onFrameMessage?: (data: unknown, reply: (message: unknown) => void) => void;
  /** Each load of the frame, with a way to post to it. */
  onFrameLoad?: (post: (message: unknown) => void) => void;
}

/**
 * A report in its sandboxed frame. The frame is the
 * layout width × (100/zoom)% of the viewer's height, drawn with scale(zoom):
 * the page always scrolls itself, the way browser zoom and a mobile browser's
 * Desktop site behave, and this box only pans sideways when a zoomed desktop
 * page is wider than the viewer. No height measurement is involved.
 */
export function CanvasHtmlView({ canvas, view, resolved, onViewChange, assetsBaseUrl, headScript, onFrameMessage, onFrameLoad }: CanvasHtmlViewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const theme = useResolvedTheme();
  // Built once per publish with the theme of that moment; later changes are
  // posted to the page, which keeps its scroll position.
  const [documentTheme] = useState(theme);
  // Counts loads: a page that reloads itself starts again from the srcdoc's
  // theme, so each load gets the current one.
  const [loads, setLoads] = useState(0);
  const srcDoc = useMemo(() => buildCanvasSrcDoc(canvas.html ?? "", {
    canvasId: canvas.id,
    theme: documentTheme,
    assetsBaseUrl: assetsBaseUrl ?? canvasAssetsUrl(canvas.id),
    ...(headScript ? { headScript } : {})
  }), [canvas.html, canvas.id, documentTheme, assetsBaseUrl, headScript]);
  const frameHooks = useRef({ onFrameMessage, onFrameLoad });
  useLayoutEffect(() => {
    frameHooks.current = { onFrameMessage, onFrameLoad };
  });
  const { desktop, zoom, layoutWidth } = resolved;

  // The page's own scroll, from the bridge.
  const page = useRef({ scrollTop: 0, height: 0 });
  // The reader's place, kept as a fraction of the page (canvas-view anchors).
  const center = useRef<ScrollAnchor | null>(null);
  /** A kept place. `point` marks one taken under a gesture's pointer, so
   *  later steps of the same gesture (near that point) reuse it; `forChange`
   *  marks one taken for the view change about to render. */
  const kept = useRef<{ anchor: ScrollAnchor; until: number; point?: { ox: number; oy: number }; forChange?: boolean } | null>(null);
  const latest = useRef({ view, zoom, layoutWidth, onViewChange });
  useLayoutEffect(() => {
    latest.current = { view, zoom, layoutWidth, onViewChange };
  });

  // The centre of what is on screen now, kept current even during a hold
  // (the scroll reports then are the viewer's own adjustments), so a control
  // zoom in the middle of a gesture anchors on the view the reader sees.
  const recordCenter = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const { zoom: z, layoutWidth: w } = latest.current;
    center.current = anchorAt({
      ox: body.clientWidth / 2,
      oy: body.clientHeight / 2,
      scrollLeft: body.scrollLeft,
      scrollTop: page.current.scrollTop,
      zoom: z,
      layoutWidth: w,
      pageHeight: page.current.height
    });
  }, []);

  const applyKept = useCallback(() => {
    const k = kept.current;
    if (!k) return;
    if (performance.now() > k.until) {
      kept.current = null;
      return;
    }
    const { zoom: z, layoutWidth: w } = latest.current;
    const target = scrollForAnchor(k.anchor, { zoom: z, layoutWidth: w, pageHeight: page.current.height });
    if (bodyRef.current) bodyRef.current.scrollLeft = target.scrollLeft;
    if (Math.abs(page.current.scrollTop - target.scrollTop) > 1) {
      frameRef.current?.contentWindow?.postMessage({ type: "mandate.canvas.scrollTo", y: target.scrollTop }, "*");
      // Assume the page went where it was sent until its next report says
      // otherwise, so a place taken in between is not a frame out of date.
      page.current = { ...page.current, scrollTop: target.scrollTop };
    }
    recordCenter();
  }, [recordCenter]);

  /** Zoom around a point given as an offset inside the viewer (screen px). */
  const zoomAround = useCallback((ox: number, oy: number, next: number) => {
    const body = bodyRef.current;
    const { view: v, zoom: z, layoutWidth: w, onViewChange: change } = latest.current;
    if (!body || next === z) return;
    // A pinch or quick Ctrl+scroll arrives as many steps, faster than the page
    // reports its new scroll: while a gesture's hold is live and the pointer
    // has stayed put, the next step keeps the point the gesture started on. A
    // new gesture elsewhere, or one after a menu zoom, anchors on its own point.
    const now = performance.now();
    const previous = kept.current;
    const sameGesture = previous?.point !== undefined && now <= previous.until &&
      Math.abs(previous.point.ox - ox) <= GESTURE_SLOP_PX && Math.abs(previous.point.oy - oy) <= GESTURE_SLOP_PX;
    const anchor = sameGesture
      ? previous!.anchor
      : anchorAt({ ox, oy, scrollLeft: body.scrollLeft, scrollTop: page.current.scrollTop, zoom: z, layoutWidth: w, pageHeight: page.current.height });
    // The point stays where the anchor was taken, so a pinch that drifts a
    // little per step is still measured against its start.
    kept.current = { anchor, until: now + ANCHOR_HOLD_MS, point: sameGesture ? previous!.point : { ox, oy }, forChange: true };
    // Steps can arrive faster than React re-renders: the next one starts from
    // this zoom, not from the last committed one.
    latest.current = { ...latest.current, zoom: next, view: { ...v, zoom: next } };
    change({ ...v, zoom: next });
  }, []);

  // A change the reader made (zoom, Desktop site) keeps their place: the point
  // at the centre (or under the pointer, set by zoomAround) stays put while
  // the page reflows, then normal tracking resumes. A fit zoom recomputed from
  // the viewer's width is not the reader's doing and holds nothing: a hold
  // then would pull back a reader who has just started scrolling.
  useLayoutEffect(() => {
    const k = kept.current;
    // A gesture's own change uses the anchor it took; any other change (a
    // menu zoom, Desktop site) anchors on the centre, replacing an older hold.
    if (k?.forChange) kept.current = { ...k, forChange: false };
    else if (center.current) kept.current = { anchor: center.current, until: performance.now() + ANCHOR_HOLD_MS };
    applyKept();
    const timer = window.setTimeout(() => {
      kept.current = null;
      recordCenter();
    }, ANCHOR_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [view.zoom, view.desktop, applyKept, recordCenter]);

  useEffect(() => {
    if (!loads) return;
    frameRef.current?.contentWindow?.postMessage({ type: "mandate.canvas.theme", theme }, "*");
  }, [loads, theme]);

  useEffect(() => {
    const handle = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      frameHooks.current.onFrameMessage?.(event.data, (message) => frame.contentWindow?.postMessage(message, "*"));
      const message = readCanvasFrameMessage(event.data, canvas.id);
      if (!message) return;
      if (message.type === "interact") {
        // The reader acted: the hold ends here, and the centre is taken now,
        // since a press may bring no scroll report to take it from.
        kept.current = null;
        recordCenter();
        return;
      }
      if (message.type === "scroll") {
        page.current = { scrollTop: message.y, height: message.height };
        if (kept.current) applyKept();
        recordCenter();
        return;
      }
      if (message.type === "zoom") {
        // The gesture carries the page's scroll at that moment, which may be
        // newer than the last scroll report.
        if (message.scrollY !== null && message.height !== null) page.current = { scrollTop: message.scrollY, height: message.height };
        const body = bodyRef.current;
        const z = latest.current.zoom;
        const next = message.wheel !== null ? wheelZoom(z, message.wheel) : scaleZoom(z, message.scale!);
        // x, y are in the page's viewport; the frame sits at the box's origin.
        zoomAround(message.x * z - (body?.scrollLeft ?? 0), message.y * z, next);
        return;
      }
      // A report has no artboards to go to; what is left is a key.
      if (message.type !== "key") return;
      if (document.activeElement !== frame) return;
      const zoomKey = message.key === "Enter" && (message.metaKey || message.ctrlKey) && message.shiftKey;
      // Esc means something around the report: a side pane that has the row
      // (a worker's, Your agent's page, a panel's canvas tab), or the modal.
      const escape = message.key === "Escape" && (frame.closest('[data-slot="canvas-tab-view"]') || document.querySelector('[data-pane-mode="worker"], [data-pane-mode="page"], [role="dialog"][aria-label="Canvas"]'));
      if (zoomKey || escape) {
        frame.dispatchEvent(new KeyboardEvent("keydown", {
          key: message.key, metaKey: message.metaKey, ctrlKey: message.ctrlKey,
          shiftKey: message.shiftKey, bubbles: true, cancelable: true
        }));
      }
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, [canvas.id, applyKept, recordCenter, zoomAround]);

  // Ctrl+scroll over the box outside a narrow zoomed-out page. React's wheel
  // listener is passive, so this one is attached by hand.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const letGo = () => { kept.current = null; };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        letGo();
        return;
      }
      event.preventDefault();
      const rect = body.getBoundingClientRect();
      // A notch in lines (Firefox) or pages, in pixels.
      const deltaY = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY;
      zoomAround(event.clientX - rect.left, event.clientY - rect.top, wheelZoom(latest.current.zoom, deltaY));
    };
    body.addEventListener("wheel", onWheel, { passive: false });
    body.addEventListener("touchstart", letGo, { passive: true });
    // A press on this box's own scrollbar (panning a zoomed desktop page).
    body.addEventListener("pointerdown", letGo, { passive: true });
    return () => {
      body.removeEventListener("wheel", onWheel);
      body.removeEventListener("touchstart", letGo);
      body.removeEventListener("pointerdown", letGo);
    };
  }, [zoomAround]);

  const percent = `${100 / zoom}%`;
  const frameStyle: CSSProperties = {
    width: desktop ? `${layoutWidth}px` : percent,
    height: percent,
    ...(zoom === 1 ? {} : { transform: `scale(${zoom})`, transformOrigin: "0 0" }),
    border: "none",
    background: "transparent",
    display: "block"
  };
  return (
    <div ref={bodyRef} className="h-full w-full overflow-x-auto overflow-y-hidden" onScroll={recordCenter}>
      <div style={{ width: desktop ? `${layoutWidth * zoom}px` : "100%", height: "100%", overflow: "hidden" }}>
        <iframe
          ref={frameRef}
          title={canvas.title || "Report"}
          srcDoc={srcDoc}
          onLoad={() => {
            setLoads((n) => n + 1);
            const frame = frameRef.current;
            if (frame) frameHooks.current.onFrameLoad?.((message) => frame.contentWindow?.postMessage(message, "*"));
          }}
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          allow="clipboard-write *; fullscreen *"
          style={frameStyle}
        />
      </div>
    </div>
  );
}
