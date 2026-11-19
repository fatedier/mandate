import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ACTIVITY_GROUP_KEYS } from "../src/shared/api/activity.js";
import { buildActivitySummary, readFigureReasons } from "../src/server/modules/activity/activity-summary.js";
import { addFigureCall, addFigureReason, finishFigures, newFiguresPart, type FiguresPart } from "../src/server/modules/activity/figures-part.js";
import { activityRange, END_OF_TIME, type ActivityRange } from "../src/server/modules/activity/local-days.js";
import { readWindowCalls } from "../src/server/modules/activity/window-calls.js";
import { BASE, freshLedgerDb, HOUR, MIN, seedCall, seedVaried } from "./helpers/ledger-seed.js";

// The Overview's figures are worked out in parts that merge: a window cut
// anywhere, each piece read and summed on its own, gives the figures the
// whole window gives.

const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

function store(): Database {
  const { db } = freshLedgerDb();
  seedVaried(db);
  // Two failures and a success inside one minute, for a cut between them.
  seedCall(db, { id: "min-a", t: 13 * HOUR + 5_000, status: "failed", source: null, micros: null });
  seedCall(db, { id: "min-b", t: 13 * HOUR + 25_000, status: "failed", source: null, micros: null });
  seedCall(db, { id: "min-c", t: 13 * HOUR + 40_000, output: 4_000, latencyMs: 800 });
  db.prepare("update llm_calls set error_json = ? where id in ('min-a', 'min-b')").run(JSON.stringify({ message: "Too Many Requests" }));
  return db;
}

/** The window read piece by piece, cut at `cuts`: each piece's calls and
 *  failures go to the part of their day. */
function partsCutAt(db: Database, range: ActivityRange, cuts: number[]): Array<{ day: string; figures: FiguresPart }> {
  const end = range.until ?? END_OF_TIME;
  const inside = cuts.filter((cut) => iso(cut) < end);
  // A piece holds the calls from its cut on: created after the millisecond before it.
  const starts = [range.since, ...inside.map((cut) => iso(cut - 1))];
  const ends = [...inside.map((cut) => iso(cut)), end];
  const parts: Array<{ day: string; figures: FiguresPart }> = [];
  for (let i = 0; i < starts.length; i += 1) {
    const byDay = new Map<string, FiguresPart>();
    const partOf = (day: string) => byDay.get(day) ?? byDay.set(day, newFiguresPart()).get(day)!;
    for (const call of readWindowCalls(db, starts[i]!, ends[i]!)) addFigureCall(partOf(range.clock.dayOf(call.created_at)), call);
    for (const row of readFigureReasons(db, starts[i]!, ends[i]!)) addFigureReason(partOf(range.clock.dayOf(row.minute)), row, row.reason, row.calls);
    for (const [day, figures] of [...byDay].sort(([x], [y]) => (x < y ? -1 : 1))) parts.push({ day, figures });
  }
  return parts;
}

const everyHour = (from: number): number[] => {
  const cuts: number[] = [];
  for (let at = Math.ceil(from / HOUR) * HOUR; at < now; at += HOUR) cuts.push(at);
  return cuts;
};

test("the figures of a window cut into parts are the figures of the window whole, for every grouping", () => {
  const db = store();
  for (const zone of ["Asia/Singapore", "America/St_Johns"]) {
    const range = activityRange({ days: 7, now, zone, day: null });
    const sinceMs = Date.parse(range.since);
    const cutSets: Array<[string, number[]]> = [
      ["one part", []],
      ["every hour", everyHour(sinceMs)],
      ["every day", [1, 2, 3, 4, 5, 6].map((day) => sinceMs + day * 24 * HOUR)],
      ["inside a minute", [BASE + 13 * HOUR + 15_000, BASE + 13 * HOUR + 30_000]],
      ["on a call's own millisecond", [BASE + 3 * HOUR, BASE + 3 * HOUR + MIN]]
    ];
    for (const group of ACTIVITY_GROUP_KEYS) {
      const whole = JSON.stringify(buildActivitySummary(db, 7, group, now, range));
      for (const [name, cuts] of cutSets) {
        const merged = finishFigures(partsCutAt(db, range, cuts), { days: 7, group, today: range.clock.dayOf(iso(now)), pickedDay: null });
        expect(JSON.stringify(merged), `${zone}, by ${group}, cut ${name}`).toBe(whole);
      }
    }
  }
});

test("a picked day's figures merge the same way", () => {
  const db = store();
  const day = activityRange({ days: 7, now, zone: "Asia/Singapore", day: null }).clock.dayOf(iso(BASE + 13 * HOUR));
  const range = activityRange({ days: 7, now, zone: "Asia/Singapore", day });
  for (const group of ACTIVITY_GROUP_KEYS) {
    const merged = finishFigures(partsCutAt(db, range, everyHour(Date.parse(range.since))), { days: 7, group, today: range.clock.dayOf(iso(now)), pickedDay: day });
    expect(JSON.stringify(merged), `by ${group}`).toBe(JSON.stringify(buildActivitySummary(db, 7, group, now, range)));
  }
});

test("the seed tells the cuts apart: failures with reasons, first tokens, speeds, a fallback, several days", () => {
  const db = store();
  const range = activityRange({ days: 7, now, zone: "Asia/Singapore", day: null });
  const byPurpose = buildActivitySummary(db, 7, "purpose", now, range);
  const steps = byPurpose.groups.find((group) => group.key === "agent_wake_step")!;
  expect(steps.reasons).toEqual([{ reason: "Too Many Requests", calls: 2 }, { reason: "Service Unavailable", calls: 1 }]);
  expect([steps.ttftP95Ms !== null, steps.tokensPerSecondP50 !== null]).toEqual([true, true]);
  expect(byPurpose.daily.length).toBeGreaterThanOrEqual(2);
  expect(buildActivitySummary(db, 7, "fallback", now, range).groups.map((group) => group.key)).toEqual(["primary", "fallback"]);
});
