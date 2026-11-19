import { expect, test } from "bun:test";
import { copyButtonPlace, selectionHandleGeometry } from "@/routes/terminal/terminal-helpers";

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

// The Copy button sits by what is selected, as a phone's own copy menu
// does. The same grid, its room the whole shell; a 60×32 button.
const copy = { ...base, room: base.viewport, size: { width: 60, height: 32 }, clearBelow: 0 };
const line = (row: number, from: number, to: number) => ({ start: { x: from, y: 100 + row }, end: { x: to, y: 100 + row } });

test("the Copy button sits above the selection's first line, centred over what is selected of it", () => {
  // Row 10 is 120–130 px down; columns 10–30 are 110–310 px across.
  expect(copyButtonPlace({ ...copy, range: line(10, 10, 30) })).toEqual({ left: 180, top: 80 });
  // More than one line: centred over the lines' whole width.
  expect(copyButtonPlace({ ...copy, range: { start: { x: 70, y: 105 }, end: { x: 5, y: 107 } } })).toEqual({ left: 380, top: 30 });
});

test("with no room above, the Copy button goes below the last line, clear of what sits under it; with room for neither, over it at the top", () => {
  // Row 1 is 30–40 px down: 32 px and a gap do not fit above it.
  expect(copyButtonPlace({ ...copy, range: line(1, 10, 30) })?.top).toBe(48);
  // A phone's end handle under the last line: below that.
  expect(copyButtonPlace({ ...copy, clearBelow: 44, range: line(1, 10, 30) })?.top).toBe(92);
  // The whole screen selected.
  expect(copyButtonPlace({ ...copy, range: { start: { x: 0, y: 100 }, end: { x: 80, y: 123 } } })?.top).toBe(8);
  // A key bar over the room's foot leaves no room below either.
  expect(copyButtonPlace({ ...copy, clearBelow: 44, room: rect(0, 0, 820, 120), range: line(2, 10, 30) })?.top).toBe(8);
});

test("over a grid wider than its room, the Copy button is centred over what is in sight of the selection", () => {
  // The room shows the grid from 10 px to 400 px of its 810.
  const narrow = { ...copy, room: rect(0, 0, 400, 300) };
  expect(copyButtonPlace({ ...narrow, range: { start: { x: 5, y: 105 }, end: { x: 5, y: 107 } } })?.left).toBe(175);
  // Columns 30–50 (310–510 px): in sight to 400 px.
  expect(copyButtonPlace({ ...narrow, range: line(10, 30, 50) })?.left).toBe(325);
});

test("the Copy button stays inside the room the terminal shows", () => {
  // Columns 75–80 centre at 785 px: the button would end past 812.
  expect(copyButtonPlace({ ...copy, range: line(10, 75, 80) })?.left).toBe(752);
  expect(copyButtonPlace({ ...copy, range: line(10, 0, 2) })?.left).toBe(8);
});

test("with none of the selection in sight there is no Copy button", () => {
  // Scrolled out above the screen.
  expect(copyButtonPlace({ ...copy, range: { start: { x: 0, y: 90 }, end: { x: 5, y: 99 } } })).toBeNull();
  // On the screen, but under the room's foot (a pane taller than its room).
  expect(copyButtonPlace({ ...copy, room: rect(0, 0, 820, 100), range: line(15, 10, 30) })).toBeNull();
  // A phone's grid scrolled sideways past a one-line selection: columns
  // 10–30 (110–310 px) left of a room from 400 px.
  expect(copyButtonPlace({ ...copy, room: rect(400, 0, 400, 300), range: line(10, 10, 30) })).toBeNull();
  // Of a selection begun above the screen, only its last line is on it, and
  // that ends at column 5, left of the room.
  expect(copyButtonPlace({ ...copy, room: rect(400, 0, 400, 300), range: { start: { x: 60, y: 95 }, end: { x: 5, y: 100 } } })).toBeNull();
});

test("the Copy button goes by what is in sight of the selection, line by line", () => {
  // Rows 5–6 in sight, row 6 selected to column 5: across, only row 5's
  // part (columns 60–80, 610–810 px) is in a room from 400 px.
  expect(copyButtonPlace({ ...copy, room: rect(400, 0, 420, 300), range: { start: { x: 60, y: 105 }, end: { x: 5, y: 106 } } })).toEqual({ left: 680, top: 30 });
  // Its first lines above a room that starts at row 10 (120 px down): placed
  // by the first line in the room, under it as there is no room above.
  expect(copyButtonPlace({ ...copy, room: rect(0, 120, 820, 180), range: { start: { x: 0, y: 104 }, end: { x: 20, y: 110 } } })).toEqual({ left: 80, top: 138 });
});

test("a block selection (Alt or Option and drag) has the same columns on every line: the Copy button goes by them", () => {
  // Columns 60–70 (610–710 px) on rows 5–7, dragged either way across.
  const block = { start: { x: 70, y: 105 }, end: { x: 60, y: 107 } };
  expect(copyButtonPlace({ ...copy, block: true, range: block })).toEqual({ left: 630, top: 30 });
  // A room that ends at 510 px shows none of it.
  expect(copyButtonPlace({ ...copy, block: true, room: rect(0, 0, 510, 300), range: block })).toBeNull();
});
