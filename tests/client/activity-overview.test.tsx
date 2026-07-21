import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ActivityDailyDto,
  ActivityGroupDto,
  ActivityGroupKey,
  ActivitySummaryResponse
} from "@shared/api-contracts";
import { OverviewTab } from "@/routes/activity/overview/OverviewTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The figures row and the chart's input — the two places the Overview can be
 * wrong while still rendering a full, plausible page.
 *
 * happy-dom performs no layout, so nothing here reads a box. Everything is a
 * text run or an element count.
 */

const DAY_MS = 86_400_000;

/** Dates relative to today, because `OverviewTab` fills the gap up to the real
 *  clock: a fixture with fixed dates would grow a bar a day. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
}

function day(date: string, fields: Partial<ActivityDailyDto>): ActivityDailyDto {
  return {
    date,
    calls: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    ...fields
  };
}

/** The window cut by purpose — the one cut this tab shows. Two rows, so an
 *  order the table imposed of its own would read differently from the order the
 *  endpoint answered in. */
const PURPOSE_GROUPS: ActivityGroupDto[] = [
  {
    key: "agent_wake_step",
    label: "agent_wake_step",
    calls: 170,
    failed: 4,
    p50Ms: 900,
    p95Ms: 4200,
    p99Ms: 12_000,
    maxMs: 30_000,
    inputTokens: 9000,
    outputTokens: 900,
    cacheReadTokens: 8100,
    fallbackCalls: 0,
    reasons: [{ reason: "Not Found", calls: 4 }]
  },
  {
    key: "memory_dream",
    label: "memory_dream",
    calls: 10,
    failed: 0,
    p50Ms: 700,
    p95Ms: 3000,
    p99Ms: 8000,
    maxMs: 9000,
    inputTokens: 1000,
    outputTokens: 300,
    cacheReadTokens: 900,
    fallbackCalls: 0,
    reasons: []
  }
];

/**
 * Shaped the way the provider reports it: `inputTokens` is the whole prompt and
 * `cacheReadTokens` is the part of it that was cached, nine tenths here. Calls
 * outnumber failures forty-five to one, so every figure in the row is a
 * different number from every other — a pairing that slips renders a real
 * percentage against the wrong words rather than something obviously broken.
 */
const SUMMARY: ActivitySummaryResponse = {
  days: 30,
  daily: [
    day(utcDay(-3), {
      calls: 120,
      failed: 4,
      inputTokens: 9000,
      outputTokens: 900,
      cacheReadTokens: 8100,
      // Unlike the window's 900ms / 4.2s below: a card that read the summary
      // instead of the day it is pointing at would show those.
      p50Ms: 1500,
      p95Ms: 7000
    }),
    day(utcDay(0), {
      calls: 60,
      failed: 0,
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadTokens: 900
    })
  ],
  buckets: [
    { bucket: "<1s", calls: 90 },
    { bucket: "1-5s", calls: 60 },
    { bucket: "5-15s", calls: 20 },
    { bucket: "15-60s", calls: 8 },
    { bucket: ">60s", calls: 2 }
  ],
  group: "purpose",
  groups: PURPOSE_GROUPS,
  p50Ms: 900,
  p95Ms: 4200,
  p99Ms: 12_000,
  // Fewer calls than the window holds, and figures well clear of the latency
  // ones: the column is newer than the window, so the two sets never describe
  // the same population and a panel that read one for the other should show it.
  ttft: { calls: 140, p50Ms: 320, p95Ms: 980, p99Ms: 2100 }
};

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderOverview(data: ActivitySummaryResponse): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<OverviewTab data={data} loading={false} onSelectPattern={() => {}} />);
  });
  return container;
}

async function rerender(data: ActivitySummaryResponse): Promise<void> {
  await act(async () => {
    root?.render(<OverviewTab data={data} loading={false} onSelectPattern={() => {}} />);
  });
}

/** Each headline figure as the pair the reader sees: the number, and the words
 *  underneath it. Read as pairs rather than as two lists so a value that moved
 *  to a neighbouring label cannot pass. */
