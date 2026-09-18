import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ActivityDailyDto } from "@shared/api-contracts";
import { DailyChart } from "@/routes/activity/overview/DailyChart";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The chart's geometry is attributes on a 0-100 viewBox, not a measured box, so
 * it is readable in a tier that performs no layout: a bar's `height` is its
 * share of the busiest day, and the failure band's `y` plus its `height` land
 * on the foot of the plot.
 */

function day(date: string, calls: number, failed: number): ActivityDailyDto {
  return {
    date,
    calls,
    failed,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0
  };
}

// A busy day with a quarter of its calls failing, a silent day, and a half-size
// day that failed nothing: the three shapes a bar can take.
const DAILY: ActivityDailyDto[] = [
  day("2026-08-01", 100, 25),
  day("2026-08-02", 0, 0),
  day("2026-08-03", 50, 0)
];

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderChart(daily: ActivityDailyDto[]): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DailyChart daily={daily} />);
  });
  return container;
}

function bars(page: HTMLElement): Element[] {
  return Array.from(page.querySelectorAll("g"));
}

function rectsIn(group: Element | undefined): Element[] {
  return Array.from(group?.querySelectorAll("rect") ?? []);
}

test("a day that failed calls gets a second rect; a day that did not gets one", async () => {
  const page = await renderChart(DAILY);
  expect(bars(page).length).toBe(3);
  expect(bars(page).map((group) => rectsIn(group).length)).toEqual([2, 1, 1]);
});

test("a bar's height is its share of the busiest day", async () => {
  const page = await renderChart(DAILY);
  const column = (index: number) => {
    const rect = rectsIn(bars(page)[index])[0];
    return [rect?.getAttribute("y"), rect?.getAttribute("height")];
  };
  // The plot is a 0-100 viewBox with y growing downward, so the busiest day
  // starts at 0 and fills it, and a day at half the traffic starts halfway.
  expect(column(0)).toEqual(["0", "100"]);
  expect(column(1)).toEqual(["100", "0"]);
  expect(column(2)).toEqual(["50", "50"]);
});

test("the failure band is the failed share of its own bar, drawn at the foot", async () => {
  const page = await renderChart(DAILY);
  const failed = rectsIn(bars(page)[0])[1];
  // 25 of 100 calls failed on a bar 100 tall, so the band is 25 tall and its
  // foot sits on the baseline — not stacked from the top, where it would read
  // as the successes.
  expect(failed?.getAttribute("height")).toBe("25");
  expect(failed?.getAttribute("y")).toBe("75");
});

test("every day gets a target of its own, named for the day it stands over", async () => {
  const page = await renderChart(DAILY);
  // The `<title>` these once carried is gone: a native tooltip appearing a
  // second later, on top of the card, is worse than either alone. What a
  // reader can reach is the target, so that is what the days are counted by.
  expect(Array.from(page.querySelectorAll("[data-chart-hit]"))
    .map((node) => node.getAttribute("data-chart-hit"))).toEqual([
    "2026-08-01",
    "2026-08-02",
    "2026-08-03"
  ]);
});

test("the bars are one per day, evenly spaced across the whole plot", async () => {
  // Nothing else reads `x` or `width`, so a chart that stacked all 31 days into
  // one column — dropping `index` from the offset, or sizing the track off
  // something other than the day count — is green everywhere else in the suite.
  // Four days so the arithmetic lands on exact decimals: a 25-wide track, a bar
  // 66% of it, inset by 17%. Their call counts differ, so a width derived from
  // the traffic rather than the day count reads as four values, not one.
  const page = await renderChart([
    day("2026-08-01", 100, 0),
    day("2026-08-02", 40, 0),
    day("2026-08-03", 100, 0),
    day("2026-08-04", 75, 0)
  ]);
  const geometry = (attribute: string) =>
    bars(page).map((group) => rectsIn(group)[0]?.getAttribute(attribute));

  expect(geometry("x")).toEqual(["4.25", "29.25", "54.25", "79.25"]);
  // One value, so every day gets the same column however busy it was, and the
  // last bar's right edge — 79.25 + 16.5 — stays inside the viewBox.
  expect([...new Set(geometry("width"))]).toEqual(["16.5"]);

  // The numbers above are only widths because of the coordinate system they
  // are read in; a resized viewBox rescales all of them at once.
  expect(page.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 100 100");
});

test("the failure band sits on its own bar, not on the first one", async () => {
  // `y` and `height` already pin the band vertically, but both are read off
  // the day's own counts — a band drawn at the wrong `x` would still measure
  // right. Only the last day fails anything, so its band must be the rightmost
  // column and must line up with the bar underneath it.
  const page = await renderChart([
    day("2026-08-01", 100, 0),
    day("2026-08-02", 100, 0),
    day("2026-08-03", 100, 0),
    day("2026-08-04", 100, 50)
  ]);
  const last = rectsIn(bars(page)[3]);
  expect(last.length).toBe(2);
  expect(last[1]?.getAttribute("x")).toBe("79.25");
  expect(last[1]?.getAttribute("x")).toBe(last[0]?.getAttribute("x"));
  expect(last[1]?.getAttribute("width")).toBe(last[0]?.getAttribute("width"));
});

test("a failure share too thin to see is left off rather than drawn as a line", async () => {
  const page = await renderChart([day("2026-08-01", 1000, 1)]);
  // One failure in a thousand is a third of a unit on a 100-unit plot. Drawn,
  // it is a hairline at the foot of every bar that claims more than it is.
  expect(rectsIn(bars(page)[0]).length).toBe(1);
});

test("a window with no days at all draws no chart", async () => {
  const page = await renderChart([]);
  // Counted, not compared to null: a failed assertion on a DOM node serialises
  // the tree and the runner never comes back.
  expect(page.querySelectorAll("svg").length).toBe(0);
});

test("bars are neutral; only failures are coloured", async () => {
  const svg = await renderChart(DAILY);
  const bars = Array.from(svg.querySelectorAll("g rect"));
  const classes = bars.map((r) => r.getAttribute("class") ?? "");
  expect(classes.some((c) => c.includes("fill-faint"))).toBe(true);
  expect(classes.some((c) => c.includes("fill-status-input"))).toBe(true);
  expect(classes.some((c) => c.includes("fill-primary"))).toBe(false);
  expect(classes.some((c) => c.includes("fill-destructive"))).toBe(false);
  // Nothing is hovered yet: no band, no lifted bar.
  expect(svg.querySelector("[data-chart-band]") === null).toBe(true);
  expect(classes.some((c) => c.includes("fill-muted-foreground"))).toBe(false);
});

test("the hovered day gets a --sel band behind the column and its bar lifts to muted-foreground", async () => {
  const svg = await renderChart(DAILY);
  const hit = svg.querySelector("[data-chart-hit]")!;
  await act(async () => {
    hit.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  const band = svg.querySelector("[data-chart-band]")!;
  expect(band === null).toBe(false);
  expect((band.getAttribute("class") ?? "").split(/\s+/)).toContain("fill-sel");
  const lifted = bars(svg).map((g) => rectsIn(g)[0]!.getAttribute("class") ?? "");
  // Only the hovered column lifts; the others keep the neutral fill.
  expect(lifted[0]!.split(/\s+/)).toContain("fill-muted-foreground");
  expect(lifted.slice(1).every((c) => c.split(/\s+/).includes("fill-faint"))).toBe(true);
});
