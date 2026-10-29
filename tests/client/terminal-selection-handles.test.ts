import { expect, test } from "bun:test";
import { selectionHandleGeometry } from "@/routes/terminal/terminal-helpers";

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height });

// An 80×24 grid of 10px cells at (10, 20) inside a shell at the origin,
// scrolled so its first visible row is buffer row 100.
const base = {
  grid: rect(10, 20, 800, 240),
  shell: rect(0, 0, 820, 300),
  viewport: rect(0, 0, 820, 300),
  cols: 80,
  rows: 24,
  viewportY: 100
};

test("each handle sits under its end's cell, in the shell's coordinates", () => {
  expect(selectionHandleGeometry({ ...base, range: { start: { x: 5, y: 102 }, end: { x: 20, y: 103 } } })).toEqual({
    start: { left: 60, top: 50, visible: true },
    end: { left: 210, top: 60, visible: true }
  });
  // The shell's own offset is taken off.
  expect(selectionHandleGeometry({ ...base, shell: rect(5, 7, 820, 300), range: { start: { x: 0, y: 100 }, end: { x: 0, y: 100 } } })?.start)
    .toEqual({ left: 5, top: 23, visible: true });
});

test("a handle on a row scrolled out, or past the viewport, is not shown", () => {
  const scrolledOut = selectionHandleGeometry({ ...base, range: { start: { x: 5, y: 99 }, end: { x: 5, y: 124 } } })!;
  expect([scrolledOut.start.visible, scrolledOut.end.visible]).toEqual([false, false]);
  // Below the viewport: shown within 32px of its bottom edge, not past it.
  const short = { ...base, viewport: rect(0, 0, 820, 100) };
  const nearBottom = selectionHandleGeometry({ ...short, range: { start: { x: 5, y: 110 }, end: { x: 5, y: 111 } } })!;
  expect([nearBottom.start.top, nearBottom.start.visible, nearBottom.end.top, nearBottom.end.visible]).toEqual([130, true, 140, false]);
});

test("a grid with no size yet has no handles", () => {
  expect(selectionHandleGeometry({ ...base, grid: rect(10, 20, 0, 240), range: { start: { x: 1, y: 100 }, end: { x: 2, y: 100 } } })).toBeNull();
});
