import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { Database } from "bun:sqlite";
import type { ActivitySummaryResponse } from "../src/shared/api-contracts.js";
import { buildActivitySummary } from "../src/server/modules/activity/activity-summary.js";
import { buildActivityLedger } from "../src/server/modules/activity/ledger-summary.js";
import { activityRange, dayClock } from "../src/server/modules/activity/local-days.js";
import { activityModule } from "../src/server/modules/activity/module.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { BASE, freshLedgerDb, ledgerDeps, seedCall } from "./helpers/ledger-seed.js";
import { stub } from "./helpers/typed.js";
import type { AppDeps } from "../src/server/app/deps.js";

// One day picked on the Overview: the figures and the sections below count
// that day of the window, cut at the reader's midnight.

const SHANGHAI = "Asia/Shanghai";
const NOW = Date.parse("2026-10-27T04:00:00.000Z");
/** In Shanghai: 24 Oct 23:30, 25 Oct 00:30, 25 Oct 23:30, 26 Oct 00:30. */
const BEFORE = "2026-10-24T15:30:00.000Z";
const FIRST = "2026-10-24T16:30:00.000Z";
const LAST = "2026-10-25T15:30:00.000Z";
const AFTER = "2026-10-25T16:30:00.000Z";

function insertCall(db: Database, id: string, createdAt: string, error: string | null = null) {
  db.prepare(`
    insert into llm_calls
      (id, purpose, provider, model, scope_type, request_hash, response_hash, status, error_json,
       input_tokens, output_tokens, cache_read_tokens, started_at, finished_at, latency_ms, created_at, updated_at)
    values (?, 'agent_wake_step', 'openai-compatible', 'gpt-test', 'agent_thread', 'rq', 'rs', ?, ?, 100, 10, 0, ?, ?, 1000, ?, ?)
  `).run(id, error ? "failed" : "succeeded", error ? JSON.stringify({ message: error }) : null, createdAt, createdAt, createdAt, createdAt);
}

test("a picked day counts the calls between that day's midnight and the next, and names itself", () => {
  const env = freshStoresEnv("md-activity-day-pick-");
  try {
    insertCall(env.store.db, "before", BEFORE, "refused before");
    insertCall(env.store.db, "first", FIRST);
    insertCall(env.store.db, "last", LAST, "refused on the day");
    insertCall(env.store.db, "after", AFTER, "refused after");
    const range = activityRange({ days: 30, now: NOW, zone: SHANGHAI, day: "2026-10-25" });
    const summary = buildActivitySummary(env.store.db, 30, "purpose", NOW, range);
    expect(summary.daily.map((d) => [d.date, d.calls])).toEqual([["2026-10-25", 2]]);
    expect(summary.groups.map((g) => g.calls)).toEqual([2]);
    // A failure's reason is the day's only if the failure is.
    expect(summary.groups[0]?.reasons).toEqual([{ reason: "refused on the day", calls: 1 }]);
    expect(summary.dates).toEqual(["2026-10-25"]);
    expect(range.day).toBe("2026-10-25");
  } finally {
    env.cleanup();
  }
});

test("the window's first day, picked, counts only the part of it inside the window", () => {
  const env = freshStoresEnv("md-activity-day-pick-edge-");
  try {
    // The 24 hours before 04:00 UTC on the 27th open at 12:00 on the 26th in
    // Shanghai: the 26th's bar holds only its afternoon and evening.
    insertCall(env.store.db, "morning", "2026-10-26T01:00:00.000Z");
    insertCall(env.store.db, "evening", "2026-10-26T10:00:00.000Z");
    insertCall(env.store.db, "next-morning", "2026-10-27T01:00:00.000Z");
    const window = buildActivitySummary(env.store.db, 1, "purpose", NOW, activityRange({ days: 1, now: NOW, zone: SHANGHAI }));
    const picked = buildActivitySummary(env.store.db, 1, "purpose", NOW, activityRange({ days: 1, now: NOW, zone: SHANGHAI, day: "2026-10-26" }));
    expect(window.daily.find((d) => d.date === "2026-10-26")?.calls).toBe(1);
    expect(picked.daily.map((d) => [d.date, d.calls])).toEqual([["2026-10-26", 1]]);
  } finally {
    env.cleanup();
  }
});

test("a picked day's spend is compared with the day before, and its sections hold only its calls", () => {
  const { env, db } = freshLedgerDb();
  try {
    seedCall(db, { id: "two-days-before", t: Date.parse("2026-10-23T08:00:00.000Z") - BASE, micros: 400_000 });
    seedCall(db, { id: "day-before", t: Date.parse("2026-10-24T08:00:00.000Z") - BASE, micros: 700_000 });
    seedCall(db, { id: "picked-a", t: Date.parse(FIRST) - BASE, micros: 200_000 });
    seedCall(db, { id: "picked-b", t: Date.parse(LAST) - BASE, micros: 300_000 });
    seedCall(db, { id: "day-after", t: Date.parse(AFTER) - BASE, micros: 900_000 });
    db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at, finished_at) values (?, 'schedule', 'succeeded', 'user', ?, ?)")
      .run("dream-on-day", "2026-10-25T03:00:00.000Z", "2026-10-25T03:05:00.000Z");
    db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at, finished_at) values (?, 'schedule', 'succeeded', 'user', ?, ?)")
      .run("dream-day-after", "2026-10-26T03:00:00.000Z", "2026-10-26T03:05:00.000Z");
    const ledger = buildActivityLedger(db, 30, ledgerDeps, NOW, activityRange({ days: 30, now: NOW, zone: SHANGHAI, day: "2026-10-25" }));
    expect(ledger.days.map((d) => [d.date, d.spendMicros])).toEqual([["2026-10-25", 500_000]]);
    expect(ledger.agents.reduce((sum, a) => sum + a.spendMicros, 0)).toBe(500_000);
    expect(ledger.previousSpendMicros).toBe(700_000);
    expect(ledger.wakes.find((w) => w.key === "dream")?.runs).toBe(1);
  } finally {
    env.cleanup();
  }
});

test("the summary endpoint reads the picked day; a day that does not exist is the whole window", async () => {
  const env = freshStoresEnv("md-activity-day-pick-route-");
  try {
    const recent = new Date(Date.now() - 3 * 86_400_000);
    const at = `${recent.toISOString().slice(0, 10)}T06:00:00.000Z`;
    insertCall(env.store.db, "picked", at);
    insertCall(env.store.db, "other", new Date(Date.now() - 86_400_000).toISOString());
    const day = dayClock(SHANGHAI).dayOf(at);
    const app = new Hono();
    activityModule.mountRoutes?.(app, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket: createBunWebSocket().upgradeWebSocket });
    const read = async (query: string) => await (await app.request(`/api/activity/summary?days=30&tz=${encodeURIComponent(SHANGHAI)}${query}`)).json() as ActivitySummaryResponse;

    const picked = await read(`&day=${day}`);
    expect(picked.day).toBe(day);
    expect(picked.daily.map((d) => [d.date, d.calls])).toEqual([[day, 1]]);
    expect(picked.ledger.days.map((d) => d.date)).toEqual([day]);

    const nonsense = await read("&day=2026-02-31");
    expect(nonsense.day ?? null).toBe(null);
    expect(nonsense.daily.reduce((sum, d) => sum + d.calls, 0)).toBe(2);
  } finally {
    env.cleanup();
  }
});
