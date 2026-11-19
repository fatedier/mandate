import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readParts } from "../src/server/modules/activity/activity-parts.js";
import { finishLedger, type LedgerPart } from "../src/server/modules/activity/ledger-part.js";
import { buildActivityLedger, readDreamRuns, readPreviousSpend } from "../src/server/modules/activity/ledger-summary.js";
import { activityRange, END_OF_TIME, type ActivityRange } from "../src/server/modules/activity/local-days.js";
import { createPriceCatalog } from "../src/server/modules/pricing/catalog.js";
import { BASE, CLAUDE, freshLedgerDb, HOUR, ledgerDeps, MIN, seedCall, seedVaried, seedWake } from "./helpers/ledger-seed.js";

// The Overview's ledger is worked out in parts that merge: a window cut
// anywhere, each piece read and judged on its own, gives the ledger the
// whole window gives.

const deps = ledgerDeps;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

/** The window read piece by piece, cut at `cuts`: each piece's calls go to
 *  the part of their day, the pieces oldest first. */
function partsCutAt(db: Database, range: ActivityRange, cuts: number[]): Array<{ day: string; ledger: LedgerPart }> {
  const end = range.until ?? END_OF_TIME;
  const inside = cuts.filter((cut) => iso(cut) < end);
  // A piece holds the calls from its cut on: created after the millisecond before it.
  const starts = [range.since, ...inside.map((cut) => iso(cut - 1))];
  const ends = [...inside.map((cut) => iso(cut)), end];
  return starts.flatMap((since, i) =>
    [...readParts(db, { since, until: ends[i]! }, deps, (createdAt) => range.clock.dayOf(createdAt))].map(([day, part]) => ({ day, ledger: part.ledger })));
}

const merged = (db: Database, range: ActivityRange, cuts: number[]) => JSON.stringify(finishLedger(partsCutAt(db, range, cuts), {
  dreamRuns: readDreamRuns(db, range.since, range.until ?? END_OF_TIME),
  previous: readPreviousSpend(db, range.previousSince, range.previousUntil)
}));

const everyHour = (from: number): number[] => {
  const cuts: number[] = [];
  for (let at = Math.ceil(from / HOUR) * HOUR; at < now; at += HOUR) cuts.push(at);
  return cuts;
};

function store(): Database {
  const { db } = freshLedgerDb();
  seedVaried(db);
  // Two wakes whose calls lie on both sides of an hour: one run each, not two.
  seedWake(db, "w-long", "t-manager", "worker-report");
  seedWake(db, "w-timer", "t-global", "schedule");
  for (const [id, wake, scopeId, t] of [["l1", "w-long", "t-manager", 14 * HOUR - 2 * MIN], ["l2", "w-long", "t-manager", 14 * HOUR + 3 * MIN], ["s1", "w-timer", "t-global", 15 * HOUR - MIN], ["s2", "w-timer", "t-global", 15 * HOUR + MIN]] as const) {
    seedCall(db, { id, t, scopeId, micros: 70_000, read: 60_000, metadata: { wakeId: wake } });
  }
  // A dream run that left no calls still ran.
  db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at) values ('dr-1', 'schedule', 'failed', 'user', ?)").run(iso(BASE + 16 * HOUR));
  // Spend before the window, for the period it is compared with.
  seedCall(db, { id: "before", t: -8 * 24 * HOUR, micros: 123_000 });
  return db;
}

test("the ledger of a window cut into parts is the ledger of the window whole", () => {
  const db = store();
  for (const zone of ["Asia/Singapore", "America/St_Johns"]) {
    const range = activityRange({ days: 7, now, zone, day: null });
    const sinceMs = Date.parse(range.since);
    const whole = JSON.stringify(buildActivityLedger(db, 7, deps, now, range));
    const cutSets: Array<[string, number[]]> = [
      ["one part", []],
      ["every hour", everyHour(sinceMs)],
      ["every day", [1, 2, 3, 4, 5, 6].map((day) => sinceMs + day * 24 * HOUR)],
      ["between two calls of one thread", [BASE + 5 * HOUR + 10 * MIN, BASE + 14 * HOUR]],
      ["on a call's own millisecond", [BASE + 5 * HOUR, BASE + 5 * HOUR + 20 * MIN]]
    ];
    for (const [name, cuts] of cutSets) expect(merged(db, range, cuts), `${zone}, cut ${name}`).toBe(whole);
  }
});

