import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import fc from "fast-check";
import type { ActivityGroupDto, ActivitySummaryResponse, ActivityTrendDto, ActivityTrendValueDto } from "@shared/api-contracts";
import { BreakdownTab } from "@/routes/activity/BreakdownTab";
import { labelWidth, spreadLabels } from "@/routes/activity/breakdown/chart-scales";
import { DayTrends } from "@/routes/activity/breakdown/DayTrends";
import { useUIStore } from "@/store/ui";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync } from "../helpers/mount.js";

/** happy-dom performs no layout: the charts draw at their default width
 *  here; what they look like in a real box is checked in e2e. */

afterEach(() => {
  runCleanups();
  act(() => { useUIStore.setState({ breakdownTableOpen: false }); });
});

const DATES = ["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"];

function value(key: string, fields: Partial<ActivityTrendValueDto> = {}): ActivityTrendValueDto {
  return { key, calls: 10, spendMicros: 1_000_000, ttftP95Ms: 2_000, failedRate: 0, ...fields };
}

/** Three models and the rest, every value set unless a day says otherwise. */
function trend(overrides: Record<string, Record<string, Partial<ActivityTrendValueDto>>> = {}): ActivityTrendDto {
  const series = [
    { key: "gateway / openai/gpt-5.5", label: "gateway / openai/gpt-5.5", others: false, models: 1 },
    { key: "gateway / anthropic/claude-opus-4-5", label: "gateway / anthropic/claude-opus-4-5", others: false, models: 1 },
    { key: "mirror / openai/gpt-5.5", label: "mirror / openai/gpt-5.5", others: false, models: 1 },
    { key: "others", label: "others", others: true, models: 6 }
  ];
  return {
    series,
    days: DATES.map((date) => ({ date, values: series.map(({ key }) => value(key, overrides[date]?.[key])) }))
  };
}

async function render(data: ActivityTrendDto, onSelect: (day: string) => void = () => {}) {
  const { host } = await mountAsync(<DayTrends trend={data} estimated onSelect={onSelect} />);
  return host;
}

test("three charts, a day each, with a legend naming the lines in their order", async () => {
  const page = await render(trend());
  expect([...page.querySelectorAll("[data-trend-chart]")].map((chart) => chart.getAttribute("data-trend-chart"))).toEqual(["spend", "ttft", "failed"]);
  expect([...page.querySelectorAll("[data-trend-legend] li")].map((item) => item.textContent)).toEqual([
    "gpt-5.5 (gateway)", "claude-opus-4-5", "gpt-5.5 (mirror)", "6 others"
  ]);
  const titles = [...page.querySelectorAll('[data-slot="section-title"]')].map((title) => title.textContent);
  expect(titles).toEqual(["Spend a day", "TTFT p95 a day", "Failed a day"]);
  // Each chart draws every line.
  expect(page.querySelectorAll('[data-trend-chart="ttft"] [data-trend-line]').length).toBe(4);
});

test("a day with no reading breaks the line rather than dropping it to zero", async () => {
  const key = "gateway / anthropic/claude-opus-4-5";
  const page = await render(trend({ "2026-10-30": { [key]: { calls: 0, ttftP95Ms: null, failedRate: null } } }));
  const path = page.querySelector(`[data-trend-chart="ttft"] [data-trend-line="${key}"]`)!.getAttribute("d") ?? "";
  // Two runs: the first day alone, then the last two.
  expect(path.match(/M/g)?.length).toBe(2);
  // The lone first day is still drawn, as a point.
  expect(page.querySelectorAll(`[data-trend-chart="ttft"] [data-trend-point="${key}"]`).length).toBe(1);
});

