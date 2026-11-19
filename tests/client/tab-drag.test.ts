import { expect, test } from "bun:test";
import { carriedX, rowMayScroll } from "@/components/tab-drag";

// A tab carried along a row: it stays over its own group's tabs and inside
// the row's window, and the row scrolls under it only toward more of its
// group. Rects as a browser gives them; happy-dom has no layout.

const at = { nodeLeft: 200, width: 100, groupLeft: 150, groupRight: 450, rowLeft: 50, rowRight: 650 };

test("a carried tab moves freely inside its group", () => {
  expect(carriedX(40, at)).toBe(40);
  expect(carriedX(-30, at)).toBe(-30);
});

test("it stops at its group's ends: the first tab's left, the last tab's right", () => {
  expect(carriedX(-200, at)).toBe(-50);
  expect(carriedX(400, at)).toBe(150);
});

test("a group running past the row's window: it stops at the window's edges", () => {
  const wide = { ...at, groupLeft: -300, groupRight: 900 };
  expect(carriedX(-1000, wide)).toBe(-150);
  expect(carriedX(1000, wide)).toBe(350);
});

test("with less room than the tab is wide, it stays at the room's left", () => {
  expect(carriedX(30, { ...at, groupLeft: 200, groupRight: 260 })).toBe(0);
  expect(carriedX(-30, { ...at, groupLeft: 200, groupRight: 260 })).toBe(0);
});

const row = { left: 0, right: 500 };

test("near the row's right edge it scrolls only while the group goes on past it", () => {
  expect(rowMayScroll(470, row, { left: 0, right: 800 })).toBe(true);
  expect(rowMayScroll(470, row, { left: 0, right: 480 })).toBe(false);
  // Past the edge counts as near it.
  expect(rowMayScroll(540, row, { left: 0, right: 800 })).toBe(true);
});

test("near the left edge it scrolls only while the group goes on past that one", () => {
  expect(rowMayScroll(20, row, { left: -200, right: 300 })).toBe(true);
  expect(rowMayScroll(20, row, { left: 10, right: 300 })).toBe(false);
});

test("away from both edges nothing stops it (the row does not scroll there anyway)", () => {
  expect(rowMayScroll(250, row, { left: 100, right: 300 })).toBe(true);
});

// Where it drops is where the pointer is (a wide tab held by its ×, over a
// short neighbour, drops there); the copy is cut to the room its group has in
// the row; the row scrolls no further than its group goes.
import { clipInsets, dropTarget, scrollRange } from "@/components/tab-drag";

const slots = [{ id: "a", left: 0, right: 260 }, { id: "b", left: 262, right: 346 }, { id: "c", left: 348, right: 500 }];

test("the drop is the slot under the pointer, whatever the carried tab's width", () => {
  expect(dropTarget(300, slots)).toBe("b");
  expect(dropTarget(10, slots)).toBe("a");
  expect(dropTarget(499, slots)).toBe("c");
});

test("between slots, or past the group's ends, it is the nearest slot", () => {
  expect(dropTarget(261, slots)).toBe("a");
  expect(dropTarget(-80, slots)).toBe("a");
  expect(dropTarget(900, slots)).toBe("c");
  expect(dropTarget(5, [])).toBeNull();
});

test("the copy is cut to its group's room in the row: nothing when it fits", () => {
  expect(clipInsets({ left: 100, right: 240 }, { left: 50, right: 400 })).toEqual({ left: 0, right: 0 });
  expect(clipInsets({ left: 300, right: 440 }, { left: 300, right: 330 })).toEqual({ left: 0, right: 110 });
  expect(clipInsets({ left: 20, right: 160 }, { left: 50, right: 400 })).toEqual({ left: 30, right: 0 });
});

test("while a tab is carried the row scrolls only as far as its group reaches, never back past where it started", () => {
  // Content coordinates: the group spans 100–900 in a 300px window.
  expect(scrollRange(0, { left: 100, right: 900 }, 300, 8)).toEqual({ min: 0, max: 608 });
  // A group fully in view at the start: no scrolling either way.
  expect(scrollRange(40, { left: 60, right: 300 }, 300, 8)).toEqual({ min: 40, max: 40 });
  // Started scrolled past its left end (it was out of view): it may come back to it.
  expect(scrollRange(500, { left: 100, right: 700 }, 300, 8)).toEqual({ min: 92, max: 500 });
});

// Only what shows is a place to drop. Past the row's edge, toward the
// header's controls, the drop is the last tab in sight, not one laid out out
// of sight behind them.
test("a pointer past the row's window drops on the nearest slot in sight, never one out of it", () => {
  const laid = [{ id: "a", left: 0, right: 100 }, { id: "b", left: 100, right: 200 }, { id: "c", left: 200, right: 300 }];
  expect(dropTarget(400, laid, { left: 0, right: 150 })).toBe("b");
  expect(dropTarget(250, laid, { left: 0, right: 150 })).toBe("b");
  expect(dropTarget(-50, laid, { left: 120, right: 400 })).toBe("b");
  // None in sight: nowhere.
  expect(dropTarget(50, laid, { left: 400, right: 500 })).toBeNull();
});

// Where the pointer is, on a press, a move or a release: a finger lifted reads
// from the touch that ended.
import { pointerXOf } from "@/components/tab-drag";

test("the pointer's x from a mouse event, a touch moving, and a touch that ended", () => {
  expect(pointerXOf({ clientX: 42 })).toBe(42);
  expect(pointerXOf({ touches: { item: () => ({ clientX: 7 }) }, changedTouches: { item: () => ({ clientX: 9 }) } })).toBe(7);
  expect(pointerXOf({ touches: { item: () => null }, changedTouches: { item: () => ({ clientX: 9 }) } })).toBe(9);
  expect(pointerXOf({ touches: { item: () => null }, changedTouches: { item: () => null } })).toBeNull();
});
