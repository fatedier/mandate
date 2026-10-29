import type { DesignBoard, DesignNote } from "@shared/api-contracts";
import { WHEEL_NOTCH_DELTA } from "./canvas-view";

/** The canvas view's camera: world point (wx, wy) is drawn at (x + wx·z, y + wy·z). */
export interface Camera {
  x: number;
  y: number;
  z: number;
}

export interface Size {
  width: number;
  height: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Low enough for Fit all to show a row of four desktop artboards in a
 *  half-screen pane, or three on a phone. */
export const DESIGN_ZOOM_MIN = 0.02;
export const DESIGN_ZOOM_MAX = 4;
const DESIGN_ZOOM_LADDER: readonly number[] = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export const DESIGN_ZOOM_PRESETS: readonly number[] = [0.5, 1, 2];

/** A title1 note is one line of this height per px of its font size; a
 *  title without maxW is assumed to take this much width per character (at
 *  72 px), for fitting only. */
export const TITLE_LINE_HEIGHT = 1.1;
const TITLE_CHAR_WIDTH = 40;
const STICKY_DEFAULT_WIDTH = 240;
const NOTE_SIZES: Record<string, number> = { s: 14, m: 18, l: 24, xl: 32, xxl: 48 };

const clampZoom = (z: number) => Math.min(DESIGN_ZOOM_MAX, Math.max(DESIGN_ZOOM_MIN, z));

/** A note's font size in px: its `size` (a name or px), else 72 for a title, 18 for a sticky. */
export function noteFontSize(note: DesignNote): number {
  const size = typeof note.size === "number" ? note.size : note.size ? NOTE_SIZES[note.size] : undefined;
  return size ?? (note.kind === "title1" ? 72 : 18);
}

/** A title's maxW when it has a usable one (a positive width), as the viewer renders it. */
export function titleMaxWidth(note: DesignNote): number | null {
  return note.maxW !== null && note.maxW > 0 ? note.maxW : null;
}

export function noteSize(note: DesignNote): { w: number; h: number } {
  if (note.kind === "title1") {
    const font = noteFontSize(note);
    return { w: titleMaxWidth(note) ?? titleWidth(note.text, font), h: font * TITLE_LINE_HEIGHT };
  }
  const w = note.w ?? STICKY_DEFAULT_WIDTH;
  return { w, h: note.maxH ?? (w * 4) / 3 };
}

/** A full-width glyph (CJK, its extensions beyond the basic plane, Hangul,
 *  full-width forms) is 1em; any other is estimated at TITLE_CHAR_WIDTH per 72 px. */
const FULL_WIDTH = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
function titleWidth(text: string, font: number): number {
  let width = 0;
  for (const glyph of text) width += FULL_WIDTH.test(glyph) ? font : (TITLE_CHAR_WIDTH * font) / 72;
  return width;
}

export function contentBounds(boards: DesignBoard[], notes: DesignNote[]): Rect | null {
  const rects = [
    ...boards.map((board) => ({ x: board.x, y: board.y, w: board.w, h: board.h })),
    ...notes.map((note) => ({ x: note.x, y: note.y, ...noteSize(note) }))
  ];
  if (!rects.length) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** "Fit all": the content centred in the stage, never above 100%. */
export function fitCamera(bounds: Rect | null, stage: Size, padding = 48): Camera {
  if (!bounds || stage.width <= 0 || stage.height <= 0) return { x: 0, y: 0, z: 1 };
  // Empty bounds (a title with no text) count as 1 px, so the ratio stays finite.
  const z = clampZoom(Math.min(1, (stage.width - padding * 2) / Math.max(1, bounds.w), (stage.height - padding * 2) / Math.max(1, bounds.h)));
  return {
    z,
    x: (stage.width - bounds.w * z) / 2 - bounds.x * z,
    y: (stage.height - bounds.h * z) / 2 - bounds.y * z
  };
}

/** Zoom to z keeping the world point under screen point (px, py) in place. */
export function zoomCameraAt(camera: Camera, px: number, py: number, z: number): Camera {
  const next = clampZoom(z);
  const ratio = next / camera.z;
  return { z: next, x: px - (px - camera.x) * ratio, y: py - (py - camera.y) * ratio };
}

const shown = (z: number) => Math.round(z * 100);

/** One ladder step from the percentage the reader sees. */
export function stepDesignZoom(z: number, direction: 1 | -1): number {
  const next = direction > 0
    ? DESIGN_ZOOM_LADDER.find((step) => shown(step) > shown(z))
    : [...DESIGN_ZOOM_LADDER].reverse().find((step) => shown(step) < shown(z));
  return next ?? (direction > 0 ? DESIGN_ZOOM_MAX : DESIGN_ZOOM_MIN);
}

/** A wheel delta in pixels: a notch in lines (Firefox) or pages counts as its pixels. */
export function wheelPixels(delta: number, deltaMode: number): number {
  return deltaMode === 1 ? delta * 40 : deltaMode === 2 ? delta * 800 : delta;
}

/** Ctrl+scroll: a mouse notch steps the ladder, as in a report; a trackpad
 *  pinch's small deltas scale continuously. `pixels` is a wheelPixels delta. */
export function designWheelZoom(z: number, pixels: number): number {
  if (Math.abs(pixels) >= WHEEL_NOTCH_DELTA) return stepDesignZoom(z, pixels < 0 ? 1 : -1);
  return clampZoom(z * Math.exp(-pixels * 0.01));
}

/** The space around an artboard in the focused view (none around a fill one). */
export const DESIGN_FOCUS_PADDING = 24;

/** The focused view's artboard size and scale. */
export function focusedLayout(board: DesignBoard, stage: Size, zoom: "fit" | "actual", padding = DESIGN_FOCUS_PADDING): { width: number; height: number; scale: number } {
  if (board.expand === "fill") return { width: stage.width, height: stage.height, scale: 1 };
  if (zoom === "actual") return { width: board.w, height: board.h, scale: 1 };
  const scale = Math.min(1, (stage.width - padding * 2) / board.w, (stage.height - padding * 2) / board.h);
  // A stage not measured yet (or smaller than the padding) shows it at 100%.
  return { width: board.w, height: board.h, scale: scale > 0 ? scale : 1 };
}
