import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router";
import type { ActivityAgentRowDto, ActivitySummaryResponse } from "@shared/api-contracts";
import { ActivityPage } from "@/routes/activity/ActivityPage";
import { activitySummaryCache } from "@/routes/activity/useActivitySummary";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { emptyLedger } from "../helpers/activity-ledger.js";

// Picking one day on the Overview: its bar is the picked one, the figures and
// the sections below are that day's, and the chip steps and clears it.

const D1 = "2026-10-23";
const D2 = "2026-10-24";
const D3 = "2026-10-25";

const spend = (micros: number, priced: number): ActivitySummaryResponse["spend"] => ({
  micros, reportedMicros: 0, estimated: true, pricedCalls: priced, unpricedCalls: 0, includedCalls: 0, includedApiMicros: 0, pendingCalls: 0
});
const row = (date: string, calls: number) => ({
  date, calls, failed: 0, inputTokens: 1000 * calls, outputTokens: 10, cacheReadTokens: 500 * calls, p50Ms: 1, p95Ms: 1, p99Ms: 1
});
const managers = (calls: number, micros: number): ActivityAgentRowDto => ({ role: "managers", calls, spendMicros: micros, expiredExtraMicros: 0, money: "spend" });

const WINDOW: ActivitySummaryResponse = {
  days: 30,
  day: null,
  ledger: emptyLedger({
    previousSpendMicros: 9_000_000,
    days: [D1, D2, D3].map((date, i) => ({ date, spendMicros: (i + 1) * 1_000_000, expiredExtraMicros: 0 })),
    agents: [managers(60, 6_000_000)]
  }),
  spend: spend(6_000_000, 60),
  daily: [row(D1, 10), row(D2, 20), row(D3, 30)],
  dates: [D1, D2, D3],
  buckets: [],
  group: "purpose",
  groups: [],
  p50Ms: 0, p95Ms: 0, p99Ms: 0,
  ttft: { calls: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 }
};

/** A picked day's answer: its own figures, and the day before's spend. */
function dayAnswer(date: string, calls: number, micros: number, previous: number): ActivitySummaryResponse {
  return {
    ...WINDOW,
    day: date,
    daily: [row(date, calls)],
    dates: [date],
    spend: spend(micros, calls),
    ledger: emptyLedger({
      previousSpendMicros: previous,
      days: [{ date, spendMicros: micros, expiredExtraMicros: 0 }],
      agents: [managers(calls, micros)],
      cache: {
        rows: [{ kind: "expired", calls: 3, pricedCalls: 3, rewrittenTokens: 300_000, extraMicros: 500_000, topFamily: null }],
        expiredWithinHour: 2, medianExpiredIdleMs: 600_000, wrote1h: false
      }
    })
  };
}
const DAYS: Record<string, ActivitySummaryResponse> = {
  [D1]: dayAnswer(D1, 10, 1_000_000, 500_000),
  [D2]: dayAnswer(D2, 20, 2_000_000, 1_000_000),
  [D3]: dayAnswer(D3, 30, 3_000_000, 2_000_000)
};

let search = "";
let asked: URLSearchParams[] = [];
/** Day answers held back until a test lets them through. */
let holdDays = false;
/** Day answers that fail. */
let failDays = false;
/** Window answers held back for these window lengths. */
const holdWindows = new Set<number>();
const held: Array<() => void> = [];

function LocationProbe() {
  search = useLocation().search;
  return null;
}

afterEach(() => {
  runCleanups();
  activitySummaryCache.clear();
  asked = [];
  holdDays = false;
  failDays = false;
  holdWindows.clear();
  held.length = 0;
});

async function renderPage(entry = "/activity", window: ActivitySummaryResponse = WINDOW): Promise<HTMLElement> {
  mockFetch(({ url }) => {
    if (!url.includes("/api/activity/summary")) return jsonResponse(url.includes("/api/activity/calls") ? { calls: [] } : { ok: true });
    const query = new URL(url, "http://x").searchParams;
    asked.push(query);
    const day = query.get("day");
    // Each answer is for the window it was asked for.
    const days = Number(query.get("days"));
    if (!day && holdWindows.has(days)) return new Promise<Response>((resolve) => held.push(() => resolve(jsonResponse({ ...window, days }))));
    if (!day) return jsonResponse({ ...window, days });
    if (failDays) return jsonResponse({ error: "database is locked" }, 500);
    if (!holdDays) return jsonResponse({ ...DAYS[day], days });
    return new Promise<Response>((resolve) => held.push(() => resolve(jsonResponse({ ...DAYS[day], days }))));
  });
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={[entry]}>
      <LocationProbe />
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <ActivityPage />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  return host;
}

const bar = (page: HTMLElement, date: string) => page.querySelector<HTMLElement>(`[data-spend-day="${date}"]`)!;
const chip = (page: HTMLElement) => page.querySelector<HTMLElement>('[data-slot="activity-day-chip"]');
const button = (page: HTMLElement, label: string) => page.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const spendFigure = (page: HTMLElement) => page.querySelector('[data-slot="activity-total"]')!.firstElementChild!.textContent;
const spendDetail = (page: HTMLElement) => page.querySelector('[data-slot="activity-total-detail"]')?.textContent ?? "";
const meta = (page: HTMLElement) => page.querySelector('[data-slot="section-meta"]')!.textContent;
const pickedDay = () => new URLSearchParams(search).get("day");

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