function figures(page: HTMLElement): Array<[string, string]> {
  const row = page.querySelector("section")?.firstElementChild;
  return Array.from(row?.children ?? []).map((cell): [string, string] => [
    cell.firstElementChild?.textContent ?? "",
    cell.lastElementChild?.textContent ?? ""
  ]);
}

/** Whether the failure figure is rendering in its alert tone, found by its own
 *  label rather than by position so a reordered row cannot silently move the
 *  assertion onto a different number. */
function failureIsAlarmed(page: HTMLElement): boolean {
  const row = page.querySelector("section")?.firstElementChild;
  const cell = Array.from(row?.children ?? []).find(
    (node) => node.lastElementChild?.textContent?.startsWith("failed") ?? false
  );
  return cell?.firstElementChild?.className.includes("text-destructive") ?? false;
}

function inputTokens(page: HTMLElement): string | undefined {
  return figures(page).find(([, label]) => label === "input tokens")?.[0];
}

test("each headline figure carries the label it was computed for", async () => {
  const page = await renderOverview(SUMMARY);
  // 9,000 of the 10,000 tokens read came from cache. Transposed, the same call
  // answers a believable 10% — which is why this pair is spelled out rather
  // than merely checked for a "%".
  expect(figures(page)).toEqual([
    ["180", "calls · 30 days"],
    ["2.2%", "failed · 4"],
    // A 10,000-token prompt across the window. Beside it, 90% of it cached — the
    // two figures now describe the same quantity, which is the point of the
    // pairing. Output (1.2k) is a different number entirely and would read as
    // a contradiction next to the share.
    ["10.0k", "input tokens"],
    ["90%", "cache hit rate"]
  ]);
});

test("a window that read nothing from cache reports no share rather than zero", async () => {
  // Nothing recorded on either side of the prompt, so the share has no
  // denominator and says so.
  const page = await renderOverview({
    ...SUMMARY,
    daily: [day(utcDay(0), { calls: 3, failed: 0, outputTokens: 40 })]
  });
  expect(figures(page)).toEqual([
    ["3", "calls · 30 days"],
    ["0.0%", "failed · 0"],
    ["0", "input tokens"],
    ["—", "cache hit rate"]
  ]);

  // A prompt that was read fresh every time is a different answer: zero per
  // cent is a measurement, and the calls behind it are the expensive ones.
  await rerender({
    ...SUMMARY,
    daily: [day(utcDay(0), { calls: 3, failed: 0, inputTokens: 5_000, outputTokens: 40 })]
  });
  expect(figures(page)[2]).toEqual(["5.0k", "input tokens"]);
  expect(figures(page)[3]).toEqual(["0%", "cache hit rate"]);
});

test("token counts switch unit at a thousand, a million and a billion", async () => {
  const withInput = (inputTokens: number): ActivitySummaryResponse => ({
    ...SUMMARY,
    daily: [day(utcDay(0), { calls: 1, failed: 0, inputTokens, outputTokens: 1 })]
  });

  const page = await renderOverview(withInput(999));
  expect(inputTokens(page)).toBe("999");

  // The thousands branch runs all the way to the million, so the last figure
  // before the switch is four digits of thousands, not a rounded "1.0M".
  const steps: Array<[number, string]> = [
    [1_000, "1.0k"],
    [12_345, "12.3k"],
    [999_999, "1000.0k"],
    [1_000_000, "1.0M"],
    [2_500_000, "2.5M"],
    // A 30-day window on the real store carries 6.5B input tokens. Without
    // this tier that reads as "6530.3M", which is a number nobody parses.
    [999_999_999, "1000.0M"],
    [1_000_000_000, "1.0B"],
    [6_530_300_000, "6.5B"]
  ];
  for (const [tokens, expected] of steps) {
    await rerender(withInput(tokens));
    expect(inputTokens(page)).toBe(expected);
  }
});

test("the chart is given every day in the run, not only the days with calls", async () => {
  const page = await renderOverview(SUMMARY);
  // The daily query groups by date, so a silent day has no row. Handed the raw
  // rows the chart draws two bars three days apart and reads as an axis of
  // consecutive days.
  const dates = Array.from(page.querySelectorAll("[data-chart-hit]"))
    .map((node) => node.getAttribute("data-chart-hit"));
  expect(dates).toEqual([utcDay(-3), utcDay(-2), utcDay(-1), utcDay(0)]);
});

