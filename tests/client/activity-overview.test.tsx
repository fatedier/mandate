import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type {
  ActivityDailyDto,
  ActivityGroupDto,
  ActivitySummaryResponse
} from "@shared/api-contracts";
import { OverviewTab } from "@/routes/activity/overview/OverviewTab";
import { BreakdownTab } from "@/routes/activity/BreakdownTab";
import { formatCalendarDay } from "@/lib/format";
import { mountAsync, type Mounted } from "../helpers/mount.js";
import { emptyLedger } from "../helpers/activity-ledger.js";

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
    reasons: [{ reason: "Not Found", calls: 4 }],
    spendMicros: 0,
    spendEstimated: false,
    unpricedCalls: 0
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
    reasons: [],
    spendMicros: 0,
    spendEstimated: false,
    unpricedCalls: 0
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
  ledger: emptyLedger(),
  spend: { micros: 0, reportedMicros: 0, estimated: false, pricedCalls: 0, unpricedCalls: 0, includedCalls: 0, includedApiMicros: 0, pendingCalls: 0 },
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
  dates: [utcDay(-3), utcDay(-2), utcDay(-1), utcDay(0)],
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

let view: Mounted | null = null;

async function renderOverview(data: ActivitySummaryResponse): Promise<HTMLElement> {
  view = await mountAsync(
    <MemoryRouter>
      <OverviewTab data={data} loading={false} />
    </MemoryRouter>
  );
  return view.host;
}

function rerender(data: ActivitySummaryResponse): void {
  view?.rerender(
    <MemoryRouter>
      <OverviewTab data={data} loading={false} />
    </MemoryRouter>
  );
}

/** The headline figures in the row over the chart, in reading order. */
function totalsOf(page: HTMLElement): Element[] {
  const row = page.querySelector('[data-slot="section-panel"]')?.firstElementChild;
  return Array.from(row?.querySelectorAll('[data-slot="activity-total"]') ?? []);
}

/** Each headline figure as the pair the reader sees: the number, and the words
 *  underneath it. Read as pairs rather than as two lists so a value that moved
 *  to a neighbouring label cannot pass. */
function figures(page: HTMLElement): Array<[string, string]> {
  return totalsOf(page).map((cell): [string, string] => [
    cell.firstElementChild?.textContent ?? "",
    cell.lastElementChild?.textContent ?? ""
  ]);
}

/** Whether the failure figure is rendering in its alert tone, found by its own
 *  label rather than by position so a reordered row cannot silently move the
 *  assertion onto a different number. */
function failureIsAlarmed(page: HTMLElement): boolean {
  const cell = totalsOf(page).find(
    (node) => node.lastElementChild?.textContent?.startsWith("failed") ?? false
  );
  return cell?.firstElementChild?.className.includes("text-destructive") ?? false;
}

test("each headline figure carries the label it was computed for", async () => {
  const page = await renderOverview(SUMMARY);
  // 9,000 of the 10,000 tokens read came from cache. Transposed, the same call
  // answers a believable 10% — which is why this pair is spelled out rather
  // than merely checked for a "%".
  expect(figures(page)).toEqual([
    // Spend leads; this window's calls were never priced, so nothing is spent.
    ["$0.0000", "spend"],
    ["180", "calls"],
    ["2.2%", "failed · 4"],
    // A 10,000-token prompt across the window. Beside it, 90% of it cached — the
    // two figures now describe the same quantity, which is the point of the
    // pairing. Output (1.2k) is a different number entirely and would read as
    // a contradiction next to the share.
    ["10.0k", "input tokens"],
    ["90%", "cache hit rate"]
  ]);
});

test("a window where no call has an amount yet says Unpriced, not $0", async () => {
  const page = await renderOverview({ ...SUMMARY, spend: { ...SUMMARY.spend, unpricedCalls: 180 } });
  expect(figures(page)[0]).toEqual(["Unpriced", "180 calls unpriced"]);
});

