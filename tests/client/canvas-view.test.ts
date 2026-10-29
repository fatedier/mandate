import { expect, test } from "bun:test";
import {
  anchorAt, resolveCanvasView, scaleZoom, scrollForAnchor, stepZoom, wheelZoom,
  DEFAULT_CANVAS_VIEW, ZOOM_LADDER, ZOOM_PRESETS
} from "@/routes/canvas/canvas-view";

test("the zoom ladder and the presets are the fixed sets", () => {
  expect([...ZOOM_LADDER]).toEqual([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
  expect([...ZOOM_PRESETS]).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
});

test("a declared width turns Desktop site on by default and fits the viewer", () => {
  expect(resolveCanvasView(DEFAULT_CANVAS_VIEW, { declaredWidth: 1280, viewerWidth: 390 }))
    .toEqual({ desktop: true, zoom: 390 / 1280, fit: true, layoutWidth: 1280 });
  // Wider than the declaration: fit width caps at 100%.
  expect(resolveCanvasView(DEFAULT_CANVAS_VIEW, { declaredWidth: 1280, viewerWidth: 1600 }).zoom).toBe(1);
});

test("without a declaration the page reflows at the viewer's width, and zoom reflows it like browser zoom", () => {
  expect(resolveCanvasView(DEFAULT_CANVAS_VIEW, { declaredWidth: null, viewerWidth: 390 }))
    .toEqual({ desktop: false, zoom: 1, fit: true, layoutWidth: 390 });
  expect(resolveCanvasView({ desktop: null, zoom: 1.5 }, { declaredWidth: null, viewerWidth: 390 }))
    .toEqual({ desktop: false, zoom: 1.5, fit: false, layoutWidth: 260 });
});

test("Desktop site can be forced either way; undeclared desktop width is 1280", () => {
  expect(resolveCanvasView({ desktop: true, zoom: null }, { declaredWidth: null, viewerWidth: 640 }))
    .toEqual({ desktop: true, zoom: 0.5, fit: true, layoutWidth: 1280 });
  expect(resolveCanvasView({ desktop: false, zoom: null }, { declaredWidth: 1600, viewerWidth: 390 }))
    .toEqual({ desktop: false, zoom: 1, fit: true, layoutWidth: 390 });
});

test("stepZoom walks the ladder from on- and off-ladder values and stops at the ends", () => {
  expect(stepZoom(1, 1)).toBe(1.1);
  expect(stepZoom(1, -1)).toBe(0.9);
  expect(stepZoom(0.3046875, 1)).toBe(0.33);
  expect(stepZoom(0.3046875, -1)).toBe(0.25);
  expect(stepZoom(3, 1)).toBe(3);
  expect(stepZoom(0.25, -1)).toBe(0.25);
});

test("a slow pinch leaves 100% and a pinch that crosses 100% lands on it", () => {
  expect(scaleZoom(1, 1.01)).toBeCloseTo(1.01, 10);
  expect(scaleZoom(1, 0.99)).toBeCloseTo(0.99, 10);
  expect(scaleZoom(0.98, 1.05)).toBe(1);
  expect(scaleZoom(1.02, 0.95)).toBe(1);
  expect(scaleZoom(2.9, 1.2)).toBe(3);
  expect(scaleZoom(0.26, 0.5)).toBe(0.25);
  expect(scaleZoom(1.2, Number.NaN)).toBe(1.2);
});

test("a wheel notch is one ladder step and small deltas scale continuously", () => {
  expect(wheelZoom(1, -100)).toBe(1.1);
  expect(wheelZoom(1, 100)).toBe(0.9);
  expect(wheelZoom(1, -40)).toBe(1.1);
  expect(wheelZoom(1.2, -3)).toBeCloseTo(1.2 * Math.exp(0.03), 10);
});

test("a kept place maps back to the same scroll when nothing changed", () => {
  const input = { zoom: 0.5, layoutWidth: 1280, pageHeight: 5000 };
  const anchor = anchorAt({ ox: 200, oy: 300, scrollLeft: 40, scrollTop: 900, ...input });
  expect(scrollForAnchor(anchor, input)).toEqual({ scrollLeft: 40, scrollTop: 900 });
});

test("zooming in keeps the point under the pointer where it was", () => {
  // Pointer at (200, 300) in the viewer, page scrolled to 900, zoom 1 → 2.
  const anchor = anchorAt({ ox: 200, oy: 300, scrollLeft: 0, scrollTop: 900, zoom: 1, layoutWidth: 1280, pageHeight: 5000 });
  const after = scrollForAnchor(anchor, { zoom: 2, layoutWidth: 1280, pageHeight: 5000 });
  // The point was at page (200, 1200); at zoom 2 it sits at screen x 400, so
  // the viewer scrolls 200 to keep it at 200; vertically the page scrolls to
  // 1200 − 300/2 = 1050.
  expect(after).toEqual({ scrollLeft: 200, scrollTop: 1050 });
});

test("a step always changes the percentage the reader sees, and ends exactly at the range's ends", () => {
  // 422px viewer, 1280px page: fit is 0.3296875, shown as 33%.
  expect(stepZoom(0.3296875, 1)).toBe(0.5);
  expect(stepZoom(0.3296875, -1)).toBe(0.25);
  expect(stepZoom(0.3349, 1)).toBe(0.5);
  expect(stepZoom(0.2505, -1)).toBe(0.25);
  expect(stepZoom(2.995, 1)).toBe(3);
});
