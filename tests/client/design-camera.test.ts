import { expect, test } from "bun:test";
import {
  DESIGN_ZOOM_MAX, DESIGN_ZOOM_MIN, contentBounds, designWheelZoom, fitCamera, focusedLayout, noteFontSize, noteSize, stepDesignZoom, wheelPixels, zoomCameraAt
} from "@/routes/canvas/design-camera";
import type { DesignBoard, DesignNote } from "@shared/api-contracts";

const board = (path: string, x: number, y: number, w: number, h: number, expand: "fill" | null = null): DesignBoard =>
  ({ path, x, y, w, h, title: null, page: "main", expand, interactive: false, radius: 0 });
const note = (id: string, kind: "title1" | "sticky", x: number, y: number, extra: Partial<DesignNote> = {}): DesignNote =>
  ({ id, kind, x, y, text: "Row title", page: "main", w: null, maxW: null, maxH: null, size: null, bold: false, italic: false, color: null, fill: null, ...extra });

test("the bounds cover every board and note: a title1 as wide as its maxW, a sticky as tall as 4/3 of its width", () => {
  expect(contentBounds([], [])).toBeNull();
  expect(contentBounds([board("a", 0, 0, 390, 844), board("b", 470, 0, 390, 844)], [])).toEqual({ x: 0, y: 0, w: 860, h: 844 });
  expect(contentBounds([board("a", 0, 0, 390, 844)], [note("t", "title1", 0, -300, { maxW: 1840 }), note("s", "sticky", 0, 944, { w: 240 })]))
    .toEqual({ x: 0, y: -300, w: 1840, h: 944 + 320 + 300 });
});

test("fit all centres the content, never above 100% and never below the minimum", () => {
  const cam = fitCamera({ x: 0, y: 0, w: 860, h: 844 }, { width: 1000, height: 700 });
  expect(cam.z).toBeCloseTo((700 - 96) / 844, 6);
  expect(cam.x).toBeCloseTo((1000 - 860 * cam.z) / 2, 6);
  expect(cam.y).toBeCloseTo((700 - 844 * cam.z) / 2, 6);
  expect(fitCamera({ x: 0, y: 0, w: 100, h: 100 }, { width: 1000, height: 700 }).z).toBe(1);
  expect(fitCamera({ x: 0, y: 0, w: 1e6, h: 100 }, { width: 1000, height: 700 }).z).toBe(DESIGN_ZOOM_MIN);
  expect(fitCamera(null, { width: 1000, height: 700 })).toEqual({ x: 0, y: 0, z: 1 });
});

test("zooming keeps the point under the pointer, clamped to 2–400%", () => {
  const cam = zoomCameraAt({ x: 100, y: 50, z: 0.5 }, 400, 300, 1);
  // The world point under (400,300) was ((400-100)/0.5, (300-50)/0.5) = (600, 500); it stays under the pointer.
  expect(cam).toEqual({ x: 400 - 600, y: 300 - 500, z: 1 });
  expect(zoomCameraAt({ x: 0, y: 0, z: 1 }, 0, 0, 99).z).toBe(DESIGN_ZOOM_MAX);
  expect(zoomCameraAt({ x: 0, y: 0, z: 1 }, 0, 0, 0.001).z).toBe(DESIGN_ZOOM_MIN);
});

test("ladder steps go by the percentage shown, and stop at the ends", () => {
  expect(stepDesignZoom(0.3297, 1)).toBe(0.5); // shows 33%: the next step is 50%, not 33% again
  expect(stepDesignZoom(1, 1)).toBe(1.25);
  expect(stepDesignZoom(1, -1)).toBe(0.75);
  expect(stepDesignZoom(4, 1)).toBe(DESIGN_ZOOM_MAX);
  expect(stepDesignZoom(0.1, -1)).toBe(0.05);
  expect(stepDesignZoom(0.05, -1)).toBe(DESIGN_ZOOM_MIN);
});

test("a wheel delta in lines or pages scales like pixels", () => {
  expect(wheelPixels(-100, 0)).toBe(-100);
  expect(wheelPixels(-1, 1)).toBe(-40);
  expect(wheelPixels(1, 2)).toBe(800);
});

test("the focused view fits the artboard (never above 100%), shows it at 100%, or fills the stage", () => {
  const stage = { width: 1000, height: 700 };
  const fit = focusedLayout(board("a", 0, 0, 390, 844), stage, "fit");
  expect(fit).toEqual({ width: 390, height: 844, scale: (700 - 48) / 844 });
  expect(focusedLayout(board("a", 0, 0, 200, 200), stage, "fit").scale).toBe(1);
  expect(focusedLayout(board("a", 0, 0, 390, 844), stage, "actual")).toEqual({ width: 390, height: 844, scale: 1 });
  expect(focusedLayout(board("a", 0, 0, 390, 844, "fill"), stage, "fit")).toEqual({ width: 1000, height: 700, scale: 1 });
});