test("a bar picks its day: the figures, the comparison and the sections are that day's", async () => {
  const page = await renderPage();
  expect(spendFigure(page)).toBe("~$6.00");
  expect(chip(page)).toBe(null);

  await click(bar(page, D2));
  expect(pickedDay()).toBe(D2);
  expect(asked.at(-1)?.get("day")).toBe(D2);
  expect(asked.at(-1)?.get("tz")).toBeTruthy();
  expect(bar(page, D2).getAttribute("aria-pressed")).toBe("true");
  expect(bar(page, D1).getAttribute("aria-pressed")).toBe("false");
  expect(chip(page)?.textContent).toContain("Oct 24");
  expect(meta(page)).toBe("one day of the last 30 days");
  expect(spendFigure(page)).toBe("~$2.00");
  expect(spendDetail(page)).toContain("~$1.00 the day before");
  // By agent is the day's too, not the window's.
  const byAgent = [...page.querySelectorAll('[data-slot="section-title"]')].find((n) => n.textContent === "By agent")!.closest("section")!;
  expect(byAgent.textContent).toContain("~$2.00");
  expect(byAgent.textContent).not.toContain("~$6.00");
  expect([...page.querySelectorAll('[data-slot="activity-total"]')].map((n) => n.firstElementChild!.textContent)[1]).toBe("20");
});

test("the picked bar again, or the chip's cross, goes back to the whole window", async () => {
  const page = await renderPage();
  await click(bar(page, D2));
  await click(bar(page, D2));
  expect(pickedDay()).toBe(null);
  expect(chip(page)).toBe(null);
  expect(spendFigure(page)).toBe("~$6.00");

  await click(bar(page, D3));
  await click(button(page, "Show all 30 days"));
  expect(pickedDay()).toBe(null);
  expect(meta(page)).toBe("last 30 days");
  expect(spendFigure(page)).toBe("~$6.00");
});

test("the chip's arrows step a day at a time, and stop at the window's ends", async () => {
  const page = await renderPage(`/activity?day=${D2}`);
  expect(spendFigure(page)).toBe("~$2.00");
  await click(button(page, "Previous day"));
  expect(pickedDay()).toBe(D1);
  expect(spendFigure(page)).toBe("~$1.00");
  expect(button(page, "Previous day").disabled).toBe(true);
  expect(button(page, "Next day").disabled).toBe(false);
  await click(button(page, "Next day"));
  await click(button(page, "Next day"));
  expect(pickedDay()).toBe(D3);
  expect(button(page, "Next day").disabled).toBe(true);
});

test("while the day's answer loads, what is shown is marked as not yet the day's", async () => {
  holdDays = true;
  const page = await renderPage();
  await click(bar(page, D2));
  expect(page.querySelector('[data-slot="activity-day-pending"]')).not.toBe(null);
  await act(async () => { held.splice(0).forEach((release) => release()); });
  await settle();
  expect(page.querySelector('[data-slot="activity-day-pending"]')).toBe(null);
  expect(spendFigure(page)).toBe("~$2.00");
});

test("the log links of a picked day open the log on that day", async () => {
  const page = await renderPage(`/activity?day=${D2}`);
  const links = [...page.querySelectorAll<HTMLAnchorElement>("a")].filter((a) => a.textContent?.startsWith("Open logs"));
  expect(links.length).toBeGreaterThan(0);
  for (const link of links) expect(new URL(link.href, "http://x").searchParams.get("day")).toBe(D2);
  const agentRow = [...page.querySelectorAll<HTMLAnchorElement>("a")].find((a) => new URL(a.href, "http://x").searchParams.get("agent") === "managers")!;
  expect(new URL(agentRow.href, "http://x").searchParams.get("day")).toBe(D2);
});

test("a window change lets go of the picked day", async () => {
  const page = await renderPage(`/activity?day=${D2}`);
  const sevenDays = [...page.querySelectorAll<HTMLButtonElement>('[data-slot="activity-window"] button')].find((b) => b.textContent === "7d")!;
  await click(sevenDays);
  expect(pickedDay()).toBe(null);
});

test("a day the window does not hold is not picked, and is not asked for", async () => {
  const page = await renderPage("/activity?day=2026-01-01");
  expect(chip(page)).toBe(null);
  expect(spendFigure(page)).toBe("~$6.00");
  expect(asked.some((query) => query.has("day"))).toBe(false);
});

test("a picked day's cache line speaks of the day", async () => {
  const page = await renderPage(`/activity?day=${D2}`);
  expect(page.textContent).toContain("No call this day wrote a 1-hour cache.");
});

