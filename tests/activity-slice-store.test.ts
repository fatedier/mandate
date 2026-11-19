import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ACTIVITY_GROUP_KEYS } from "../src/shared/api/activity.js";
import { readParts, type ActivityPart } from "../src/server/modules/activity/activity-parts.js";
import { summarizeActivity } from "../src/server/modules/activity/activity-summary-away.js";
import { finishFigures, newFiguresPart } from "../src/server/modules/activity/figures-part.js";
import { finishLedger, newLedgerPart } from "../src/server/modules/activity/ledger-part.js";
import { readDreamRuns, readPreviousSpend } from "../src/server/modules/activity/ledger-summary.js";
import { activityRange, END_OF_TIME } from "../src/server/modules/activity/local-days.js";
import { sliceOf } from "../src/server/modules/activity/slice-schema.js";
import { decodeSlice, encodeSlice, keepSlices, type SliceRow } from "../src/server/modules/activity/slice-store.js";
import { freshLedgerDb, ledgerDeps, seedCall, seedVaried, seedWake } from "./helpers/ledger-seed.js";

// A slice's facts are kept as a row and read back whole: what merges from
// the rows read back is what merged from the parts they were made from.

const deps = ledgerDeps;
const now = Date.now();
const input = (group: (typeof ACTIVITY_GROUP_KEYS)[number]) => ({ days: 7, group, now, zone: "Asia/Singapore", day: null });

function store(): Database {
  const { db } = freshLedgerDb();
  seedVaried(db);
  // A value past a 32-bit integer and one that is no whole number: kept as they are.
  seedCall(db, { id: "long", t: 17 * 3_600_000, latencyMs: 3_000_000_000, output: 9 });
  db.prepare("update llm_calls set latency_ms = 1234.5 where id = 'check'").run();
  // A second wake of the same kind in an hour that has one already: two runs.
  seedWake(db, "w-3", "t-manager", "user");
  seedCall(db, { id: "second-wake", t: 5 * 60_000, micros: 10_000, read: 90_000, metadata: { wakeId: "w-3" } });
  return db;
}

/** The window's calls by hour, as a slice is built. */
function hours(db: Database): Array<[string, ActivityPart]> {
  const range = activityRange(input("purpose"));
  return [...readParts(db, { since: range.since, until: END_OF_TIME }, deps, sliceOf)];
}

function answer(db: Database, parts: Array<[string, ActivityPart]>, group: (typeof ACTIVITY_GROUP_KEYS)[number]): string {
  const range = activityRange(input(group));
  const dayOf = (slice: string) => range.clock.dayOf(`${slice}:00:00.000Z`);
  return JSON.stringify({
    ...finishFigures(parts.map(([slice, part]) => ({ day: dayOf(slice), figures: part.figures })), { days: 7, group, today: range.clock.dayOf(new Date(now).toISOString()), pickedDay: null }),
    ledger: finishLedger(parts.map(([slice, part]) => ({ day: dayOf(slice), ledger: part.ledger })), {
      dreamRuns: readDreamRuns(db, range.since, END_OF_TIME), previous: readPreviousSpend(db, range.previousSince, range.previousUntil)
    }),
    day: null
  });
}

test("parts kept as rows and read back merge into the answer the parts gave", () => {
  const db = store();
  const parts = hours(db);
  expect(parts.length).toBeGreaterThan(10);
  const rows = parts.map(([slice, part]) => encodeSlice(slice, part, 7, "inputs-a"));
  const back = rows.map((row): [string, ActivityPart] => [row.start, decodeSlice(row)]);
  for (const group of ACTIVITY_GROUP_KEYS) {
    expect(answer(db, back, group), `by ${group}`).toBe(answer(db, parts, group));
    // And that is the window's answer: hours lie within the reader's days here.
    expect(answer(db, back, group), `by ${group}, against the window whole`).toBe(JSON.stringify(summarizeActivity(db, input(group), deps)));
  }
  // The row says what it was built at and with, and its spend apart from its facts.
  const total = rows.reduce((sum, row) => sum + row.spendMicros, 0);
  expect([rows[0]!.builtSeq, rows[0]!.inputs, total]).toEqual([7, "inputs-a", summarizeActivity(db, input("purpose"), deps).spend.micros]);
  expect(rows.reduce((sum, row) => sum + row.spendCalls, 0)).toBe(summarizeActivity(db, input("purpose"), deps).spend.pricedCalls);
});

