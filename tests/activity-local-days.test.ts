import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { Database } from "bun:sqlite";
import type { ActivitySummaryResponse, LlmCallsResponse } from "../src/shared/api-contracts.js";
import { buildActivitySummary } from "../src/server/modules/activity/activity-summary.js";
import { buildActivityLedger } from "../src/server/modules/activity/ledger-summary.js";
import { activityRange, chartDates, dayClock, nextDate } from "../src/server/modules/activity/local-days.js";
import { activityModule } from "../src/server/modules/activity/module.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { BASE, freshLedgerDb, ledgerDeps, seedCall } from "./helpers/ledger-seed.js";
import { stub } from "./helpers/typed.js";
import type { AppDeps } from "../src/server/app/deps.js";

// Days on the Activity page are the reader's: a call at 01:30 in Shanghai
// belongs to that date there, though UTC still calls it the day before.

const SHANGHAI = "Asia/Shanghai";
/** 2026-10-25 01:30 in Shanghai, 2026-10-24 in UTC. */
const LATE = "2026-10-24T17:30:00.000Z";
/** 2026-10-24 23:00 in Shanghai: the same date in both. */
const EVENING = "2026-10-24T15:00:00.000Z";
const NOW = Date.parse("2026-10-26T00:00:00.000Z");

function insertCall(db: Database, id: string, createdAt: string, opts: { status?: string; error?: string } = {}) {
  db.prepare(`
    insert into llm_calls
      (id, purpose, provider, model, scope_type, request_hash, response_hash, status, error_json,
       input_tokens, output_tokens, cache_read_tokens, started_at, finished_at, latency_ms, created_at, updated_at)
    values (?, 'agent_wake_step', 'openai-compatible', 'gpt-test', 'agent_thread', 'rq', 'rs', ?, ?, 100, 10, 0, ?, ?, 1000, ?, ?)
  `).run(id, opts.status ?? "succeeded", opts.error ?? null, createdAt, createdAt, createdAt, createdAt);
}

test("a call's day is the reader's date, not UTC's", () => {
  expect(dayClock(SHANGHAI).dayOf(LATE)).toBe("2026-10-25");
  expect(dayClock(SHANGHAI).dayOf(EVENING)).toBe("2026-10-24");
  expect(dayClock("UTC").dayOf(LATE)).toBe("2026-10-24");
  // Half-hour zones cut inside the hour.
  expect(dayClock("Asia/Kolkata").dayOf("2026-10-24T18:29:00.000Z")).toBe("2026-10-24");
  expect(dayClock("Asia/Kolkata").dayOf("2026-10-24T18:30:00.000Z")).toBe("2026-10-25");
});