test("a window without spend draws calls per day, and a day's column picks it too", async () => {
  const unpriced: ActivitySummaryResponse = { ...WINDOW, spend: spend(0, 0), ledger: emptyLedger({ days: [] }) };
  const page = await renderPage("/activity", unpriced);
  const column = page.querySelector<SVGElement>(`[data-chart-hit="${D3}"]`)!;
  await act(async () => { column.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
  expect(pickedDay()).toBe(D3);
  expect(column.getAttribute("aria-pressed")).toBe("true");
});

test("Refresh asks for the picked day again as well as the window", async () => {
  const page = await renderPage(`/activity?day=${D2}`);
  const before = asked.filter((query) => query.get("day") === D2).length;
  await click(page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!);
  expect(asked.filter((query) => query.get("day") === D2).length).toBe(before + 1);
});

test("a day whose answer fails says so, with a way to try again", async () => {
  failDays = true;
  const page = await renderPage(`/activity?day=${D2}`);
  expect(page.textContent).toContain("Couldn't load this day.");
  expect(page.querySelector('[data-slot="activity-day-pending"]')).not.toBe(null);
});

test("a refresh of a picked day that fails says so, with the day's last figures still shown", async () => {
  const page = await renderPage(`/activity?day=${D2}`);
  expect(spendFigure(page)).toBe("~$2.00");
  failDays = true;
  await click(page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!);
  expect(page.textContent).toContain("Couldn't load this day.");
  expect(spendFigure(page)).toBe("~$2.00");
});

test("the log links follow the day the Overview shows, not the url's word for it", async () => {
  const logLinkDays = (page: HTMLElement) => [...page.querySelectorAll<HTMLAnchorElement>("a")]
    .filter((a) => new URL(a.href, "http://x").searchParams.get("tab") === "logs")
    .map((a) => new URL(a.href, "http://x").searchParams.get("day"));
  // A day the window does not draw is not shown, so the links do not carry it.
  const outside = await renderPage("/activity?day=2026-01-01");
  expect(logLinkDays(outside).length).toBeGreaterThan(0);
  expect(logLinkDays(outside).every((day) => day === null)).toBe(true);
  runCleanups();
  activitySummaryCache.clear();
  // The Overview named by its tab shows the picked day, and so do its links.
  const named = await renderPage(`/activity?tab=overview&day=${D2}`);
  expect(chip(named)).not.toBe(null);
  expect(logLinkDays(named).every((day) => day === D2)).toBe(true);
});

test("a calls-chart column shows which day it is when it has the keyboard's focus", async () => {
  const unpriced: ActivitySummaryResponse = { ...WINDOW, spend: spend(0, 0), ledger: emptyLedger({ days: [] }) };
  const page = await renderPage("/activity", unpriced);
  const column = page.querySelector<SVGElement>(`[data-chart-hit="${D2}"]`)!;
  expect(page.querySelector("[data-chart-band]")).toBe(null);
  await act(async () => { column.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
  expect(page.querySelector("[data-chart-band]")).not.toBe(null);
  expect(page.querySelector("[data-chart-tooltip]")?.textContent).toContain("Oct 24");
});

test("a picked calls-chart column still shows the keyboard's focus, though its band is already there", async () => {
  const unpriced: ActivitySummaryResponse = { ...WINDOW, spend: spend(0, 0), ledger: emptyLedger({ days: [] }) };
  const page = await renderPage(`/activity?day=${D2}`, unpriced);
  const column = page.querySelector<SVGElement>(`[data-chart-hit="${D2}"]`)!;
  expect(page.querySelector("[data-chart-focus]")).toBe(null);
  await act(async () => { column.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); });
  expect(page.querySelector("[data-chart-focus]")?.getAttribute("x")).toBe(column.getAttribute("x"));
  await act(async () => { column.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
  expect(page.querySelector("[data-chart-focus]")).toBe(null);
});


test("a day's answer for another window is not this window's day: it is shown faded until this one comes", async () => {
  const page = await renderPage(`/activity?day=${D3}`);
  expect(page.querySelector('[data-slot="activity-day-pending"]')).toBe(null);
  const sevenDays = [...page.querySelectorAll<HTMLButtonElement>('[data-slot="activity-window"] button')].find((b) => b.textContent === "7d")!;
  await click(sevenDays);
  holdDays = true;
  await click(bar(page, D3));
  expect(pickedDay()).toBe(D3);
  // The 30-day window's answer for the date is still in hand; the 7-day one may differ.
  expect(page.querySelector('[data-slot="activity-day-pending"]')).not.toBe(null);
  await act(async () => { held.splice(0).forEach((release) => release()); });
  await settle();
  expect(page.querySelector('[data-slot="activity-day-pending"]')).toBe(null);
});

test("with the new window's answer still on its way, the old window's day is not taken for the new one's", async () => {
  const page = await renderPage(`/activity?day=${D3}`);
  const sevenDays = [...page.querySelectorAll<HTMLButtonElement>('[data-slot="activity-window"] button')].find((b) => b.textContent === "7d")!;
  holdWindows.add(7);
  holdDays = true;
  await click(sevenDays);
  await click(bar(page, D3));
  expect(pickedDay()).toBe(D3);
  // Both answers in hand are the 30-day window's.
  expect(page.querySelector('[data-slot="activity-day-pending"]')).not.toBe(null);
});