test("a picked day's ledger merges the same way, with the day before as its previous period", () => {
  const db = store();
  const day = activityRange({ days: 7, now, zone: "Asia/Singapore", day: null }).clock.dayOf(iso(BASE + 14 * HOUR));
  const range = activityRange({ days: 7, now, zone: "Asia/Singapore", day });
  expect(merged(db, range, everyHour(Date.parse(range.since)))).toBe(JSON.stringify(buildActivityLedger(db, 7, deps, now, range)));
});

test("the seed tells the cuts apart: verdicts of every kind, runs across an hour, a dream run, a previous period", () => {
  const db = store();
  const ledger = buildActivityLedger(db, 7, deps, now, activityRange({ days: 7, now, zone: "Asia/Singapore", day: null }));
  expect(ledger.cache.rows.map((row) => row.kind)).toEqual(["expired", "miss", "not_reused", "rebuild"]);
  const wakes = Object.fromEntries(ledger.wakes.map((wake) => [wake.key, wake.runs]));
  expect([wakes.worker_reports, wakes.scheduled_checks, wakes.dream]).toEqual([1, 1, 1]);
  expect(ledger.previousSpendMicros).toBe(123_000);
  expect(ledger.cache.medianExpiredIdleMs).not.toBeNull();
});

// The median idle is the middle of the expired calls' idle times: with one
// more of them it is another call's, and it must be whatever the cut.
test("the median idle of an even and of an odd number of expired calls merges", () => {
  const expiredCalls: number[] = [];
  for (const extra of [0, 1]) {
    const db = store();
    if (extra) seedCall(db, { id: "one-more", scopeId: "t-global", t: 20 * HOUR, read: 0, write: 100_000, metadata: { wakeId: "w-timer" } });
    const range = activityRange({ days: 7, now, zone: "Asia/Singapore", day: null });
    const whole = buildActivityLedger(db, 7, deps, now, range);
    expiredCalls.push(whole.cache.rows.find((row) => row.kind === "expired")!.calls);
    expect(merged(db, range, everyHour(Date.parse(range.since))), `extra ${extra}`).toBe(JSON.stringify(whole));
  }
  // One more expired call: one of the two counts is even, the other odd.
  expect(expiredCalls[1]! - expiredCalls[0]!).toBe(1);
});

// The write/read ratio is the Claude model with the most spend; of two with
// the same spend, the one whose call came first, whichever part it is in.
test("of two Claude models with equal spend the first seen names the ratio, across a cut", () => {
  for (const first of [CLAUDE, "anthropic/claude-unlisted-test"]) {
    const { db } = freshLedgerDb();
    const second = first === CLAUDE ? "anthropic/claude-unlisted-test" : CLAUDE;
    seedCall(db, { id: "a", t: 0, model: first, micros: 300_000, write: 100_000 });
    seedCall(db, { id: "b", scopeId: "t-global", t: 2 * HOUR, model: second, micros: 300_000, write: 100_000 });
    const range = activityRange({ days: 7, now, zone: "Asia/Singapore", day: null });
    const whole = buildActivityLedger(db, 7, deps, now, range);
    // The listed model has rates (write 5, read 0.2); the unlisted one none.
    expect(whole.claudeWriteReadRatio, first).toBe(first === CLAUDE ? 25 : null);
    expect(merged(db, range, [BASE + HOUR])).toBe(JSON.stringify(whole));
  }
});

