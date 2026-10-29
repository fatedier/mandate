import { expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { ActivityLedgerDto, ActivitySummaryResponse } from "@shared/api-contracts";
import { OverviewTab } from "@/routes/activity/overview/OverviewTab";
import { cacheClosingLine, cacheSealPauseNote, roleLabel, verdictDescription, wakeLabel, whoList, writeReadLine } from "@/routes/activity/ledger-copy";
import { formatClockMinutes } from "@/lib/format";
import { mountAsync } from "../helpers/mount.js";
import { emptyLedger } from "../helpers/activity-ledger.js";

const DAY_MS = 86_400_000;
const utcDay = (offset: number) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

function summary(ledger: Partial<ActivityLedgerDto>, spend: Partial<ActivitySummaryResponse["spend"]> = {}): ActivitySummaryResponse {
  return {
    days: 7,
    ledger: emptyLedger(ledger),
    spend: { micros: 1_282_000_000, reportedMicros: 0, estimated: true, pricedCalls: 900, unpricedCalls: 0, includedCalls: 0, includedApiMicros: 0, pendingCalls: 0, ...spend },
    daily: [
      { date: utcDay(-1), calls: 400, failed: 3, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1 },
      { date: utcDay(0), calls: 500, failed: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1 }
    ],
    dates: [utcDay(-1), utcDay(0)],
    buckets: [],
    group: "purpose",
    groups: [],
    p50Ms: 0, p95Ms: 0, p99Ms: 0,
    ttft: { calls: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 }
  };
}

/** Invented figures shaped like a real week. */
const LEDGER: Partial<ActivityLedgerDto> = {
  previousSpendMicros: 188_000_000,
  days: [
    { date: utcDay(-1), spendMicros: 600_000_000, expiredExtraMicros: 200_000_000 },
    { date: utcDay(0), spendMicros: 682_000_000, expiredExtraMicros: 265_000_000 }
  ],
  agents: [
    { role: "managers", calls: 3_700, spendMicros: 506_000_000, expiredExtraMicros: 301_000_000, money: "spend" },
    { role: "your_agent", calls: 5_185, spendMicros: 505_000_000, expiredExtraMicros: 163_000_000, money: "spend" },
    { role: "purpose:some_new_purpose", calls: 2, spendMicros: 10_000, expiredExtraMicros: 0, money: "spend" }
  ],
  cache: {
    rows: [
      { kind: "expired", calls: 542, pricedCalls: 542, rewrittenTokens: 96_000_000, extraMicros: 465_000_000, topFamily: null },
      { kind: "not_reused", calls: 450, pricedCalls: 450, rewrittenTokens: 30_000_000, extraMicros: 83_000_000, topFamily: "gpt" },
      { kind: "rebuild", calls: 57, pricedCalls: 57, rewrittenTokens: 1_900_000, extraMicros: 7_000_000, topFamily: null }
    ],
    expiredWithinHour: 504,
    medianExpiredIdleMs: 15 * 60_000,
    wrote1h: false
  },
  tokens: { uncachedInputMicros: 81_000_000, cacheReadMicros: 334_000_000, cacheWriteMicros: 722_000_000, outputMicros: 144_000_000, reportedUnsplitMicros: 0 },
  wakes: [
    { key: "messages", timer: false, runs: 2_024, spendMicros: 674_000_000, expiredExtraMicros: 212_000_000, roles: ["your_agent", "managers", "workers"], money: "spend" },
    { key: "check_ins", timer: true, runs: 86, spendMicros: 71_000_000, expiredExtraMicros: 60_000_000, roles: ["managers"], money: "spend" },
    { key: "watches", timer: false, runs: 336, spendMicros: 63_000_000, expiredExtraMicros: 660_000, roles: ["workers", "managers"], money: "spend" }
  ],
  priceDataDate: "2026-01-02",
  claudeWriteReadRatio: 25
};

async function render(data: ActivitySummaryResponse, entry = "/activity?days=7"): Promise<HTMLElement> {
  const view = await mountAsync(
    <MemoryRouter initialEntries={[entry]}>
      <OverviewTab data={data} loading={false} />
    </MemoryRouter>
  );
  return view.host;
}

const sectionTitles = (page: HTMLElement) =>
  Array.from(page.querySelectorAll('[data-slot="section-title"]')).map((n) => n.textContent);
const section = (page: HTMLElement, title: string) =>
  Array.from(page.querySelectorAll("section")).find((s) => s.querySelector('[data-slot="section-title"]')?.textContent === title)!;

test("the Overview shows the ledger sections in order", async () => {
  const page = await render(summary(LEDGER));
  expect(sectionTitles(page)).toEqual(["Spend", "By agent", "Cache", "What the spend is made of", "What woke the agents"]);
  expect(page.textContent?.includes("How long calls take")).toBe(false);
  expect(page.textContent).toContain("~ marks an estimate at list prices (LiteLLM and models.dev, Jan 2), not a bill.");
});

test("spend detail names the previous period", async () => {
  const page = await render(summary(LEDGER));
  const detail = page.querySelector('[data-slot="activity-total-detail"]')!.textContent!;
  expect(detail.startsWith("~$188.00 the 7 days before")).toBe(true);
});

test("spend per day shows the cache-expired part; the legend names both parts", async () => {
  const page = await render(summary(LEDGER));
  const bars = Array.from(page.querySelectorAll("[data-spend-day]"));
  expect(bars.map((b) => b.getAttribute("data-spend-day"))).toEqual([utcDay(-1), utcDay(0)]);
  // Each day's expired part is its share of that day's spend, not of the tallest day's.
  const expired = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLElement>("[data-spend-expired]")).map((b) => b.style.height);
  expect(expired(page)).toEqual([`${(200 / 600) * 100}%`, `${(265 / 682) * 100}%`]);
  expect(page.textContent).toContain("Cache expired: paid on top of a cache read");
  expect(page.textContent).toContain("Everything else");
  expect(page.querySelector("[data-chart-hit]") === null).toBe(true); // not the calls chart
  // A day whose expired extra is more than it spent fills its bar, no more.
  const over = await render(summary({ ...LEDGER, days: [LEDGER.days![0]!, { date: utcDay(0), spendMicros: 100_000_000, expiredExtraMicros: 150_000_000 }] }));
  expect(expired(over)).toEqual([`${(200 / 600) * 100}%`, "100%"]);
});

