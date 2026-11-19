import { expect, test } from "bun:test";
import { FitSettle } from "../src/server/runtime/runtimes/tmux-fit-settle.js";

// After a fit resizes a window, the first paint waits for the pane's screen
// to settle: full-screen programs redraw for the new size a moment later.

/** A capture as capturePaneRows takes it: a line per row. */
const screen = (rows: string[]) => `${rows.join("\n")}\n`;
const rows = (changes: Record<number, string> = {}) =>
  Array.from({ length: 12 }, (_, i) => changes[i] ?? `row ${i}`);
const SAMPLE_TIMES = [100, 180, 260, 340, 420, 500, 580, 660, 740];

/** The sample times at which it reads settled. */
function settledAt(captures: Array<string | null>): number[] {
  const settle = new FitSettle();
  return captures.flatMap((capture, i) => (settle.sample(capture, SAMPLE_TIMES[i]!) ? [SAMPLE_TIMES[i]!] : []));
}

test("a screen alike three samples running has settled, however soon", () => {
  const still = screen(rows());
  expect(settledAt([still, still, still])).toEqual([260]);
});

test("a screen with one row changing every sample (a spinner) has not settled before half a second, and has from then on", () => {
  const spinning = SAMPLE_TIMES.map((t) => screen(rows({ 4: `working ${t}` })));
  expect(settledAt(spinning.slice(0, 6))).toEqual([500]);
});

test("two rows changing, the same two, settle after half a second; a third keeps it waiting", () => {
  const two = SAMPLE_TIMES.map((t, i) => screen(rows(i % 2 ? { 4: `spin ${t}` } : { 4: `spin ${t}`, 9: `${t} s` })));
  expect(settledAt(two.slice(0, 6))).toEqual([500]);
  const three = SAMPLE_TIMES.map((t, i) => screen(rows({ 4: `spin ${t}`, 9: `${t} s`, [i % 2 ? 2 : 6]: `${t}` })));
  expect(settledAt(three.slice(0, 7))).toEqual([]);
});

test("a redraw past half a second (many rows changed) keeps it waiting until two quiet samples follow", () => {
  const before = (t: number) => screen(rows({ 4: `spin ${t}` }));
  const after = (t: number) => screen(rows({ 0: "top", 1: "bar", 2: "new", 3: "new", 4: `spin ${t}`, 5: "new", 6: "new", 7: "new" }));
  expect(settledAt([before(100), before(180), before(260), before(340), before(420), after(500), after(580), after(660)])).toEqual([660]);
});

test("a sample tmux did not answer starts the count over", () => {
  const still = screen(rows());
  expect(settledAt([still, null, still, still, still])).toEqual([420]);
});

test("a screen whose row count changed between samples, still being resized, has not settled", () => {
  const growing = SAMPLE_TIMES.map((t, i) => screen(Array.from({ length: 10 + (i % 2) }, (_, r) => (r === 4 ? `spin ${t}` : `row ${r}`))));
  expect(settledAt(growing.slice(0, 7))).toEqual([]);
});

test("at 1.4 s it has settled, whatever the screen", () => {
  const settle = new FitSettle();
  const busy = (t: number) => screen(Array.from({ length: 12 }, (_, r) => `${r} ${t}`));
  for (const t of SAMPLE_TIMES) expect(settle.sample(busy(t), t)).toBe(false);
  expect(settle.sample(busy(1400), 1400)).toBe(true);
});
