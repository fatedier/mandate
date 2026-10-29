import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import type { ActivitySummaryResponse } from "@shared/api-contracts";
import { ActivityPage } from "@/routes/activity/ActivityPage";
import { activitySummaryCache, summaryKey } from "@/routes/activity/useActivitySummary";
import { readerTimeZone } from "@/lib/time-zone";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchHandler } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { emptyLedger } from "../helpers/activity-ledger.js";

afterEach(() => {
  // Unmount before the summary cache the page reads is cleared under it.
  runCleanups();
  activitySummaryCache.clear();
});

const SUMMARY: ActivitySummaryResponse = {
  days: 30,
  ledger: emptyLedger(),
  spend: { micros: 0, reportedMicros: 0, estimated: false, pricedCalls: 0, unpricedCalls: 0, includedCalls: 0, includedApiMicros: 0, pendingCalls: 0 },
  daily: [{ date: "2026-08-01", calls: 120, failed: 4, inputTokens: 9000, outputTokens: 300, cacheReadTokens: 8100, p50Ms: 800, p95Ms: 4000, p99Ms: 9000 }],
  dates: ["2026-08-01"],
  buckets: [{ bucket: "<1s", calls: 120 }],
  group: "purpose",
  groups: [],
  p50Ms: 800,
  p95Ms: 4000,
  p99Ms: 9000,
  ttft: { calls: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 }
};

async function render(entry: string, handler: FetchHandler) {
  mockFetch(handler);
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={[entry]}>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <ActivityPage />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  await settle();
  await settle();
  return host;
}
const has = (host: ParentNode, selector: string) => host.querySelector(selector) !== null;
const retryIn = (el: Element) => [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;

test("a summary that fails to load is the inline error alone: no skeleton, and Retry asks again", async () => {
  let summaries = 0;
  const host = await render("/activity", ({ url }) => {
    if (!url.includes("/api/activity/summary")) return jsonResponse({ ok: true });
    summaries += 1;
    return summaries === 1 ? jsonResponse({ error: "database is locked" }, 500) : jsonResponse(SUMMARY);
  });
  const failed = host.querySelector('[data-slot="inline-error"]')!;
  expect(failed.textContent).toContain("Couldn't load activity.");
  expect(failed.querySelector("p")!.textContent).toBe("database is locked");
  expect(has(host, '[data-slot="skeleton"]')).toBe(false);
  await act(async () => { retryIn(failed).click(); });
  await settle();
  expect(summaries).toBe(2);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
  expect(host.textContent).toContain("120");
});

test("a refresh that fails keeps the figures it had and says they are the last loaded ones", async () => {
  activitySummaryCache.set(summaryKey("purpose", 30), { data: SUMMARY, fetchedAt: 0 });
  const host = await render("/activity", ({ url }) => url.includes("/api/activity/summary")
    ? jsonResponse({ error: "database is locked" }, 500)
    : jsonResponse({ ok: true }));
  expect(host.querySelector('[data-slot="inline-error"]')!.textContent).toContain("Couldn't refresh activity. Showing the last loaded figures.");
  expect(host.textContent).toContain("120");
});

test("a log that fails to load is the inline error alone, never \"No data yet\"; Retry asks again", async () => {
  let lists = 0;
  const host = await render("/activity?tab=logs", ({ url }) => {
    if (!url.includes("/api/activity/calls")) return jsonResponse({ ok: true });
    lists += 1;
    return lists === 1 ? jsonResponse({ error: "database is locked" }, 500) : jsonResponse({ calls: [] });
  });
  const failed = host.querySelector('[data-slot="inline-error"]')!;
  expect(failed.textContent).toContain("Couldn't load the log.");
  expect(failed.querySelector("p")!.textContent).toBe("database is locked");
  expect(host.textContent).not.toContain("No data yet");
  await act(async () => { retryIn(failed).click(); });
  await settle();
  await settle();
  expect(lists).toBe(2);
  expect(has(host, '[data-slot="inline-error"]')).toBe(false);
});

test("older calls that fail to load are the inline error in the foot, with the reason; the list above says nothing", async () => {
  const calls = Array.from({ length: 50 }, (_, i) => ({
    id: `call-${i}`, threadId: null, wakeId: null, purpose: "agent", provider: "openai", model: "gpt-5", status: "succeeded",
    error: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, startedAt: "2026-08-01T00:00:00.000Z",
    finishedAt: "2026-08-01T00:00:01.000Z", latencyMs: 1000, createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, 50 - i)).toISOString(),
    updatedAt: "2026-08-01T00:00:01.000Z"
  }));
  // happy-dom has no IntersectionObserver; the foot's auto-load needs one to
  // exist, and the clicks below stand in for what it would see.
  const saved = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true, writable: true,
    value: class { observe() {} disconnect() {} }
  });
  onCleanup(() => {
    if (saved) Object.defineProperty(globalThis, "IntersectionObserver", saved);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  });
  let older = 0;
  const host = await render("/activity?tab=logs", ({ url }) => {
    if (!url.includes("/api/activity/calls")) return jsonResponse({ ok: true });
    if (!url.includes("before=")) return jsonResponse({ calls });
    older += 1;
    return jsonResponse({ error: "database is locked" }, 500);
  });
  const load = [...host.querySelectorAll("button")].find((b) => b.textContent === "Load older")!;
  expect(load === undefined).toBe(false);
  await act(async () => { load.click(); });
  await settle();
  expect(older).toBe(1);
  const failed = host.querySelectorAll('[data-slot="inline-error"]');
  expect(failed.length).toBe(1);
  expect(failed[0]!.textContent).toContain("Couldn't load older calls.");
  expect(failed[0]!.querySelector("p")!.textContent).toBe("database is locked");
  await act(async () => { retryIn(failed[0]!).click(); });
  await settle();
  expect(older).toBe(2);
});