test("fit all shows a row of four desktop artboards in a half-screen pane, and one of three on a phone", () => {
  // 4 × 1440 + 3 × 80 = 6000 px in a 600 px pane; 3 × 1440 + 2 × 80 = 4480 px on a 360 px phone.
  expect(fitCamera({ x: 0, y: 0, w: 6000, h: 900 }, { width: 600, height: 800 }).z).toBeCloseTo((600 - 96) / 6000, 6);
  expect(fitCamera({ x: 0, y: 0, w: 4480, h: 900 }, { width: 360, height: 700 }).z).toBeCloseTo((360 - 96) / 4480, 6);
});

test("fit all on empty bounds or a stage no wider than its padding is finite and clamped", () => {
  for (const cam of [fitCamera({ x: 0, y: 0, w: 0, h: 0 }, { width: 96, height: 96 }), fitCamera({ x: 5, y: 5, w: 0, h: 10 }, { width: 400, height: 400 })]) {
    expect([cam.x, cam.y, cam.z].every(Number.isFinite)).toBe(true);
    expect(cam.z).toBeGreaterThanOrEqual(DESIGN_ZOOM_MIN);
    expect(cam.z).toBeLessThanOrEqual(1);
  }
});

test("the focused view fits even the largest artboard on a phone", () => {
  expect(focusedLayout(board("a", 0, 0, 8000, 600), { width: 320, height: 700 }, "fit").scale).toBeCloseTo((320 - 48) / 8000, 6);
  // An unmeasured stage shows the artboard at 100% until it has a size.
  expect(focusedLayout(board("a", 0, 0, 390, 844), { width: 0, height: 0 }, "fit").scale).toBe(1);
});

test("a title note is as tall as its one line at its own size", () => {
  expect(noteFontSize(note("t", "title1", 0, 0))).toBe(72);
  expect(noteFontSize(note("t", "title1", 0, 0, { size: "xl" }))).toBe(32);
  expect(noteFontSize(note("s", "sticky", 0, 0))).toBe(18);
  expect(noteFontSize(note("s", "sticky", 0, 0, { size: 30 }))).toBe(30);
  expect(contentBounds([], [note("t", "title1", 0, 0, { maxW: 500 })])!.h).toBeCloseTo(72 * 1.1, 6);
  expect(contentBounds([], [note("t", "title1", 0, 0, { maxW: 500, size: 100 })])!.h).toBeCloseTo(110, 6);
});

test("a title whose maxW is not positive is estimated as one without it, as it renders", () => {
  expect(noteSize(note("t", "title1", 0, 0, { text: "Checkout", maxW: 0 })).w).toBeCloseTo(8 * 40, 6);
  expect(noteSize(note("t", "title1", 0, 0, { text: "Checkout", maxW: -5 })).w).toBeCloseTo(8 * 40, 6);
});

test("a title without maxW is estimated wide enough for full-width glyphs", () => {
  // A full-width (CJK) glyph is 1em; others are estimated at 40 px per 72.
  expect(noteSize(note("t", "title1", 0, 0, { text: "结账流程重设计方案比较" })).w).toBeCloseTo(11 * 72, 6);
  expect(noteSize(note("t", "title1", 0, 0, { text: "Checkout", size: 36 })).w).toBeCloseTo(8 * 20, 6);
  expect(noteSize(note("t", "title1", 0, 0, { text: "新 Checkout" })).w).toBeCloseTo(72 + 9 * 40, 6);
  // Outside the basic plane (CJK Extension B), still one full-width glyph each.
  expect(noteSize(note("t", "title1", 0, 0, { text: "𠮷野家" })).w).toBeCloseTo(3 * 72, 6);
});

test("a mouse notch steps the zoom ladder, as in a report; a trackpad's small deltas scale smoothly", () => {
  expect(designWheelZoom(0.5, -100)).toBe(0.67);
  expect(designWheelZoom(0.5, 100)).toBe(0.33);
  expect(designWheelZoom(0.5, -40)).toBe(0.67);
  expect(designWheelZoom(0.5, -10)).toBeCloseTo(0.5 * Math.exp(0.1), 6);
  expect(designWheelZoom(4, -100)).toBe(DESIGN_ZOOM_MAX);
});