test("the lines' end labels stay apart however close the lines end", async () => {
  // Every line ends within a hair of the others.
  const last = Object.fromEntries(trend().series.map(({ key }, index) => [key, { ttftP95Ms: 2_000 + index }]));
  const page = await render(trend({ "2026-11-01": last }));
  const ys = [...page.querySelectorAll('[data-trend-chart="ttft"] [data-trend-end]')]
    .map((label) => Number(label.getAttribute("y"))).sort((a, b) => a - b);
  expect(ys.length).toBe(4);
  for (let index = 1; index < ys.length; index += 1) expect(ys[index]! - ys[index - 1]!).toBeGreaterThanOrEqual(15);
});

test("spread labels keep their gap and stay between the bounds", () => {
  fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 120 }), { minLength: 1, maxLength: 4 }), (ys) => {
    const out = spreadLabels(ys, 13, 0, 120);
    const sorted = [...out].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) expect(sorted[index]! - sorted[index - 1]!).toBeGreaterThanOrEqual(13 - 1e-9);
    for (const y of out) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(120);
    }
    // A label keeps its order among the others.
    const order = (list: number[]) => list.map((_, index) => index).sort((a, b) => list[a]! - list[b]! || a - b);
    expect(order(out)).toEqual(order(ys));
  }));
});

