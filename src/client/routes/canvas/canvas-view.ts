import { CANVAS_DESKTOP_WIDTH_DEFAULT } from "@shared/canvas-page";

/** The browser's zoom ladder, widened to 25–300% for desktop pages on phones. */
export const ZOOM_LADDER: readonly number[] = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const ZOOM_PRESETS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;
/** A wheel delta this large is a mouse notch; a trackpad pinch sends small ones. */
/** A wheel delta this large is a mouse notch: it steps the zoom ladder. */
export const WHEEL_NOTCH_DELTA = 40;
/** How long the reader's place is re-applied while the page reflows. */
export const ANCHOR_HOLD_MS = 700;

/** What the reader chose. null means the default: Desktop site follows the
 *  report's declaration; zoom is fit width (Desktop site) or 100%. */
export interface CanvasView {
  desktop: boolean | null;
  zoom: number | null;
}

export const DEFAULT_CANVAS_VIEW: CanvasView = { desktop: null, zoom: null };

export interface ResolvedCanvasView {
  desktop: boolean;
  zoom: number;
  /** The zoom is the default (fit width, or 100% without Desktop site). */
  fit: boolean;
  /** The width the page lays out at, in CSS px. */
  layoutWidth: number;
}

export function resolveCanvasView(
  view: CanvasView,
  input: { declaredWidth: number | null; viewerWidth: number }
): ResolvedCanvasView {
  const desktop = view.desktop ?? input.declaredWidth !== null;
  const viewerWidth = input.viewerWidth > 0 ? input.viewerWidth : 0;
  const desktopWidth = input.declaredWidth ?? CANVAS_DESKTOP_WIDTH_DEFAULT;
  const fitZoom = desktop && viewerWidth > 0 ? Math.min(1, viewerWidth / desktopWidth) : 1;
  const zoom = view.zoom ?? fitZoom;
  // Without Desktop site, zoom works like browser zoom: the page reflows at
  // the viewer's width divided by the zoom, so it never scrolls sideways.
  const layoutWidth = desktop ? desktopWidth : viewerWidth / zoom;
  return { desktop, zoom, fit: view.zoom === null, layoutWidth };
}

const shownPercent = (zoom: number) => Math.round(zoom * 100);

/** One ladder step from the percentage the reader sees: a fit of 0.3297 shows
 *  "33%", so the next step up is 50%, never 33% again. Past either end the
 *  zoom lands exactly on that end. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const shown = shownPercent(zoom);
  const next = direction > 0
    ? ZOOM_LADDER.find((step) => shownPercent(step) > shown)
    : [...ZOOM_LADDER].reverse().find((step) => shownPercent(step) < shown);
  return next ?? (direction > 0 ? ZOOM_MAX : ZOOM_MIN);
}

/** Continuous zoom (a pinch). Crossing 100% lands on 100%, so a pinch can
 *  find actual size; starting from 100% moves freely. */
export function scaleZoom(zoom: number, factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return zoom;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
  return (zoom < 1 && next > 1) || (zoom > 1 && next < 1) ? 1 : next;
}

/** Ctrl+scroll and a trackpad pinch both arrive as wheel deltas: a notch
 *  moves one ladder step, a pinch scales continuously. */
export function wheelZoom(zoom: number, deltaY: number): number {
  if (Math.abs(deltaY) >= WHEEL_NOTCH_DELTA) return stepZoom(zoom, deltaY < 0 ? 1 : -1);
  return scaleZoom(zoom, Math.exp(-deltaY * 0.01));
}

/** The reader's place: the page point at offset (ox, oy) inside the viewer,
 *  as a fraction of the page, so it survives a change of zoom or layout
 *  width. The viewer only pans sideways; the page scrolls itself. */
export interface ScrollAnchor {
  fx: number;
  fy: number;
  ox: number;
  oy: number;
}

export function anchorAt(input: {
  ox: number; oy: number; scrollLeft: number; scrollTop: number;
  zoom: number; layoutWidth: number; pageHeight: number;
}): ScrollAnchor {
  const x = (input.scrollLeft + input.ox) / input.zoom;
  const y = input.scrollTop + input.oy / input.zoom;
  return {
    fx: input.layoutWidth > 0 ? x / input.layoutWidth : 0,
    fy: input.pageHeight > 0 ? y / input.pageHeight : 0,
    ox: input.ox,
    oy: input.oy
  };
}

export function scrollForAnchor(
  anchor: ScrollAnchor,
  input: { zoom: number; layoutWidth: number; pageHeight: number }
): { scrollLeft: number; scrollTop: number } {
  return {
    scrollLeft: Math.max(0, anchor.fx * input.layoutWidth * input.zoom - anchor.ox),
    scrollTop: Math.max(0, anchor.fy * input.pageHeight - anchor.oy / input.zoom)
  };
}