test("hovering a day shows its spend, its expired part, calls and failed", async () => {
  const page = await render(summary(LEDGER));
  const first = page.querySelector(`[data-spend-day="${utcDay(-1)}"]`)!;
  await act(async () => { first.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  const card = page.querySelector("[data-spend-card]")!;
  expect(card.textContent).toContain("~$600.00");
  expect(card.textContent).toContain("~$200.00 cache expired");
  expect(card.textContent).toContain("400 calls");
  expect(card.textContent).toContain("3 failed");
});

test("no spend shows calls per day", async () => {
  const page = await render(summary({
    // A price date from the API-price references of included calls: still no estimate to footnote.
    priceDataDate: "2026-01-02",
    agents: [{ role: "managers", calls: 12, spendMicros: 0, expiredExtraMicros: 0, money: "included" }],
    cache: { rows: [{ kind: "expired", calls: 2, pricedCalls: 0, rewrittenTokens: 200_000, extraMicros: 0, topFamily: null }], expiredWithinHour: 2, medianExpiredIdleMs: 600_000, wrote1h: false }
  }, { micros: 0, estimated: false, pricedCalls: 0, includedCalls: 12 }));
  expect(page.querySelector("[data-chart-hit]") === null).toBe(false);
  expect(page.querySelector("[data-spend-day]") === null).toBe(true);
  expect(section(page, "By agent").textContent).toContain("Included");
  // Without spend the cache rows count tokens, and the closing line has no share of spend.
  expect(section(page, "Cache").textContent).toContain("200.0k tokens");
  expect(section(page, "Cache").textContent?.includes("% of spend")).toBe(false);
  expect(sectionTitles(page).includes("What the spend is made of")).toBe(false);
  expect(page.textContent?.includes("marks an estimate")).toBe(false);
});

test("cache rows, descriptions and the closing line", async () => {
  const page = await render(summary(LEDGER));
  const cache = section(page, "Cache").textContent!;
  for (const text of ["Cache expired", "Claude, after more than 5 minutes idle", "Not reused", "models with no fixed cache time; mostly GPT", "Expected rebuild", "after a compaction, or a change of model or connection"]) {
    expect(cache).toContain(text);
  }
  expect(cache.includes("Miss")).toBe(false); // a row with no calls is left out
  expect(cacheClosingLine({ sharePct: 36, medianMinutes: 15, withinHour: 504, expired: 542, wrote1h: false, periodWord: "week" })).toBe(
    "36% of spend. Half of these calls came 15 minutes or less after the one before, and 504 of the 542 within an hour, which a 1-hour cache would have kept. No call this week wrote a 1-hour cache."
  );
  expect(cache).toContain("36% of spend. Half of these calls came 15 minutes or less after the one before");
  expect(cacheClosingLine({ sharePct: null, medianMinutes: 70, withinHour: 0, expired: 3, wrote1h: true, periodWord: "month" })).toBe(
    "Half of these calls came 70 minutes or less after the one before, and 0 of the 3 within an hour, which a 1-hour cache would have kept."
  );
  expect(verdictDescription("not_reused", null)).toBe("models with no fixed cache time");
  expect(verdictDescription("miss", null)).toBe("Claude, within its 5 minutes");
  // Families as their makers write them.
  expect(["deepseek", "glm", "minimax", "o3", "gpt", "kimi"].map((family) => verdictDescription("not_reused", family).replace("models with no fixed cache time; mostly ", "")))
    .toEqual(["DeepSeek", "GLM", "MiniMax", "o3", "GPT", "Kimi"]);
});

test("an empty cache says so", async () => {
  const page = await render(summary({ ...LEDGER, cache: { rows: [], expiredWithinHour: 0, medianExpiredIdleMs: null, wrote1h: false } }));
  expect(section(page, "Cache").textContent).toContain("No call paid for its prompt again.");
});

test("what the spend is made of, with the write/read line", async () => {
  const page = await render(summary(LEDGER));
  const tokens = section(page, "What the spend is made of").textContent!;
  for (const text of ["Cache write", "Cache read", "Output", "Uncached input"]) expect(tokens).toContain(text);
  expect(tokens.includes("Reported, not split")).toBe(false);
  expect(tokens).toContain("56%");
  expect(tokens).toContain("On Claude a cache write costs 25 times a cache read.");
  expect(writeReadLine(12.5)).toBe("On Claude a cache write costs 12.5 times a cache read.");
});

test("who lists keep Your agent capitalised", () => {
  expect(whoList(["your_agent", "managers", "workers"])).toBe("Your agent, managers, workers");
  expect(whoList(["managers", "your_agents_page"])).toBe("Managers, Your agent's page");
});

test("what woke the agents: timers tagged, expired share, small amounts", async () => {
  const page = await render(summary(LEDGER));
  const wakes = section(page, "What woke the agents");
  const rows = Array.from(wakes.querySelectorAll("[data-wake-row]"));
  expect(rows.map((r) => r.getAttribute("data-wake-row"))).toEqual(["messages", "check_ins", "watches"]);
  expect(rows[1]!.textContent).toContain("Check-ins");
  expect(rows[1]!.textContent).toContain("timer");
  expect(rows[0]!.textContent?.includes("timer")).toBe(false);
  expect(rows[0]!.textContent).toContain("Your agent, managers, workers");
  expect(rows[1]!.textContent).toContain("85%");
  expect(rows[2]!.textContent).toContain("under $1");
});

test("unknown roles and wake keys show their key", async () => {
  const page = await render(summary(LEDGER));
  expect(section(page, "By agent").textContent).toContain("some_new_purpose");
  expect(roleLabel("purpose:odd")).toBe("odd");
  expect(roleLabel("deleted_thread")).toBe("Deleted thread");
  expect([roleLabel("manager_stop_check"), wakeLabel("manager_stop_check")]).toEqual(["Manager stop check", "Manager stop check"]);
  expect(roleLabel("memory_repeat_check")).toBe("Memory repeat check");
  expect(wakeLabel("brand-new")).toBe("brand-new");
  expect(wakeLabel("toString")).toBe("toString");
});

test("the folded wake row keeps a label when its rows have no spend", async () => {
  const wakes = ["messages", "worker_reports", "thread_notices", "alarms", "check_ins", "watches", "command_results", "subagent_tasks", "manager_request_check"]
    .map((key) => ({ key, timer: false, runs: 2, spendMicros: 0, expiredExtraMicros: 0, roles: ["managers"], money: "unpriced" as const }));
  const page = await render(summary({ wakes }, { micros: 0, estimated: false, pricedCalls: 0 }));
  const more = page.querySelector('[data-wake-row="more"]')!;
  expect(more.textContent).toContain("2 more");
  expect(more.textContent).toContain("Unpriced");
  expect(more.textContent?.includes("$0")).toBe(false);
});

test("a day's value label stands outside the bars' height", async () => {
  const page = await render(summary(LEDGER));
  const day = page.querySelector(`[data-spend-day="${utcDay(0)}"]`)!;
  const label = day.querySelector("[data-spend-label]")!;
  // Out of the flow: the bars alone share the plotting height.
  expect(label.className.split(/\s+/)).toContain("absolute");
  expect(day.querySelector("[data-spend-bar]")!.getAttribute("style")).toContain("height: 100%");
});

test("Overview links open exactly what they count, whatever the log's filters were", async () => {
  const page = await render(summary(LEDGER), "/activity?days=7&group=model&status=failed&agent=workers&view=slow&purpose=x&q=y");
  // Each link as its page and its query's name=value pairs: the log's tab,
  // the period and grouping kept, what it counts set, every filter gone.
  const opens = (text: string) => {
    const link = Array.from(page.querySelectorAll("a")).find((a) => a.textContent?.includes(text))!;
    const url = new URL(link.getAttribute("href")!, "http://x.example.test");
    return [url.pathname, ...[...url.searchParams].map(([name, value]) => `${name}=${value}`).sort()];
  };
  expect(opens("Managers")).toEqual(["/activity", "agent=managers", "days=7", "group=model", "tab=logs"]);
  expect(opens("Show these calls")).toEqual(["/activity", "days=7", "group=model", "tab=logs", "view=expired"]);
  expect(opens("Open logs")).toEqual(["/activity", "days=7", "group=model", "tab=logs"]);
});

test("a cache row with no priced calls counts tokens, and the closing line gives no share", async () => {
  const page = await render(summary({
    ...LEDGER,
    cache: { rows: [{ kind: "expired", calls: 2, pricedCalls: 0, rewrittenTokens: 200_000, extraMicros: 0, topFamily: null }], expiredWithinHour: 2, medianExpiredIdleMs: 600_000, wrote1h: false }
  }));
  const cache = section(page, "Cache").textContent!;
  expect(cache).toContain("200.0k tokens");
  expect(cache.includes("$0")).toBe(false);
  expect(cache.includes("% of spend")).toBe(false);
});

// The words for a paused cache seal: its model, its next try, and why it paused.
test("a paused cache seal is named with its model, its next try and why it paused", () => {
  const at = new Date(2026, 0, 1, 15, 30).toISOString();
  const morning = new Date(2026, 0, 1, 9, 0).getTime();
  const head = `Cache seal paused for anthropic/claude-sonnet-x until ${formatClockMinutes(at)} — `;
  const note = (failure: "short_write" | "output" | "errors" | "not_read" | "prefix_changed", outputTokens?: number) =>
    cacheSealPauseNote({ model: "anthropic/claude-sonnet-x", failure, nextTryAt: at, ...(outputTokens !== undefined ? { outputTokens } : {}) }, morning);
  expect(roleLabel("cache_seal")).toBe("Cache seal");
  expect(note("short_write")).toBe(`${head}the seal's cache was written for 5 minutes, not 1 hour.`);
  expect(note("not_read")).toBe(`${head}the next step did not read the sealed prompt.`);
  expect(note("prefix_changed")).toBe(`${head}the next step did not read the sealed prompt.`);
  expect(note("output", 120)).toBe(`${head}the seal produced 120 output tokens, not 1.`);
  expect(note("errors")).toBe(`${head}the seal request failed 3 times in a row.`);
});

// A try already due waits for the model's next seal, so no time is named; a
// time on another day names its date.
test("a paused cache seal whose try is due, or on another day, says so", () => {
  const pause = (nextTryAt: string, failure: "short_write" | "errors") => ({ model: "anthropic/claude-sonnet-x", failure, nextTryAt });
  const at = new Date(2026, 0, 1, 15, 30).toISOString();
  expect(cacheSealPauseNote(pause(at, "short_write"), new Date(2026, 0, 1, 18, 0).getTime()))
    .toBe("Cache seal paused for anthropic/claude-sonnet-x, retrying with its next seal — the seal's cache was written for 5 minutes, not 1 hour.");
  // Due at that very time, as the server lets the try through.
  expect(cacheSealPauseNote(pause(at, "short_write"), Date.parse(at))).toContain(", retrying with its next seal — ");
  expect(cacheSealPauseNote(pause(new Date(2026, 0, 2, 15, 30).toISOString(), "errors"), new Date(2026, 0, 1, 9, 0).getTime()))
    .toBe("Cache seal paused for anthropic/claude-sonnet-x until Jan 2, 15:30 — the seal request failed 3 times in a row.");
});

// A pause outlives the window's calls: an empty window still names it.
test("a window with no calls still names a paused model", async () => {
  const pause = { model: "anthropic/claude-sonnet-x", failure: "not_read" as const, nextTryAt: "2026-01-01T15:30:00.000Z" };
  const empty = summary(LEDGER);
  const host = await render({ ...empty, daily: empty.daily.map((d) => ({ ...d, calls: 0 })), cacheSeal: { paused: [pause] } });
  expect(host.textContent).toContain("No LLM calls in this window.");
  expect([...host.querySelectorAll("[data-slot=cache-seal-paused]")].map((el) => el.textContent)).toEqual([cacheSealPauseNote(pause)]);
});

test("the Cache section shows one line per paused model", async () => {
  const pauses = [
    { model: "anthropic/claude-sonnet-x", failure: "short_write" as const, nextTryAt: "2026-01-01T15:30:00.000Z" },
    { model: "anthropic/claude-opus-x", failure: "errors" as const, nextTryAt: "2026-01-01T16:30:00.000Z" }
  ];
  const host = await render({ ...summary(LEDGER), cacheSeal: { paused: pauses } });
  const lines = [...host.querySelectorAll("[data-slot=cache-seal-paused]")].map((el) => el.textContent);
  expect(lines).toEqual(pauses.map((p) => cacheSealPauseNote(p)));
  const none = await render({ ...summary(LEDGER), cacheSeal: { paused: [] } });
  expect(none.querySelectorAll("[data-slot=cache-seal-paused]")).toHaveLength(0);
});