/** The tooltip's label/value pairs, read as pairs so a value cannot pass under
 *  the wrong name. Null when no column is hovered. */
function tooltip(page: HTMLElement): Array<[string, string]> | null {
  const card = page.querySelector("[data-chart-tooltip]");
  if (!card) return null;
  return Array.from(card.querySelectorAll("dl > div")).map((row): [string, string] => [
    row.firstElementChild?.textContent ?? "",
    row.lastElementChild?.textContent ?? ""
  ]);
}

test("the dates under the chart run oldest on the left", async () => {
  const page = await renderOverview(SUMMARY);
  const axis = page.querySelector("[data-chart-hit]")!.closest("div")!.parentElement!
    .querySelector("div.flex.justify-between")!;
  expect(Array.from(axis.children).map((node) => node.textContent)).toEqual([
    utcDay(-3),
    utcDay(0)
  ]);
});

test("nothing is hovered until a column is", async () => {
  const page = await renderOverview(SUMMARY);
  expect(tooltip(page)).toBeNull();
});

test("the tooltip carries the day's own figures, each under its own name", async () => {
  const page = await renderOverview(SUMMARY);
  // The busiest day in the fixture and the only one with failures. Its
  // percentiles and tokens differ from the window's, so a card wired to the
  // summary instead of the day reads as different numbers.
  const target = page.querySelector(`[data-chart-hit="${utcDay(-3)}"]`)!;
  await act(async () => {
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });

  // Calls and failures share the headline line; the list below is the same
  // five rows on every day, so nothing shifts as the pointer moves.
  expect(page.querySelector("[data-chart-tooltip]")?.textContent).toContain("120");
  expect(page.querySelector("[data-chart-tooltip]")?.textContent).toContain("4 failed");
  expect(tooltip(page)).toEqual([
    ["p50", "1.5s"],
    ["p95", "7.0s"],
    // Fresh 900 plus 8,100 cached: the prompt is what "cache hit rate" is a share
    // of, and it dwarfs the 900 that came back.
    ["input tokens", "9.0k"],
    ["output tokens", "900"],
    ["cache hit rate", "90%"]
  ]);

  await act(async () => {
    target.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  });
  expect(tooltip(page)).toBeNull();
});

