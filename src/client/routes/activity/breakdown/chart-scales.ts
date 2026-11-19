import { scaleLinear, scaleSqrt } from "d3-scale";

/** A rectangle in the chart's own pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A dot wanting a label beside it, and the size of that label. */
export interface LabelRequest {
  key: string;
  cx: number;
  cy: number;
  r: number;
  width: number;
  height: number;
}

export type LabelSide = "right" | "left" | "above" | "below";

export interface PlacedLabel {
  key: string;
  side: LabelSide;
  box: Box;
}

/** Room between a dot's edge and its label. */
const LABEL_GAP = 4;

/** The label text's size (11px monospace, the font the map's names are set
 *  in). Estimated from its length rather than measured: a measure needs the
 *  text on the page first, and a monospace advance is ~0.6em per character.
 *  Rounded up, so a real label is never wider than the box it was placed by. */
export const LABEL_FONT_PX = 11;
export const LABEL_HEIGHT = 13;
export function labelWidth(text: string): number {
  return Math.ceil(text.length * LABEL_FONT_PX * 0.62);
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(box: Box, plot: Box): boolean {
  return box.x >= plot.x && box.y >= plot.y
    && box.x + box.width <= plot.x + plot.width && box.y + box.height <= plot.y + plot.height;
}

function coversDot(box: Box, dot: LabelRequest): boolean {
  const nearestX = Math.max(box.x, Math.min(dot.cx, box.x + box.width));
  const nearestY = Math.max(box.y, Math.min(dot.cy, box.y + box.height));
  return Math.hypot(nearestX - dot.cx, nearestY - dot.cy) < dot.r;
}

function candidate(dot: LabelRequest, side: LabelSide): Box {
  const { cx, cy, r, width, height } = dot;
  switch (side) {
    case "right": return { x: cx + r + LABEL_GAP, y: cy - height / 2, width, height };
    case "left": return { x: cx - r - LABEL_GAP - width, y: cy - height / 2, width, height };
    case "above": return { x: cx - width / 2, y: cy - r - LABEL_GAP - height, width, height };
    case "below": return { x: cx - width / 2, y: cy + r + LABEL_GAP, width, height };
  }
}

const SIDES: readonly LabelSide[] = ["right", "left", "above", "below"];

/**
 * A label beside each dot where one fits: right, left, above, then below
 * it, larger dots first (they stand for more calls). A label goes only where
 * it stays inside the plot and clear of every other label, every other dot
 * and the `taken` boxes (text the chart already holds). A dot whose label
 * fits nowhere is left out: its card, on hover or focus, names it.
 */
export function placeLabels(requests: readonly LabelRequest[], plot: Box, taken: readonly Box[] = []): PlacedLabel[] {
  const order = [...requests].sort((a, b) => b.r - a.r || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const boxes: Box[] = [...taken];
  const placed: PlacedLabel[] = [];
  for (const dot of order) {
    for (const side of SIDES) {
      const box = candidate(dot, side);
      if (!inside(box, plot)) continue;
      if (boxes.some((other) => overlaps(box, other))) continue;
      if (requests.some((other) => other.key !== dot.key && coversDot(box, other))) continue;
      boxes.push(box);
      placed.push({ key: dot.key, side, box });
      break;
    }
  }
  return placed;
}

/** A linear axis from zero to a round number at or above `max`, with about
 *  `count` round ticks along it. A max of zero still spans one unit, so a
 *  scale never divides by zero. */
export function linearAxis(max: number, range: [number, number], count = 4) {
  const scale = scaleLinear().domain([0, max > 0 ? max : 1]).range(range).nice(count);
  return { scale, ticks: scale.ticks(count) };
}

/** A dot's radius for its calls: the area follows the count, with a floor
 *  so the smallest group stays a mark a pointer can find. */
export function dotRadius(maxCalls: number, largest: number, smallest = 4) {
  const scale = scaleSqrt().domain([0, maxCalls > 0 ? maxCalls : 1]).range([0, largest]);
  return (calls: number) => Math.max(smallest, scale(calls));
}

/**
 * Labels stacked at the end of their lines, each moved as little as it must
 * so that no two sit closer than `gap`, all between `top` and `bottom`, and
 * none passing another: they keep the order their lines end in. Pushed down
 * first, then, if the last ran past the bottom, back up from there.
 */
export function spreadLabels(ys: readonly number[], gap: number, top: number, bottom: number): number[] {
  const order = ys.map((_, index) => index).sort((a, b) => ys[a]! - ys[b]! || a - b);
  const placed = order.map((index) => Math.min(bottom, Math.max(top, ys[index]!)));
  for (let at = 1; at < placed.length; at += 1) placed[at] = Math.max(placed[at]!, placed[at - 1]! + gap);
  const last = placed.length - 1;
  if (last >= 0 && placed[last]! > bottom) {
    placed[last] = bottom;
    for (let at = last - 1; at >= 0; at -= 1) placed[at] = Math.min(placed[at]!, placed[at + 1]! - gap);
  }
  const out = new Array<number>(ys.length);
  order.forEach((index, at) => { out[index] = placed[at]!; });
  return out;
}

/** A tick on a time axis: whole seconds read as such. */
export function formatAxisSeconds(ms: number): string {
  if (ms === 0) return "0";
  if (ms < 1000) return `${ms}ms`;
  return `${Number((ms / 1000).toFixed(1))}s`;
}

/** Where a card `cardWidth` wide goes across a chart `width` wide, beside a
 *  mark at `x` that reaches `reach` either side of it: to its right when it
 *  fits there, else to its left, and inside the chart either way (over the
 *  mark when neither side has room, as on a phone): the panel around a
 *  chart clips whatever runs past its edge. */
export function besideMark(x: number, reach: number, cardWidth: number, width: number): number {
  const right = x + reach + 10;
  const left = right + cardWidth <= width ? right : x - reach - 10 - cardWidth;
  return Math.max(0, Math.min(left, width - cardWidth));
}

/** The first of `spots` that no dot reaches into, or null when every one is
 *  covered: for text that must stay legible over the marks (the speed map's
 *  corner hint), and gives way to them rather than hiding one. */
export function firstClear(spots: readonly Box[], dots: ReadonlyArray<{ cx: number; cy: number; r: number }>): Box | null {
  return spots.find((spot) => dots.every((dot) => !coversDot(spot, { key: "", width: 0, height: 0, ...dot }))) ?? null;
}

/** The dots' names first, then a hint in the first of `spots` clear of them
 *  and of every dot (with `ring` to spare): a name says which dot is which,
 *  the hint only what a corner means, so the hint gives way. */
export function placeWithHint(
  requests: readonly LabelRequest[],
  area: Box,
  spots: readonly Box[],
  ring = 2
): { labels: PlacedLabel[]; hint: Box | null } {
  const labels = placeLabels(requests, area);
  const free = spots.filter((spot) => labels.every((label) => !overlaps(spot, label.box)));
  return { labels, hint: firstClear(free, requests.map((dot) => ({ cx: dot.cx, cy: dot.cy, r: dot.r + ring }))) };
}