test("a row survives the database: the same part comes back from the table", () => {
  const db = store();
  const parts = hours(db);
  keepSlices(db, parts.map(([slice, part]) => encodeSlice(slice, part, 7, "inputs-a")), "0000");
  const kept = db.prepare("select start, built_seq builtSeq, inputs, spend_micros spendMicros, spend_calls spendCalls, facts, vals from activity_slices order by start").all() as SliceRow[];
  expect(kept.map((row) => row.start)).toEqual(parts.map(([slice]) => slice).sort());
  const back = kept.map((row): [string, ActivityPart] => [row.start, decodeSlice(row)]);
  for (const group of ACTIVITY_GROUP_KEYS) expect(answer(db, back, group), `by ${group}`).toBe(answer(db, parts, group));
});

test("a part with no call is a row too, and comes back empty", () => {
  const empty: ActivityPart = { figures: newFiguresPart(), ledger: newLedgerPart() };
  const row = encodeSlice("2026-03-04T05", empty, 3, "inputs-a");
  expect([row.spendMicros, row.spendCalls, row.vals.byteLength]).toEqual([0, 0, 0]);
  const back = decodeSlice(row);
  expect([back.figures.tuples.length, back.ledger.agents.size, back.ledger.expiredIdles.length]).toEqual([0, 0, 0]);
});

const row = (start: string, builtSeq: number, inputs = "inputs-a"): SliceRow =>
  encodeSlice(start, { figures: newFiguresPart(), ledger: newLedgerPart() }, builtSeq, inputs);
const keptRows = (db: Database) =>
  (db.prepare("select start, built_seq, inputs from activity_slices order by start").all() as Array<{ start: string; built_seq: number; inputs: string }>).map((r) => `${r.start}@${r.built_seq}:${r.inputs}`);

test("an older build never replaces a newer one", () => {
  const { db } = freshLedgerDb();
  expect(keepSlices(db, [row("2026-03-04T05", 5), row("2026-03-04T06", 5)], "0000")).toEqual([]);
  expect(keptRows(db)).toEqual(["2026-03-04T05@5:inputs-a", "2026-03-04T06@5:inputs-a"]);
  // Two answers under way at once: the later snapshot's slice is kept first, the earlier one's after.
  keepSlices(db, [row("2026-03-04T05", 9, "inputs-b")], "0000");
  keepSlices(db, [row("2026-03-04T05", 7), row("2026-03-04T06", 7)], "0000");
  expect(keptRows(db)).toEqual(["2026-03-04T05@9:inputs-b", "2026-03-04T06@7:inputs-a"]);
});

test("slices before the horizon go, and a change before it raises the floor", () => {
  const { db } = freshLedgerDb();
  keepSlices(db, [row("2026-03-01T00", 5), row("2026-03-04T05", 5)], "0000");
  db.prepare("update activity_rollup_state set seq = 40, floor = 12").run();
  db.prepare("insert into activity_slice_changes (start, seq) values ('2026-03-01T00', 31), ('2026-03-02T00', 8), ('2026-03-04T05', 39)").run();
  keepSlices(db, [row("2026-03-04T06", 40)], "2026-03-03T00");
  expect(keptRows(db)).toEqual(["2026-03-04T05@5:inputs-a", "2026-03-04T06@40:inputs-a"]);
  // The newest change that left with them is what nothing built before it can be trusted against.
  expect(db.prepare("select seq, floor from activity_rollup_state").get()).toEqual({ seq: 40, floor: 31 });
  expect((db.prepare("select start from activity_slice_changes order by start").all() as Array<{ start: string }>).map((r) => r.start)).toEqual(["2026-03-04T05"]);
  // A slice before the horizon is not kept.
  keepSlices(db, [row("2026-03-02T23", 41)], "2026-03-03T00");
  expect(keptRows(db).some((r) => r.startsWith("2026-03-02"))).toBe(false);
  // A floor already higher stays.
  db.prepare("update activity_rollup_state set floor = 99").run();
  db.prepare("insert into activity_slice_changes (start, seq) values ('2026-03-02T00', 50)").run();
  keepSlices(db, [], "2026-03-03T00");
  expect(db.prepare("select floor from activity_rollup_state").get()).toEqual({ floor: 99 });
});

test("a call keeps the first rows and hands back the rest", () => {
  const { db } = freshLedgerDb();
  const rows = ["2026-03-04T05", "2026-03-04T06", "2026-03-04T07"].map((start) => row(start, 5));
  const rest = keepSlices(db, rows, "0000", 2);
  expect([keptRows(db).length, rest.map((r) => r.start)]).toEqual([2, ["2026-03-04T07"]]);
  expect(keepSlices(db, rest, "0000", 2)).toEqual([]);
  expect(keptRows(db).length).toBe(3);
});
