import { expect, test } from "bun:test";
import { END_OF_TIME } from "../src/server/modules/activity/local-days.js";
import { planSlices, type PlannedRead } from "../src/server/modules/activity/slice-plan.js";

// Which kept slices an answer may use, and what it reads from the calls
// instead: the window's two ends, and every slice that is missing or that a
// change at or before it has made out of date.

const at = (hour: number, ms = 0) => new Date(Date.UTC(2026, 2, 4, hour) + ms).toISOString();
const slice = (hour: number) => at(hour).slice(0, 13);
const INPUTS = "inputs-a";
const kept = (hours: number[], builtSeq = 10, inputs = INPUTS) => hours.map((hour) => ({ start: slice(hour), builtSeq, inputs }));

function plan(over: Partial<Parameters<typeof planSlices>[0]>): PlannedRead {
  return planSlices({
    since: at(2, 20 * 60_000), until: null, now: Date.UTC(2026, 2, 4, 7, 30),
    kept: kept([3, 4, 5, 6]), changes: [], state: { seq: 10, floor: 0 }, inputs: INPUTS,
    ...over
  });
}

test("every whole slice kept and valid is used; only the two ends are read from the calls", () => {
  expect(plan({})).toEqual({
    use: [slice(3), slice(4), slice(5), slice(6)],
    build: [
      // The part of the first hour after the window's cut.
      { since: at(2, 20 * 60_000), until: at(3), whole: [] },
      // From the last whole hour's end to the end of time: the hour under way.
      { since: at(7, -1), until: END_OF_TIME, whole: [] }
    ]
  });
});

test("a missing slice and one kept with other inputs are read, in one run with their neighbours", () => {
  const read = plan({ kept: [...kept([3, 6]), ...kept([5], 10, "inputs-b")] });
  expect(read.use).toEqual([slice(3), slice(6)]);
  expect(read.build).toEqual([
    { since: at(2, 20 * 60_000), until: at(3), whole: [] },
    { since: at(4, -1), until: at(6), whole: [slice(4), slice(5)] },
    { since: at(7, -1), until: END_OF_TIME, whole: [] }
  ]);
});

test("a run of slices to read joins the end beside it", () => {
  const read = plan({ kept: kept([4, 5]) });
  expect(read.use).toEqual([slice(4), slice(5)]);
  expect(read.build).toEqual([
    { since: at(2, 20 * 60_000), until: at(4), whole: [slice(3)] },
    { since: at(6, -1), until: END_OF_TIME, whole: [slice(6)] }
  ]);
});

test("a slice built before the floor is read again", () => {
  const read = plan({ kept: [...kept([3, 4], 4), ...kept([5, 6], 9)], state: { seq: 10, floor: 5 } });
  expect(read.use).toEqual([slice(5), slice(6)]);
});

test("a change in a slice after it was built makes it and every later slice out of date", () => {
  const read = plan({ changes: [{ start: slice(4), seq: 12 }], state: { seq: 12, floor: 0 } });
  expect(read.use).toEqual([slice(3)]);
  expect(read.build).toEqual([
    { since: at(2, 20 * 60_000), until: at(3), whole: [] },
    { since: at(4, -1), until: END_OF_TIME, whole: [slice(4), slice(5), slice(6)] }
  ]);
  // Built again since, they are used: the change is no newer than they are.
  const again = plan({ kept: [...kept([3]), ...kept([4, 5, 6], 12)], changes: [{ start: slice(4), seq: 12 }], state: { seq: 12, floor: 0 } });
  expect(again.use).toEqual([slice(3), slice(4), slice(5), slice(6)]);
  // A change no newer than a slice's build was seen by it.
  expect(plan({ changes: [{ start: slice(4), seq: 10 }] }).use).toEqual([slice(3), slice(4), slice(5), slice(6)]);
});

test("a change before the window reaches every slice of it", () => {
  expect(plan({ changes: [{ start: slice(1), seq: 11 }], state: { seq: 11, floor: 0 } }).use).toEqual([]);
  expect(plan({ changes: [{ start: slice(1), seq: 10 }] }).use).toEqual([slice(3), slice(4), slice(5), slice(6)]);
  // The slice the window is cut in is before its whole slices too.
  expect(plan({ changes: [{ start: slice(2), seq: 11 }], state: { seq: 11, floor: 0 } }).use).toEqual([]);
});

