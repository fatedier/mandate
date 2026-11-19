import { expect, test } from "bun:test";
import { boardInset, boardOffered, foldedColumns, stepTo } from "@/routes/task-board/board-layout";

// A board in a pane. A column folded by hand is out of the row; so, where
// the pane is short of room, is a status with no task, unless the owner has
// opened it by hand. What still does not fit is off to the side, a step away.

const FOUR = ["todo", "progress", "review", "done"];
const folded = (columns: string[], width: number, empty: string[], byHand: Record<string, boolean> = {}) =>
  [...foldedColumns(columns, width, { isEmpty: (column) => empty.includes(column), fold: (column) => byHand[column] })];

test("room for every column at its roomy width: none folds, an empty status too; nor before the pane is measured", () => {
  // Four columns of 220 and three gaps of 12 are 916.
  expect(folded(FOUR, 916, ["review"])).toEqual([]);
  expect(folded(FOUR, 1400, ["review", "done"])).toEqual([]);
  expect(folded(FOUR, 0, ["review"])).toEqual([]);
});

test("short of room, each status with no task folds away", () => {
  expect(folded(FOUR, 915, ["review"])).toEqual(["review"]);
  expect(folded(FOUR, 544, ["review", "done"])).toEqual(["review", "done"]);
  expect(folded(FOUR, 544, [])).toEqual([]);
});

test("a board with no task anywhere keeps its columns", () => {
  expect(folded(FOUR, 544, FOUR)).toEqual([]);
});

test("a column folded by hand is folded whatever the room, and before the pane is measured", () => {
  expect(folded(FOUR, 1400, [], { done: true })).toEqual(["done"]);
  expect(folded(FOUR, 0, ["review"], { done: true })).toEqual(["done"]);
});

test("a folded column takes no room: an empty status folds only when the rest still do not fit", () => {
  // Done folded: three columns of 220 and two gaps of 12 are 684.
  expect(folded(FOUR, 684, ["review"], { done: true })).toEqual(["done"]);
  expect(folded(FOUR, 683, ["review"], { done: true })).toEqual(["done", "review"]);
  // Every column that is left is empty: they stay.
  expect(folded(FOUR, 500, ["todo", "progress", "review"], { done: true })).toEqual(["done"]);
});

test("a status opened by hand stays open with no task, however short the room", () => {
  expect(folded(FOUR, 544, ["review"], { review: false })).toEqual([]);
  expect(folded(FOUR, 544, ["review", "done"], { review: false })).toEqual(["done"]);
});

// Columns of 180 with gaps of 12, in a pane 400 wide whose content keeps 24 from each edge.
const COLUMNS = [24, 216, 408, 600].map((left) => ({ left, width: 180 }));
const pane = (left: number) => ({ left, width: 400, inset: 24 });

test("a step to the right brings the nearest column cut off there into view whole, against the pane's inset", () => {
  // At the start the second column (216–396) is cut at 376: a step ends it 24 from the right edge.
  expect(stepTo("right", pane(0), COLUMNS)).toBe(20);
  expect(stepTo("right", pane(20), COLUMNS)).toBe(212);
  expect(stepTo("right", pane(212), COLUMNS)).toBe(404);
  // The last column is in view whole: nothing further.
  expect(stepTo("right", pane(404), COLUMNS)).toBeNull();
});

test("a step to the left does the same on that side, and stops at the first column", () => {
  expect(stepTo("left", pane(404), COLUMNS)).toBe(384);
  expect(stepTo("left", pane(384), COLUMNS)).toBe(192);
  expect(stepTo("left", pane(192), COLUMNS)).toBe(0);
  expect(stepTo("left", pane(0), COLUMNS)).toBeNull();
});

// The Board among the views. A desktop always has it. In phone mode (a small
// screen: one thing at a time) it is offered where three columns fit whole:
// 3 × 170 and two gaps of 12, inside a phone page's gutter of 16 at each
// side, are 566.
test("a desktop is offered the Board whatever the room", () => {
  expect([boardOffered(false, 0), boardOffered(false, 320), boardOffered(false, 1400)]).toEqual([true, true, true]);
});

test("in phone mode the Board is offered where three columns fit, not before the page is measured", () => {
  expect([boardOffered(true, 0), boardOffered(true, 390), boardOffered(true, 565)]).toEqual([false, false, false]);
  expect([boardOffered(true, 566), boardOffered(true, 700)]).toEqual([true, true]);
});

test("the board's margin is the page's gutter: narrower in phone mode", () => {
  expect([boardInset(false), boardInset(true)]).toEqual([24, 16]);
});