// A model's rates are those of its first call that has rates: a later call
// above the long-context tier is billed at others.
test("a Claude model's ratio is read from its first call's rates, across a cut", () => {
  const tiered = createPriceCatalog({
    litellm: {
      date: "2026-01-02",
      entries: Object.assign(Object.create(null), {
        "claude-tier-test": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, tiers: [{ above: 200_000, rates: { input: 8, output: 30, cacheRead: 0.5 } }] } }
      })
    },
    modelsDev: null
  });
  const tierDeps = { catalog: tiered, providers: {} };
  const ref = JSON.stringify({ origin: "litellm", providerId: "anthropic", providerName: "anthropic", modelId: "claude-tier-test", dataDate: "2026-01-02" });
  for (const [firstInput, ratio] of [[100_000, 25], [300_000, 10]] as const) {
    const { db } = freshLedgerDb();
    seedCall(db, { id: "a", t: 0, model: "anthropic/claude-tier-test", ref, input: firstInput, micros: 300_000 });
    seedCall(db, { id: "b", scopeId: "t-global", t: 2 * HOUR, model: "anthropic/claude-tier-test", ref, input: firstInput === 100_000 ? 300_000 : 100_000, micros: 300_000 });
    const range = activityRange({ days: 7, now, zone: "Asia/Singapore", day: null });
    const whole = buildActivityLedger(db, 7, tierDeps, now, range);
    expect(whole.claudeWriteReadRatio, `first call of ${firstInput} tokens`).toBe(ratio);
    const cut = [...readParts(db, { since: range.since, until: iso(BASE + HOUR) }, tierDeps, (at) => range.clock.dayOf(at)), ...readParts(db, { since: iso(BASE + HOUR - 1), until: END_OF_TIME }, tierDeps, (at) => range.clock.dayOf(at))];
    const extra = { dreamRuns: 0, previous: readPreviousSpend(db, range.previousSince, range.previousUntil) };
    expect(JSON.stringify(finishLedger(cut.map(([day, part]) => ({ day, ledger: part.ledger })), extra))).toBe(JSON.stringify(whole));
  }
});

// A row's money reads as spend when any of its calls is spend, whichever
// part that call is in.
test("what a role's and a wake's money reads as merges across a cut", () => {
  const { db } = freshLedgerDb();
  seedWake(db, "w-1", "t-manager", "user");
  // Unpriced first, spend an hour later: the same role, the same wake.
  seedCall(db, { id: "a", t: 0, source: "unpriced", micros: null, metadata: { wakeId: "w-1" } });
  seedCall(db, { id: "b", t: 2 * HOUR, micros: 50_000, read: 90_000, metadata: { wakeId: "w-1" } });
  const range = activityRange({ days: 7, now, zone: "Asia/Singapore", day: null });
  const whole = buildActivityLedger(db, 7, deps, now, range);
  expect([whole.agents.map((a) => [a.role, a.money]), whole.wakes.map((w) => [w.key, w.money])]).toEqual([[["managers", "spend"]], [["messages", "spend"]]]);
  expect(merged(db, range, [BASE + HOUR])).toBe(JSON.stringify(whole));
});

test("a step created on the first millisecond of an hour is judged against the step before it, not against itself", () => {
  const { db } = freshLedgerDb();
  const hour = Math.ceil(BASE / HOUR) * HOUR + 3 * HOUR;
  const at = (ms: number) => ms - BASE;
  seedCall(db, { id: "before", t: at(hour - 10 * MIN), write: 100_000 });
  // Ten minutes on, on the hour itself: the cache it could have read expired.
  seedCall(db, { id: "on-the-hour", t: at(hour), read: 10_000, write: 90_000 });
  const range = activityRange({ days: 7, now, zone: "Asia/Singapore", day: null });
  const whole = buildActivityLedger(db, 7, deps, now, range);
  expect(whole.cache.rows.map((row) => [row.kind, row.calls, row.rewrittenTokens])).toEqual([["expired", 1, 90_000]]);
  expect(merged(db, range, [hour])).toBe(JSON.stringify(whole));
  expect(merged(db, range, [hour, hour + 1])).toBe(JSON.stringify(whole));
});