test("a window cut on the last millisecond of an hour has no left end; one cut on the hour itself has", () => {
  expect(plan({ since: at(3, -1) }).build[0]).toEqual({ since: at(7, -1), until: END_OF_TIME, whole: [] });
  // `since` is not in the window: a call on the hour's first millisecond is left out, so that hour is not whole.
  const onTheHour = plan({ since: at(3) });
  expect(onTheHour.use).toEqual([slice(4), slice(5), slice(6)]);
  expect(onTheHour.build[0]).toEqual({ since: at(3), until: at(4), whole: [] });
});

test("a window with an end uses the whole slices before it and reads what is left", () => {
  // A picked day: from its first millisecond's eve to the next midnight.
  const day = plan({ since: at(3, -1), until: at(6) });
  expect(day).toEqual({ use: [slice(3), slice(4), slice(5)], build: [] });
  const cut = plan({ since: at(3, -1), until: at(5, 10 * 60_000) });
  expect(cut).toEqual({ use: [slice(3), slice(4)], build: [{ since: at(5, -1), until: at(5, 10 * 60_000), whole: [] }] });
});

test("the hour under way and hours ahead of now are never whole", () => {
  // A call dated ahead (a clock set back): read with the live end, not kept.
  const read = plan({ kept: kept([3, 4, 5, 6, 7, 8]), now: Date.UTC(2026, 2, 4, 7, 30) });
  expect(read.use).toEqual([slice(3), slice(4), slice(5), slice(6)]);
  expect(read.build.at(-1)).toEqual({ since: at(7, -1), until: END_OF_TIME, whole: [] });
  // On the hour exactly, the hour just ended is whole.
  expect(plan({ kept: kept([3, 4, 5, 6]), now: Date.UTC(2026, 2, 4, 7) }).use).toEqual([slice(3), slice(4), slice(5), slice(6)]);
});

// A picked today ends at the next midnight, ahead of now.
test("a window that ends ahead of now keeps the rule: the hour under way and the hours ahead are read, never whole", () => {
  const now = Date.UTC(2026, 2, 4, 7, 30);
  const today = plan({ since: at(3, -1), until: at(10), kept: kept([3, 4, 5, 6, 7, 8]), now });
  expect(today).toEqual({ use: [slice(3), slice(4), slice(5), slice(6)], build: [{ since: at(7, -1), until: at(10), whole: [] }] });
  // With nothing kept the hours before the one under way are whole; the rest is read with them and not kept.
  expect(plan({ since: at(3, -1), until: at(10), kept: [], now }).build).toEqual([{ since: at(3, -1), until: at(10), whole: [slice(3), slice(4), slice(5), slice(6)] }]);
  // Now on the hour exactly: the hours ahead are still read.
  expect(plan({ since: at(3, -1), until: at(10), kept: kept([3, 4, 5, 6]), now: Date.UTC(2026, 2, 4, 7) }))
    .toEqual({ use: [slice(3), slice(4), slice(5), slice(6)], build: [{ since: at(7, -1), until: at(10), whole: [] }] });
  // A window that ends before now is whole to its end, as before.
  expect(plan({ since: at(3, -1), until: at(6), kept: [], now }).build).toEqual([{ since: at(3, -1), until: at(6), whole: [slice(3), slice(4), slice(5)] }]);
  // One wholly ahead of now is one read.
  expect(plan({ since: at(8, -1), until: at(10), kept: kept([8, 9]), now })).toEqual({ use: [], build: [{ since: at(8, -1), until: at(10), whole: [] }] });
});

test("a window inside one hour is one read", () => {
  expect(plan({ since: at(7, 5 * 60_000), kept: [] })).toEqual({ use: [], build: [{ since: at(7, 5 * 60_000), until: END_OF_TIME, whole: [] }] });
  expect(plan({ since: at(6, 5 * 60_000), until: at(6, 50 * 60_000), kept: kept([6]) })).toEqual({ use: [], build: [{ since: at(6, 5 * 60_000), until: at(6, 50 * 60_000), whole: [] }] });
});

test("nothing kept: the window is one read, and names every whole slice to keep", () => {
  const read = plan({ kept: [] });
  expect(read).toEqual({ use: [], build: [{ since: at(2, 20 * 60_000), until: END_OF_TIME, whole: [slice(3), slice(4), slice(5), slice(6)] }] });
});