test("a window that read nothing from cache reports no share rather than zero", async () => {
  // Nothing recorded on either side of the prompt, so the share has no
  // denominator and says so.
  const page = await renderOverview({
    ...SUMMARY,
    daily: [day(utcDay(0), { calls: 3, failed: 0, outputTokens: 40 })]
  });
  expect(figures(page)).toEqual([
    // Spend leads; this window's calls were never priced, so nothing is spent.
    ["$0.0000", "spend"],
    ["3", "calls"],
    ["0.0%", "failed · 0"],
    ["0", "input tokens"],
    ["—", "cache hit rate"]
  ]);

  // A prompt that was read fresh every time is a different answer: zero per
  // cent is a measurement, and the calls behind it are the expensive ones.
  rerender({
    ...SUMMARY,
    daily: [day(utcDay(0), { calls: 3, failed: 0, inputTokens: 5_000, outputTokens: 40 })]
  });
  expect(figures(page)[3]).toEqual(["5.0k", "input tokens"]);
  expect(figures(page)[4]).toEqual(["0%", "cache hit rate"]);
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
    formatCalendarDay(utcDay(-3)),
    formatCalendarDay(utcDay(0))
  ]);
});

// Dates read the way the rest of the app writes them, not as the
// ISO keys the rows are grouped by, and in the body font.
test("the window's dates read as dates: the header's range, the chart's ends, a day's card", async () => {
  const page = await renderOverview(SUMMARY);
  const asDate = /^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/;
  const range = [...page.querySelectorAll("span")].find((node) => node.textContent?.includes(" → "))!;
  expect(range.textContent).toBe(`${formatCalendarDay(utcDay(-3))} → ${formatCalendarDay(utcDay(0))}`);
  for (const end of range.textContent!.split(" → ")) expect(end).toMatch(asDate);
  expect(range.className.split(/\s+/)).not.toContain("font-mono");
  const axis = page.querySelector("[data-chart-hit]")!.closest("div")!.parentElement!.querySelector("div.flex.justify-between")!;
  for (const end of axis.children) expect(end.textContent).toMatch(asDate);
  await act(async () => {
    page.querySelector(`[data-chart-hit="${utcDay(-3)}"]`)!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(page.querySelector("[data-chart-tooltip]")!.firstElementChild!.textContent).toBe(formatCalendarDay(utcDay(-3)));
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
  expect(figures(page)[2]).toEqual(["4.0%", "failed · 4"]);
  expect(failureIsAlarmed(page)).toBe(false);

  rerender(at(100, 5));
  expect(figures(page)[2]).toEqual(["5.0%", "failed · 5"]);
  expect(failureIsAlarmed(page)).toBe(true);
});

/** The latency section's header line, where the percentile strip lives:
 *  p50 · p95 · p99 and, when the window measured one, TTFT p50. */
/** How long calls take lives on the Breakdown tab, above its table. */
async function renderBreakdown(data: ActivitySummaryResponse): Promise<HTMLElement> {
  view = await mountAsync(
    <MemoryRouter>
      <BreakdownTab data={data} loading={false} group={data.group} onSelectGroup={() => {}} onSelectRow={() => {}} />
    </MemoryRouter>
  );
  return view.host;
}

function latencyStrip(page: HTMLElement): string {
  return page.querySelectorAll('[data-slot="section-header"]')[0]?.textContent ?? "";
}

test("the TTFT figure says which percentile it is", async () => {
  const page = await renderBreakdown(SUMMARY);
  // 320ms against latencies of 900ms / 4.2s / 12s: every number here is
  // distinct from every latency number, so a strip wired to the wrong field
  // reads as a different figure rather than as a coincidence.
  expect(latencyStrip(page)).toContain("p50 900ms · p95 4.2s · p99 12s · TTFT p50 320ms");
});

test("a window where nothing timed a first token shows no TTFT figures", async () => {
  const page = await renderBreakdown({ ...SUMMARY, ttft: { calls: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 } });
  // Not a dash, not a zero — absent. The column is younger than the window, so
  // early on this is the normal state, and an empty reading dressed as a
  // measurement is worse than no figure.
  expect(latencyStrip(page).includes("TTFT")).toBe(false);
  // The latency percentiles are a different population and still have theirs.
  expect(latencyStrip(page)).toContain("p50 900ms · p95 4.2s · p99 12s");
});

test("the Overview opens on spend; how long calls take is on Breakdown, on the list language", async () => {
  const titles = (page: HTMLElement) => Array.from(page.querySelectorAll('[data-slot="section-header"]')).map(
    (h) => h.querySelector('[data-slot="section-title"]')!.textContent
  );
  // A section with no rows is left out (Cache says so instead); with rows, all of them in order.
  const bare = await renderOverview({ ...SUMMARY, group: "purpose" });
  expect(titles(bare)).toEqual(["Spend", "Cache"]);
  view?.unmount();
  const overview = await renderOverview({
    ...SUMMARY,
    ledger: emptyLedger({
      agents: [{ role: "managers", calls: 3, spendMicros: 0, expiredExtraMicros: 0, money: "unpriced" }],
      wakes: [{ key: "messages", timer: false, runs: 1, spendMicros: 0, expiredExtraMicros: 0, roles: ["managers"], money: "unpriced" }]
    })
  });
  expect(titles(overview)).toEqual(["Spend", "By agent", "Cache", "What woke the agents"]);
  expect(overview.querySelector("[data-latency-bucket]") === null).toBe(true);
  expect(overview.querySelector("th") === null).toBe(true);
  view?.unmount();
  const page = await renderBreakdown({ ...SUMMARY, group: "purpose" });
  expect(titles(page)).toEqual(["How long calls take", "Group by"]);
  expect(page.innerHTML.includes("bg-card")).toBe(false);
  const latencyHeader = page.querySelectorAll('[data-slot="section-header"]')[0]!;
  expect(latencyHeader.textContent).toContain("p50");
  expect(latencyHeader.textContent).toContain("TTFT");
  const marker = page.querySelector("[data-latency-bucket] .pill")!;
  expect(marker === null).toBe(false);
  expect(marker.className.split(/\s+/)).toContain("pill-neutral");
  // Every row carries the same fixed-width marker slot, pinned or not, so the
  // flex-1 track is the same width on every row and bar widths (a share of
  // the track) stay comparable down the column.
  const rows = [...page.querySelectorAll("[data-latency-bucket]")];
  expect(rows.length).toBe(5);
  for (const row of rows) {
    expect(row.className.split(/\s+/)).toContain("min-h-10");
    const slots = row.querySelectorAll('[data-slot="latency-markers"]');
    expect(slots.length).toBe(1);
    const slot = slots[0]!.className.split(/\s+/);
    expect(slot).toContain("w-32");
    expect(slot).toContain("@max-[34rem]:w-auto");
    expect(slot).toContain("shrink-0");
    const track = row.querySelector('[data-slot="latency-track"]')!;
    expect(track === null).toBe(false);
    const trackClass = track.className.split(/\s+/);
    expect(trackClass).toContain("flex-1");
    expect(trackClass).toContain("bg-sel");
    expect(track.firstElementChild!.className.split(/\s+/)).toContain("bg-faint");
  }
});

test("the marker slot budgets for all three percentiles sharing one bucket", async () => {
  // A fast window puts p50, p95 and p99 all under a second. Nothing in the
  // pinning excludes that, so the fixed slot has to hold three pills — two
  // fit in 4.5rem, three overran the count column.
  const page = await renderBreakdown({ ...SUMMARY, p50Ms: 200, p95Ms: 500, p99Ms: 900 });
  const fastest = page.querySelector('[data-latency-bucket="<1s"]')!;
  const slot = fastest.querySelector('[data-slot="latency-markers"]')!;
  expect([...slot.children].map((pill) => pill.textContent)).toEqual(["p50", "p95", "p99"]);
  expect([...slot.children].every((pill) => pill.className.split(/\s+/).includes("pill"))).toBe(true);
  expect(slot.className.split(/\s+/)).toContain("w-32");
  expect(slot.className.split(/\s+/)).toContain("@max-[34rem]:w-auto");
});

test("the percentile strip in the latency header hides on a phone; the panel keeps the numbers", async () => {
  const page = await renderBreakdown(SUMMARY);
  const latencyHeader = page.querySelectorAll('[data-slot="section-header"]')[0]!;
  const strip = Array.from(latencyHeader.querySelectorAll("span")).find((s) => s.textContent?.includes("p50"))!;
  expect(strip === undefined).toBe(false);
  expect(strip.className.split(/\s+/)).toContain("@max-[34rem]:hidden");
});