test("a log whose time zone changed under it is read again from the top in the new zone, never paged on", async () => {
  const calls = Array.from({ length: 50 }, (_, i) => ({
    id: `call-${i}`, threadId: null, wakeId: null, purpose: "agent", provider: "openai", model: "gpt-5", status: "succeeded",
    error: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, startedAt: "2026-10-25T00:00:00.000Z",
    finishedAt: "2026-10-25T00:00:01.000Z", latencyMs: 1000, createdAt: new Date(Date.UTC(2026, 9, 25, 12, 0, 50 - i)).toISOString(),
    updatedAt: "2026-10-25T00:00:01.000Z"
  }));
  const saved = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: class { observe() {} disconnect() {} } });
  const RealFormat = Intl.DateTimeFormat;
  onCleanup(() => {
    Intl.DateTimeFormat = RealFormat;
    if (saved) Object.defineProperty(globalThis, "IntersectionObserver", saved);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  });
  const asked: URLSearchParams[] = [];
  let moved = "";
  const host = await render("/activity?tab=logs&day=2026-10-25", ({ url }) => {
    if (!url.includes("/api/activity/calls")) return jsonResponse({ ok: true });
    const query = new URL(url, "http://x").searchParams;
    asked.push(query);
    // The new zone's list is still on its way when the page draws again.
    if (moved && query.get("tz") === moved && !query.has("before")) return new Promise<Response>(() => {});
    return jsonResponse({ calls: url.includes("before=") ? [] : calls });
  });
  expect(host.querySelectorAll("[data-log-row]").length).toBe(50);
  // The machine moves to another zone while the log stays open.
  moved = readerTimeZone() === "Pacific/Chatham" ? "Pacific/Pitcairn" : "Pacific/Chatham";
  Intl.DateTimeFormat = function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
    const format = new RealFormat(...args);
    if (args.length > 0) return format;
    const resolved = format.resolvedOptions();
    return Object.assign(Object.create(format) as Intl.DateTimeFormat, { resolvedOptions: () => ({ ...resolved, timeZone: moved }) });
  } as unknown as typeof Intl.DateTimeFormat;
  const load = [...host.querySelectorAll("button")].find((b) => b.textContent === "Load older")!;
  await act(async () => { load.click(); });
  await settle();
  // No page of the old day is continued in the new zone's day.
  expect(asked.filter((q) => q.has("before") && q.get("tz") === moved)).toEqual([]);
  expect(asked.some((q) => !q.has("before") && q.get("tz") === moved)).toBe(true);
  // While it loads, the old zone's day is not shown as this one.
  expect(host.querySelectorAll("[data-log-row]").length).toBe(0);
});