test("a quiet day says nothing about failures, and its rows do not move", async () => {
  const page = await renderOverview(SUMMARY);
  await act(async () => {
    page.querySelector(`[data-chart-hit="${utcDay(0)}"]`)!
      .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  // No "0 failed" — a zero on every quiet day makes the days that did fail
  // harder to spot. And the same five rows as the busy day, in the same
  // order, so moving between columns compares fixed positions.
  expect(page.querySelector("[data-chart-tooltip]")?.textContent).not.toContain("failed");
  expect(tooltip(page)?.map(([label]) => label)).toEqual([
    "p50", "p95", "input tokens", "output tokens", "cache hit rate"
  ]);
});

test("the tooltip stays inside the card at both ends of the window", async () => {
  const page = await renderOverview(SUMMARY);
  const at = async (date: string) => {
    await act(async () => {
      page.querySelector(`[data-chart-hit="${date}"]`)!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    return (page.querySelector("[data-chart-tooltip]") as HTMLElement).style;
  };
  // Anchored from the left while the column is in the first half, and from the
  // right after that — a card that always opened rightwards would run off the
  // plot on the last week of the window.
  const first = await at(utcDay(-3));
  expect([Boolean(first.left), Boolean(first.right)]).toEqual([true, false]);
  const last = await at(utcDay(0));
  expect([Boolean(last.left), Boolean(last.right)]).toEqual([false, true]);
});

test("every day gets a full-height target, including the ones with no bar", async () => {
  const page = await renderOverview(SUMMARY);
  const hits = Array.from(page.querySelectorAll("[data-chart-hit]"));
  // One per column, and all the same height: a target sized to its bar would
  // leave a quiet day two pixels tall against a busy peak, which is exactly
  // the day worth asking about.
  expect(hits.length).toBe(4);
  expect([...new Set(hits.map((node) => node.getAttribute("height")))]).toEqual(["100"]);
  expect([...new Set(hits.map((node) => node.getAttribute("y")))]).toEqual(["0"]);
});

test("the failure rate turns alarming at five percent and not before", async () => {
  // Retries make a low failure rate ordinary, so the threshold is what stops
  // the figure being red forever. Four of a hundred and five of a hundred sit
  // either side of it, and the second is exactly on it — which pins the
  // comparison as well as the number, since `> 5` would leave it calm.
  const at = (calls: number, failed: number): ActivitySummaryResponse => ({
    ...SUMMARY,
    daily: [day(utcDay(0), { calls, failed, inputTokens: 10, outputTokens: 10 })]
  });

  const page = await renderOverview(at(100, 4));
  expect(figures(page)[1]).toEqual(["4.0%", "failed · 4"]);
  expect(failureIsAlarmed(page)).toBe(false);

  await rerender(at(100, 5));
  expect(figures(page)[1]).toEqual(["5.0%", "failed · 5"]);
  expect(failureIsAlarmed(page)).toBe(true);
});

/** The first-token block, read as the pairs a reader sees rather than as a
 *  blob: the heading names a percentile, and the line under it names another. */
function firstTokenBlock(page: HTMLElement): string[] | null {
  // The label is a bare text node, not an element, so the block is found by
  // what it says and then read as [label, headline, detail].
  const panel = [...page.querySelectorAll("div")].find(
    (node) => node.textContent?.startsWith("TTFT p50") ?? false
  );
  if (!panel) return null;
  return [
    panel.firstChild?.textContent ?? "",
    ...[...panel.children].map((node) => node.textContent ?? "")
  ];
}

test("the TTFT figures say which percentile each of them is", async () => {
  const page = await renderOverview(SUMMARY);
  // 320ms p50 and 980ms p95 against latencies of 900ms and 4.2s: every number
  // here is distinct from every latency number, so a block wired to the wrong
  // field reads as a different figure rather than as a coincidence.
  expect(firstTokenBlock(page)).toEqual(["TTFT p50", "320ms", "140 calls · p95 980ms"]);
});

test("a window where nothing timed a first token shows no TTFT figures", async () => {
  const page = await renderOverview({ ...SUMMARY, ttft: { calls: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 } });
  // Not a dash, not a zero — absent. The column is younger than the window, so
  // early on this is the normal state, and an empty reading dressed as a
  // measurement is worse than no row.
  expect(firstTokenBlock(page)).toBeNull();
  // The latency percentiles are a different population and still have theirs.
  expect(page.textContent).toContain("p95");
});

test("the overview's table is the breakdown's, pinned to purpose", async () => {
  const page = await renderOverview({ ...SUMMARY, group: "purpose" });
  // Same component, so the same columns — this is what stops the two surfaces
  // describing the same window differently.
  expect([...page.querySelectorAll("th")].map((n) => n.textContent)).toEqual([
    "Purpose", "Calls", "p50", "p95", "p99", "max",
    "Failed", "Fallback", "Input", "Cache", "Output"
  ]);
});

test("the overview shows no table when the summary is grouped by something else", async () => {
  // The page holds one summary. Rendering a model breakdown under a "purpose"
  // heading would be worse than rendering nothing.
  const page = await renderOverview({ ...SUMMARY, group: "model" });
  expect(page.querySelectorAll("table").length).toBe(0);
});

test("whatever table the overview shows is the purpose cut", async () => {
  // The guard and the heading are one claim, and neither half is evidence about
  // the other: a table that survived a different grouping would be drawing that
  // grouping's rows, and the heading is the only thing on the page that would
  // say so. Read together over every dimension the endpoint can answer with.
  const groups: ActivityGroupKey[] = ["model", "purpose", "scopeType", "day", "fallback"];
  const page = await renderOverview(SUMMARY);
  for (const group of groups) {
    await rerender({ ...SUMMARY, group });
    expect(page.querySelector("th")?.textContent ?? null).toBe(
      group === "purpose" ? "Purpose" : null
    );
  }
});

