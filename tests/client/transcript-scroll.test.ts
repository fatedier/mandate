import { expect, test } from "bun:test";
import { followAfterScroll, scrollTopAfterPrepend, shouldLoadOlder } from "@/routes/window/chat/transcript-scroll";

// A scroller 500px tall over 3000px of content: its end is at top 2500.
const box = (top: number, height = 3000, client = 500) => ({ top, height, client });

test("the reader's own scroll up past 24px stops following; a smaller one does not", () => {
  expect(followAfterScroll(true, box(2500), box(2470))).toBe(false);
  expect(followAfterScroll(true, box(2500), box(2480))).toBe(true);
  // Small steps add up: it is the distance from the end that counts.
  expect(followAfterScroll(true, box(2490), box(2470))).toBe(false);
});

test("a layout change is not the reader scrolling: content or view growing, or content shrinking under them", () => {
  // Content grew below a following reader: far from the end, still following.
  expect(followAfterScroll(true, box(2500), box(2500, 3400))).toBe(true);
  // Content shrank and the browser clamped scrollTop.
  expect(followAfterScroll(true, box(2500), box(2300, 2800))).toBe(true);
  // The view grew and the browser clamped scrollTop.
  expect(followAfterScroll(true, box(2500), box(2400, 3000, 600))).toBe(true);
  // The reader scrolled up while content grew below in the same frame.
  expect(followAfterScroll(true, box(2500), box(2400, 3200))).toBe(false);
});

test("reaching the end follows again, from wherever; short of it, a reader who left stays left", () => {
  expect(followAfterScroll(false, box(1000), box(2498))).toBe(true);
  expect(followAfterScroll(false, box(1000), box(2490))).toBe(false);
  // Content that does not fill the view is all at its end.
  expect(followAfterScroll(false, box(0, 300), box(0, 300))).toBe(true);
  // No earlier reading: nothing to call a scroll up.
  expect(followAfterScroll(true, null, box(1000))).toBe(true);
});

const idle = { hasMore: true, failed: false, loading: false, windowed: false };

test("older messages are asked for within a screen of the top, or when the content does not fill the view", () => {
  expect(shouldLoadOlder(box(499), idle)).toBe(true);
  expect(shouldLoadOlder(box(500), idle)).toBe(false);
  expect(shouldLoadOlder(box(0, 400), idle)).toBe(true);
  // A view with no height measures nothing.
  expect(shouldLoadOlder(box(0, 0, 0), idle)).toBe(false);
});

test("older messages are not asked for with none left, one on its way, a failure, or a window not yet open", () => {
  for (const blocked of ["hasMore", "failed", "loading", "windowed"] as const) {
    expect(shouldLoadOlder(box(0), { ...idle, [blocked]: blocked !== "hasMore" })).toBe(false);
  }
});

test("after older rows land, scrollTop moves by how far the reader's row moved down", () => {
  // The row was 120px into the content and is 720px in after the page.
  expect(scrollTopAfterPrepend({ top: 100, height: 1000, anchorTop: 120 }, { height: 1600, anchorTop: 720 })).toBe(700);
  // The slot at the top went with the last page: the row moved less than the content grew.
  expect(scrollTopAfterPrepend({ top: 100, height: 1000, anchorTop: 120 }, { height: 1600, anchorTop: 684 })).toBe(664);
});

test("with no row to measure, scrollTop moves by how much the content grew", () => {
  expect(scrollTopAfterPrepend({ top: 120, height: 1000, anchorTop: null }, { height: 1600, anchorTop: null })).toBe(720);
  expect(scrollTopAfterPrepend({ top: 120, height: 1000, anchorTop: 300 }, { height: 1600, anchorTop: null })).toBe(720);
});