test("a day starts at the reader's midnight, on the days the clocks change too", () => {
  const ny = dayClock("America/New_York");
  expect(new Date(ny.startOf("2026-03-08")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
  expect(new Date(ny.startOf("2026-03-09")).toISOString()).toBe("2026-03-09T04:00:00.000Z");
  expect(new Date(ny.startOf("2026-11-01")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  expect(new Date(ny.startOf("2026-11-02")).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  expect(new Date(dayClock(SHANGHAI).startOf("2026-10-25")).toISOString()).toBe("2026-10-24T16:00:00.000Z");
  // Sydney leaves summer time at 03:00 on 5 April: its midnight is still +11,
  // though by UTC's midnight the clocks read +10.
  expect(new Date(dayClock("Australia/Sydney").startOf("2026-04-05")).toISOString()).toBe("2026-04-04T13:00:00.000Z");
  // Santiago skips its midnight on 6 September: the day starts at 01:00,
  // and the hour before that instant is still the 5th.
  const santiago = dayClock("America/Santiago");
  expect(new Date(santiago.startOf("2026-09-06")).toISOString()).toBe("2026-09-06T04:00:00.000Z");
  expect(santiago.dayOf("2026-09-06T03:30:00.000Z")).toBe("2026-09-05");
  expect(santiago.dayOf("2026-09-06T04:00:00.000Z")).toBe("2026-09-06");
  // Amman went back from 01:00 to 00:00 on 29 October 2021: its midnight
  // came twice, and the day starts at the first.
  const amman = dayClock("Asia/Amman");
  expect(new Date(amman.startOf("2021-10-29")).toISOString()).toBe("2021-10-28T21:00:00.000Z");
  expect(amman.dayOf("2021-10-28T21:30:00.000Z")).toBe("2021-10-29");
  expect(amman.dayOf("2021-10-28T20:59:00.000Z")).toBe("2021-10-28");
  expect(nextDate("2026-10-31")).toBe("2026-11-01");
  expect(nextDate("2026-03-01", -1)).toBe("2026-02-28");
  expect(nextDate("9999-12-31")).toBe("10000-01-01");
});

test("a call's day is the span from that day's start to the next's, wherever the clocks change", () => {
  // The chart groups by dayOf and the log filters by the two starts: they
  // must agree minute by minute, even where a zone's wall date runs
  // backwards for a while (Newfoundland left summer time at 00:01 in 2009,
  // so its 1 November began, went back to 31 October, then began again).
  const cases: Array<[string, string]> = [
    ["America/St_Johns", "2009-11-01"],
    // Casey went from +11 to +8 at its midnight in 2010: 5 March began, and
    // three hours of 4 March followed.
    ["Antarctica/Casey", "2010-03-05"],
    ["America/Santiago", "2026-09-06"],
    ["Asia/Amman", "2021-10-29"],
    ["Australia/Sydney", "2026-04-05"],
    ["America/New_York", "2026-03-08"],
    ["America/New_York", "2026-11-01"],
    [SHANGHAI, "2026-10-25"]
  ];
  for (const [zone, date] of cases) {
    const clock = dayClock(zone);
    const start = clock.startOf(date);
    const end = clock.startOf(nextDate(date));
    // And the start is the first minute the wall clock shows the date (or a
    // later one), however briefly: where midnight comes twice, the first.
    const wall = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    const midnightUtc = Date.parse(`${date}T00:00:00.000Z`);
    let first = midnightUtc + 16 * 3_600_000;
    for (let t = midnightUtc - 16 * 3_600_000; t < first; t += 60_000) {
      if (wall.format(new Date(t)) >= date) first = t;
    }
    expect(`${zone} ${date} ${new Date(start).toISOString()}`).toBe(`${zone} ${date} ${new Date(first).toISOString()}`);
    for (let t = start - 26 * 3_600_000; t < end + 26 * 3_600_000; t += 60_000) {
      const inDay = t >= start && t < end;
      if ((clock.dayOf(new Date(t).toISOString()) === date) !== inDay) {
        throw new Error(`${zone} ${date}: ${new Date(t).toISOString()} is ${clock.dayOf(new Date(t).toISOString())}, start ${new Date(start).toISOString()}, end ${new Date(end).toISOString()}`);
      }
    }
  }
});

test("an unknown or missing zone is UTC", () => {
  expect(dayClock("Mars/Olympus").zone).toBe("UTC");
  expect(dayClock(null).zone).toBe("UTC");
  expect(dayClock(SHANGHAI).zone).toBe(SHANGHAI);
  // A zone off a url is read the same way by the summary and the log.
  expect(dayClock(` ${SHANGHAI} `).zone).toBe(SHANGHAI);
});

test("the summary's days and its day groups follow the reader's zone", () => {
  const env = freshStoresEnv("md-activity-local-days-");
  try {
    insertCall(env.store.db, "call_late", LATE, { status: "failed", error: JSON.stringify({ message: "upstream closed" }) });
    insertCall(env.store.db, "call_evening", EVENING);

    const local = buildActivitySummary(env.store.db, 30, "day", NOW, activityRange({ days: 30, now: NOW, zone: SHANGHAI }));
    expect(local.daily.map((d) => [d.date, d.calls])).toEqual([["2026-10-24", 1], ["2026-10-25", 1]]);
    expect(local.groups.map((g) => [g.key, g.calls])).toEqual([["2026-10-25", 1], ["2026-10-24", 1]]);
    // The failure's reason sits on the day the call is on.
    expect(local.groups.find((g) => g.key === "2026-10-25")?.reasons.map((r) => r.reason)).toEqual(["upstream closed"]);
    expect(local.groups.find((g) => g.key === "2026-10-24")?.reasons).toEqual([]);

    const utc = buildActivitySummary(env.store.db, 30, "day", NOW);
    expect(utc.daily.map((d) => [d.date, d.calls])).toEqual([["2026-10-24", 2]]);
  } finally {
    env.cleanup();
  }
});

test("the ledger's spend per day follows the reader's zone", () => {
  const { env, db } = freshLedgerDb();
  try {
    seedCall(db, { id: "late", t: Date.parse(LATE) - BASE, micros: 300_000 });
    seedCall(db, { id: "evening", t: Date.parse(EVENING) - BASE, micros: 200_000 });
    const ledger = buildActivityLedger(db, 30, ledgerDeps, NOW, activityRange({ days: 30, now: NOW, zone: SHANGHAI }));
    expect(ledger.days.map((d) => [d.date, d.spendMicros])).toEqual([["2026-10-24", 200_000], ["2026-10-25", 300_000]]);
  } finally {
    env.cleanup();
  }
});

test("the log's day filter is the reader's day when it names their zone", () => {
  const env = freshStoresEnv("md-activity-local-day-filter-");
  try {
    insertCall(env.store.db, "call_late", LATE);
    insertCall(env.store.db, "call_evening", EVENING);
    const ids = (filters: { day: string; zone?: string | null }) => env.store.listLlmCallSummaries(20, filters).map((c) => c.id).sort();
    expect(ids({ day: "2026-10-25", zone: SHANGHAI })).toEqual(["call_late"]);
    expect(ids({ day: "2026-10-24", zone: SHANGHAI })).toEqual(["call_evening"]);
    expect(ids({ day: "2026-10-24" })).toEqual(["call_evening", "call_late"]);
    expect(env.store.matchingLlmCallIds({ day: "2026-10-25", zone: SHANGHAI })).toEqual(["call_late"]);
    // A date that does not exist names no day at all, and the last one that
    // does is a day like any other.
    expect(ids({ day: "2026-02-31", zone: SHANGHAI })).toEqual([]);
    // The last day: its end is past year 9999, where ISO strings stop
    // sorting as text.
    insertCall(env.store.db, "call_last_day", "9999-12-31T12:00:00.000Z");
    expect(ids({ day: "9999-12-31" })).toEqual(["call_last_day"]);
    expect(ids({ day: "9999-12-31", zone: "UTC" })).toEqual(["call_last_day"]);
    expect(ids({ day: "9999-12-31", zone: "Mars/Olympus" })).toEqual(["call_last_day"]);
  } finally {
    env.cleanup();
  }
});

test("the summary and the log read the zone the page sends", async () => {
  const env = freshStoresEnv("md-activity-local-day-routes-");
  try {
    const recent = new Date(Date.now() - 3 * 86_400_000);
    // 23:30 UTC on a recent date: the next date in Shanghai.
    const lateIso = `${recent.toISOString().slice(0, 10)}T23:30:00.000Z`;
    insertCall(env.store.db, "call_late", lateIso);
    const shanghaiDate = dayClock(SHANGHAI).dayOf(lateIso);
    const app = new Hono();
    activityModule.mountRoutes?.(app, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket: createBunWebSocket().upgradeWebSocket });

    const summary = await (await app.request(`/api/activity/summary?days=30&tz=${encodeURIComponent(SHANGHAI)}`)).json() as ActivitySummaryResponse;
    expect(summary.daily.map((d) => d.date)).toEqual([shanghaiDate]);
    expect(summary.ledger.days.map((d) => d.date)).toEqual([shanghaiDate]);

    expect(summary.dates.at(-1)).toBe(dayClock(SHANGHAI).dayOf(new Date().toISOString()));
    expect(summary.dates[0]).toBe(shanghaiDate);

    const calls = await (await app.request(`/api/activity/calls?day=${shanghaiDate}&tz=${encodeURIComponent(SHANGHAI)}`)).json() as LlmCallsResponse;
    expect(calls.calls.map((c) => c.id)).toEqual(["call_late"]);
    expect((await app.request("/api/activity/calls?day=9999-12-31&tz=Mars%2FOlympus")).status).toBe(200);
  } finally {
    env.cleanup();
  }
});

test("the chart's dates: a silent day is a bar of zero, silence up to today counts, nothing is invented", () => {
  // The rows only hold days with calls; the chart draws every date between.
  expect(chartDates(["2026-08-01", "2026-08-04"], "2026-08-04", 32)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"]);
  expect(chartDates(["2026-07-30"], "2026-08-02", 32)).toEqual(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
  expect(chartDates(["2028-02-27"], "2028-03-01", 32)).toEqual(["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
  // Calls dated ahead of the clock (a machine whose time moved) stay on it.
  expect(chartDates(["2026-08-01", "2026-08-03"], "2026-08-02", 32)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
  // Bounded from the newest end: one stale row cannot draw six years of bars.
  const bounded = chartDates(["2020-01-01", "2026-08-03"], "2026-08-03", 32);
  expect(bounded).toHaveLength(32);
  expect(bounded.at(-1)).toBe("2026-08-03");
  expect(chartDates([], "2026-08-03", 32)).toEqual([]);
});

test("24 hours across a day the clocks spring forward touch three dates, and the chart has all three", () => {
  const env = freshStoresEnv("md-activity-short-day-");
  try {
    // New York's 8 March is 23 hours long: the 24 hours before 04:30 UTC on
    // the 9th start on the evening of the 7th.
    insertCall(env.store.db, "call_7th", "2026-03-08T04:45:00.000Z");
    insertCall(env.store.db, "call_9th", "2026-03-09T04:10:00.000Z");
    const now = Date.parse("2026-03-09T04:30:00.000Z");
    const summary = buildActivitySummary(env.store.db, 1, "purpose", now, activityRange({ days: 1, now, zone: "America/New_York" }));
    expect(summary.daily.map((d) => d.date)).toEqual(["2026-03-07", "2026-03-09"]);
    expect(summary.dates).toEqual(["2026-03-07", "2026-03-08", "2026-03-09"]);
  } finally {
    env.cleanup();
  }
});