test("hovering a day shows that day's figures, and a click opens that day", async () => {
  const seen: string[] = [];
  const page = await render(trend({ "2026-10-31": { "gateway / openai/gpt-5.5": { spendMicros: 4_200_000 } } }), (day) => { seen.push(day); });
  const column = page.querySelector<SVGElement>('[data-trend-chart="spend"] [data-trend-day="2026-10-31"]')!;
  await act(async () => { column.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
  const card = page.querySelector('[data-trend-chart="spend"] [data-trend-card]');
  expect(card?.getAttribute("data-trend-card")).toBe("2026-10-31");
  expect(card?.textContent).toContain("Oct 31");
  expect(card?.textContent).toContain("gpt-5.5 (gateway)~$4.20");
  expect(column.getAttribute("aria-label")).toContain("gpt-5.5 (gateway) ~$4.20");
  await act(async () => { column.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
  await act(async () => { column.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(seen).toStrictEqual(["2026-10-31", "2026-10-31"]);
});

test("with one model there is one line and no rest", async () => {
  const series = [{ key: "gateway / judge-1", label: "gateway / judge-1", others: false, models: 1 }];
  const page = await render({ series, days: DATES.map((date) => ({ date, values: [value("gateway / judge-1")] })) });
  expect([...page.querySelectorAll("[data-trend-legend] li")].map((item) => item.textContent)).toEqual(["judge-1"]);
  expect(page.querySelectorAll('[data-trend-chart="spend"] [data-trend-line]').length).toBe(1);
});

function dayGroup(key: string): ActivityGroupDto {
  return {
    key, label: key, calls: 10, failed: 0, p50Ms: 1000, ttftP95Ms: 2_000, tokensPerSecondP50: 40,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasons: [], spendMicros: 0, spendEstimated: false, unpricedCalls: 0
  };
}

test("grouped by day, the Breakdown shows the day charts over the folded table, not the speed map", async () => {
  const data: ActivitySummaryResponse = {
    days: 7,
    ledger: { rows: [], totals: {} } as unknown as ActivitySummaryResponse["ledger"],
    spend: { micros: 0, reportedMicros: 0, estimated: true, pricedCalls: 0, unpricedCalls: 0, includedCalls: 0, pendingCalls: 0 },
    daily: [], dates: DATES, group: "day", groups: DATES.map(dayGroup), trend: trend()
  };
  const { host } = await mountAsync(<BreakdownTab data={data} loading={false} group="day" onSelectGroup={() => {}} onSelectRow={() => {}} />);
  expect(host.querySelectorAll("[data-trend-chart]").length).toBe(3);
  expect(host.querySelector("[data-speed-dot]") === null).toBe(true);
  expect(host.querySelector("[data-breakdown-fold]")?.getAttribute("aria-expanded")).toBe("false");
});

test("on a phone a day's card stays inside the chart", async () => {
  // happy-dom lays nothing out: the chart reports a phone's width.
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "getBoundingClientRect");
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      const rect = original.call(this);
      return this.hasAttribute("data-trend-chart") ? { ...rect.toJSON?.(), x: 0, y: 0, top: 0, left: 0, right: 356, bottom: 150, width: 356, height: 150 } : rect;
    }
  });
  try {
    const page = await render(trend());
    // A day in the middle of the window: right of it, a 224px card runs out.
    const column = page.querySelector<SVGElement>('[data-trend-chart="spend"] [data-trend-day="2026-10-30"]')!;
    await act(async () => { column.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
    const card = page.querySelector<HTMLElement>('[data-trend-chart="spend"] [data-trend-card]')!;
    const left = Number.parseFloat(card.style.left);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + Number.parseFloat(card.style.width)).toBeLessThanOrEqual(356);
  } finally {
    if (descriptor) Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", descriptor);
    else delete (window.HTMLElement.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
  }
});

function ticks(page: HTMLElement, metric: string): Array<{ text: string; x: number }> {
  return [...page.querySelectorAll(`[data-trend-chart="${metric}"] [data-trend-tick]`)]
    .map((tick) => ({ text: tick.textContent ?? "", x: Number(tick.getAttribute("x")) }));
}

test("low failure shares keep a distinct label on every tick", async () => {
  // One failure in five hundred calls: the axis tops out at 0.2%.
  const low = Object.fromEntries(DATES.map((date, index) => [date, Object.fromEntries(trend().series.map(({ key }) => [key, { failedRate: index * 0.05 }]))]));
  const page = await render(trend(low));
  const labels = ticks(page, "failed").map((tick) => tick.text);
  expect(labels.length).toBeGreaterThan(2);
  expect(new Set(labels).size).toBe(labels.length);
});

test("small amounts on the spend axis fit beside it, whole", async () => {
  const cheap = Object.fromEntries(DATES.map((date, index) => [date, Object.fromEntries(trend().series.map(({ key }) => [key, { spendMicros: 500 * index }]))]));
  const page = await render(trend(cheap));
  const labels = ticks(page, "spend");
  expect(labels.length).toBeGreaterThan(2);
  expect(new Set(labels.map((tick) => tick.text)).size).toBe(labels.length);
  // Right-aligned at x: the whole label sits right of the chart's left edge.
  for (const tick of labels) expect(tick.x - labelWidth(tick.text)).toBeGreaterThanOrEqual(0);
});

test("a chart with nothing to draw is left out: no spend in the window, no first token", async () => {
  // Every call included in a plan, and every model answering whole.
  const none = Object.fromEntries(DATES.map((date) => [date, Object.fromEntries(trend().series.map(({ key }) => [key, { spendMicros: 0, ttftP95Ms: null }]))]));
  const page = await render(trend(none));
  expect([...page.querySelectorAll("[data-trend-chart]")].map((chart) => chart.getAttribute("data-trend-chart"))).toEqual(["failed"]);
  expect([...page.querySelectorAll('[data-slot="section-title"]')].map((title) => title.textContent)).toEqual(["Failed a day"]);
});

test("on a touch screen a day's first tap shows its card and the next opens it", async () => {
  const seen: string[] = [];
  const page = await render(trend(), (day) => { seen.push(day); });
  const column = page.querySelector<SVGElement>('[data-trend-chart="failed"] [data-trend-day="2026-10-30"]')!;
  const tap = async () => act(async () => {
    column.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    column.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await tap();
  expect(seen).toStrictEqual([]);
  expect(page.querySelector('[data-trend-chart="failed"] [data-trend-card]')?.getAttribute("data-trend-card")).toBe("2026-10-30");
  await tap();
  expect(seen).toStrictEqual(["2026-10-30"]);
});

test("each chart is named by its title for a screen reader", async () => {
  const page = await render(trend());
  expect([...page.querySelectorAll("[data-trend-chart] svg")].map((svg) => svg.getAttribute("aria-label")))
    .toEqual(["Spend a day", "TTFT p95 a day", "Failed a day"]);
});
