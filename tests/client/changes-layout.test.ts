import { expect, test } from "bun:test";
import { changesLayout } from "@/routes/window/changes/changes-layout";

// Widths measured on the Changes tab itself: a phone,
// the thread page's worker panel at a 1440 half split, the worker page at 1440,
// and a wide monitor with the worker maximized.
const measured: Array<{ name: string; width: number; phone: boolean; layout: { drillIn: boolean; split: boolean } }> = [
  { name: "a phone drills in: the list, then one file, unified", width: 358, phone: true, layout: { drillIn: true, split: false } },
  // Beside the 240px list the diff had 322px: 16 characters a side, split.
  { name: "the worker panel at a half split drills in too, though it is not a phone", width: 571, phone: false, layout: { drillIn: true, split: false } },
  // Split gave 60 characters a side there; unified gives the whole box.
  { name: "the worker page at 1440 keeps the list beside a unified diff", width: 1150, phone: false, layout: { drillIn: false, split: false } },
  { name: "split only once each side holds 80 columns", width: 1700, phone: false, layout: { drillIn: false, split: true } },
  // A phone turned sideways past the list-and-diff threshold.
  { name: "a measured width decides, not the device", width: 900, phone: true, layout: { drillIn: false, split: false } }
];

test.each(measured)("$name", ({ width, phone, layout }) => {
  expect(changesLayout(width, phone)).toEqual(layout);
});

test("the thresholds sit where the reasons say", () => {
  // Drill in while the diff beside the list would get under 560px.
  expect(changesLayout(815, false).drillIn).toBe(true);
  expect(changesLayout(816, false).drillIn).toBe(false);
  // Split from a diff box of 2 × (40 gutter + 16 padding + 80 × 7.83) beside the 256px list.
  expect(changesLayout(256 + 1364, false).split).toBe(false);
  expect(changesLayout(256 + 1365, false).split).toBe(true);
});

test("unmeasured (no layout yet, or hidden) follows the device, unified", () => {
  expect(changesLayout(0, true)).toEqual({ drillIn: true, split: false });
  expect(changesLayout(0, false)).toEqual({ drillIn: false, split: false });
});

// The layout changes the tab's height, and a vertical scrollbar that comes and
// goes with it changes its width by ~15px. Without a margin, a tab just past a
// threshold switched every frame: beside the list → taller → scrollbar →
// narrower → drilled in → shorter → no scrollbar → wider → beside…
test("once drilled in, it takes more than a scrollbar's width past the threshold to leave", () => {
  const drilled = { drillIn: true, split: false };
  expect(changesLayout(821, false, drilled).drillIn).toBe(true);
  expect(changesLayout(839, false, drilled).drillIn).toBe(true);
  expect(changesLayout(840, false, drilled).drillIn).toBe(false);
  // From beside the list, the threshold itself still drills in.
  expect(changesLayout(815, false, { drillIn: false, split: false }).drillIn).toBe(true);
});

test("once split, it takes more than a scrollbar's width under the threshold to unsplit", () => {
  const split = { drillIn: false, split: true };
  const unified = { drillIn: false, split: false };
  expect(changesLayout(256 + 1350, false, split).split).toBe(true);
  expect(changesLayout(256 + 1340, false, split).split).toBe(false);
  expect(changesLayout(256 + 1350, false, unified).split).toBe(false);
  expect(changesLayout(256 + 1365, false, unified).split).toBe(true);
});
