import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { ACTIVITY_GROUP_KEYS } from "../src/shared/api/activity.js";
import { rollupInputs, summarizeActivityRolled } from "../src/server/modules/activity/activity-rollup.js";
import { summarizeActivity, type SummaryInput } from "../src/server/modules/activity/activity-summary-away.js";
import { activityRange } from "../src/server/modules/activity/local-days.js";
import { sliceOf } from "../src/server/modules/activity/slice-schema.js";
import { keepSlices } from "../src/server/modules/activity/slice-store.js";
import { createPriceCatalog } from "../src/server/modules/pricing/catalog.js";
import { BASE, DAY, freshLedgerDb, GPT, HOUR, ledgerCatalog, ledgerDeps, ledgerProviders, MIN, seedCall, seedVaried, seedWake } from "./helpers/ledger-seed.js";
import { statementsRan } from "./helpers/sql-watch.js";

// The Overview's answer merged from kept slices and what is new is the
// answer worked out from every call, whatever is kept and whatever has
// changed since.

const deps = ledgerDeps;
const INPUTS = rollupInputs(ledgerCatalog, ledgerProviders);
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({ days: 30, group: "purpose", now, zone: "Asia/Singapore", day: null, ...over });
const scratch = (db: Database, over: Partial<SummaryInput> = {}) => JSON.stringify(summarizeActivity(db, input(over), deps));
const rolled = (db: Database, over: Partial<SummaryInput> = {}, inputs = INPUTS) => {
  const answer = summarizeActivityRolled(db, input(over), deps, inputs);
  return { json: JSON.stringify(answer.result), built: answer.built };
};
const keep = (db: Database, over: Partial<SummaryInput> = {}) => keepSlices(db, rolled(db, over).built, "0000");
const keptCount = (db: Database) => (db.prepare("select count(*) n from activity_slices").get() as { n: number }).n;
/** How many calls the window's read handed back while `run` ran. */
function callsRead(db: Database, run: () => unknown): number {
  return statementsRan(db, /from llm_calls l\b/, run).ran.reduce((sum, r) => sum + (Array.isArray(r.result) ? r.result.length : 0), 0);
}

/** The varied calls of two days ago, and ten days of calls before them:
 *  steps of two threads in wakes of their own, a failure a day, a reported
 *  amount a day, a compaction on some. */
function store(): Database {
  const { db } = freshLedgerDb();
  seedVaried(db);
  for (let day = 1; day <= 10; day += 1) {
    seedWake(db, `w-day-${day}`, "t-manager", day % 3 ? "user" : "sweep");
    for (let k = 0; k < 6; k += 1) {
      const t = -day * DAY + k * 3 * HOUR + k * 7 * MIN;
      seedCall(db, {
        id: `d${day}-${k}`, t, scopeId: k % 2 ? "t-global" : "t-manager", model: k % 3 === 2 ? GPT : undefined,
        read: k ? 80_000 : 0, write: k ? 5_000 : 100_000, output: 500 + 40 * k, latencyMs: 900 + 130 * k, micros: 40_000 + 1_000 * day + 10 * k,
        ...(k === 4 ? { source: "reported" as const } : {}),
        ...(k === 5 ? { status: "failed", source: null, micros: null } : {}),
        metadata: { wakeId: `w-day-${day}`, ...(k === 3 ? { fallbackAttempt: true } : {}) }
      });
    }
    if (day % 4 === 0) seedCall(db, { id: `d${day}-c`, t: -day * DAY + 4 * HOUR, purpose: "agent_compression", write: 20_000 });
  }
  // Dream runs that left no calls: one on an old day, one today.
  for (const [id, at] of [["dr-old", BASE - 5 * DAY + 5 * HOUR], ["dr-today", now - 30 * MIN]] as const) {
    db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at) values (?, 'schedule', 'failed', 'user', ?)").run(id, iso(at));
  }
  db.prepare("update llm_calls set error_json = ? where id like 'd%-5'").run(JSON.stringify({ message: "Too Many Requests" }));
  db.prepare("update llm_calls set ttft_ms = 200 + (rowid % 7) * 35 where id like 'd%'").run();
  return db;
}

const WINDOWS: Array<Partial<SummaryInput>> = [
  { days: 1 }, { days: 7 }, { days: 30 }, { days: 90 },
  { days: 30, day: activityRange(input()).clock.dayOf(iso(BASE - 5 * DAY + 4 * HOUR)) },
  { days: 30, day: activityRange(input()).clock.dayOf(iso(now - DAY)) },
  { days: 30, day: activityRange(input()).clock.dayOf(iso(now)) }
];

test("with nothing kept the answer is the one worked out from every call, and every whole slice comes back to keep", () => {
  const db = store();
  for (const window of WINDOWS) {
    for (const group of ACTIVITY_GROUP_KEYS) {
      expect(rolled(db, { ...window, group }).json, JSON.stringify({ ...window, group })).toBe(scratch(db, { ...window, group }));
    }
  }
  const { built } = rolled(db, { days: 7 });
  const range = activityRange(input({ days: 7 }));
  // Every hour that starts inside the window and has ended, empty ones too.
  const whole = Math.floor(now / HOUR) - Math.floor(Date.parse(range.since) / HOUR) - 1;
  expect(built.length).toBe(whole);
  expect(built.every((row) => row.inputs === INPUTS)).toBe(true);
  expect(built.filter((row) => row.spendCalls > 0).length).toBeGreaterThan(10);
});

// Today picked: the window ends at the next midnight, and the hour under way is in it.
test("a picked today hands back nothing of the hour under way or the hours ahead", () => {
  const db = store();
  seedCall(db, { id: "just-now", t: now - BASE - 2 * MIN, micros: 12_000 });
  const today = { day: activityRange(input()).clock.dayOf(iso(now)) };
  const first = rolled(db, today);
  expect(first.json).toBe(scratch(db, today));
  // Whatever of today is over (nothing, just after midnight) is whole; the rest is not.
  expect(first.built.filter((row) => row.start >= sliceOf(iso(now))).map((row) => row.start)).toEqual([]);
  keepSlices(db, first.built, "0000");
  expect(rolled(db, today).json).toBe(scratch(db, today));
});

test("with the slices kept the answer is the same, and their calls are not read again", () => {
  const db = store();
  keep(db);
  expect(keptCount(db)).toBeGreaterThan(24 * 29);
  for (const window of WINDOWS) {
    for (const group of ACTIVITY_GROUP_KEYS) {
      expect(rolled(db, { ...window, group }).json, JSON.stringify({ ...window, group })).toBe(scratch(db, { ...window, group }));
    }
  }
  // A 30-day answer reads the two ends only: the hour the window is cut in, and the hour under way.
  const range = activityRange(input());
  const ends = (db.prepare("select count(*) n from llm_calls where (created_at > ? and created_at < ?) or created_at >= ?")
    .get(range.since, `${sliceOf(iso(Date.parse(range.since) + HOUR))}:00:00.000Z`, `${sliceOf(iso(now))}:00:00.000Z`) as { n: number }).n;
  expect(callsRead(db, () => rolled(db))).toBe(ends);
  // And nothing more to keep.
  expect(rolled(db).built).toEqual([]);
});

test("a call that changes in a kept slice shows in the next answer; only that slice and later ones are read", () => {
  const db = store();
  keep(db);
  const all = (db.prepare("select count(*) n from llm_calls where created_at > ?").get(activityRange(input()).since) as { n: number }).n;
  // A call of five days back finishes with other numbers.
  db.prepare("update llm_calls set latency_ms = 77000, output_tokens = 9000, cost_micros = 999000 where id = 'd5-2'").run();
  const after = (db.prepare("select count(*) n from llm_calls where created_at >= (select substr(created_at, 1, 13) from llm_calls where id = 'd5-2')").get() as { n: number }).n;
  expect(after).toBeLessThan(all);
  let json = "";
  expect(callsRead(db, () => { json = rolled(db).json; })).toBe(after);
  expect(json).toBe(scratch(db));
  for (const group of ACTIVITY_GROUP_KEYS) expect(rolled(db, { group }).json).toBe(scratch(db, { group }));
  // Kept again, the answer reads the ends alone once more.
  keep(db);
  expect(callsRead(db, () => rolled(db))).toBeLessThan(10);
});

test("a call written with an old date into a kept slice, and one deleted from it, show in the next answer", () => {
  const db = store();
  keep(db);
  seedCall(db, { id: "imported", t: -6 * DAY + 2 * HOUR, micros: 123_456, read: 0, write: 100_000, metadata: { wakeId: "w-day-6" } });
  expect(rolled(db).json).toBe(scratch(db));
  keep(db);
  db.prepare("delete from llm_calls where id = 'imported'").run();
  expect(rolled(db).json).toBe(scratch(db));
  expect(rolled(db, { days: 7, group: "model" }).json).toBe(scratch(db, { days: 7, group: "model" }));
});

test("a change that lands between an answer and its keeping is not lost", () => {
  const db = store();
  const first = rolled(db);
  db.prepare("update llm_calls set cost_micros = 5 where id = 'd3-1'").run();
  keepSlices(db, first.built, "0000");
  expect(rolled(db).json).toBe(scratch(db));
});

test("slices kept under other prices or another layout are worked out again", () => {
  const db = store();
  keep(db);
  const other = rollupInputs(createPriceCatalog({ litellm: { date: "2026-01-03", entries: Object.assign(Object.create(null), { "gpt-test": { provider: "openai", rates: { base: { input: 3, output: 12 } } } }) }, modelsDev: null }), ledgerProviders);
  expect(other).not.toBe(INPUTS);
  const all = (db.prepare("select count(*) n from llm_calls where created_at > ?").get(activityRange(input()).since) as { n: number }).n;
  expect(callsRead(db, () => rolled(db, {}, other))).toBe(all);
  // Without a price list, another key again.
  expect(rollupInputs(null, ledgerProviders)).not.toBe(INPUTS);
  // The same lists and settings name the same inputs.
  expect(rollupInputs(ledgerCatalog, { ...ledgerProviders })).toBe(INPUTS);
});

test("a reader whose days do not start on the hour is answered from every call, and no slice is used or made", () => {
  const db = store();
  keep(db);
  for (const zone of ["Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns"]) {
    const { ran } = statementsRan(db, /activity_slices/, () => {
      const answer = rolled(db, { zone });
      expect(answer.json, zone).toBe(scratch(db, { zone }));
      expect(answer.built, zone).toEqual([]);
    });
    expect(ran, zone).toEqual([]);
  }
  // Zones a whole number of hours off are served, with or without summer time.
  for (const zone of ["UTC", "America/New_York", "Europe/Berlin", null]) {
    expect(rolled(db, { zone }).json, String(zone)).toBe(scratch(db, { zone }));
    expect(callsRead(db, () => rolled(db, { zone })), String(zone)).toBeLessThan(10);
  }
});

// Summer time ends and starts on fixed dates: windows pinned across each,
// rather than crossing one only when the suite runs near a change.
test("windows across a clock change, either way, are answered from the slices as from every call", () => {
  const offsetAt = (zone: string, ms: number) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")!.value;
  for (const nowIso of ["2026-11-03T15:00:00.000Z", "2026-04-02T15:00:00.000Z"]) {
    const fixed = Date.parse(nowIso);
    const { db } = freshLedgerDb();
    for (let h = 1; h < 31 * 24; h += 5) seedCall(db, { id: `x-${h}`, t: fixed - h * HOUR - 7 * MIN - BASE, micros: 10_000 + h });
    for (const zone of ["America/New_York", "Europe/Berlin"]) {
      // The 30 days do cross a change in this zone.
      expect(offsetAt(zone, fixed - 30 * DAY), `${nowIso} ${zone}`).not.toBe(offsetAt(zone, fixed));
      const at = { zone, now: fixed };
      keep(db, { ...at, days: 30 });
      for (const days of [1, 7, 30]) expect(rolled(db, { ...at, days }).json, `${nowIso} ${zone} ${days}`).toBe(scratch(db, { ...at, days }));
      expect(callsRead(db, () => rolled(db, { ...at, days: 30 })), `${nowIso} ${zone}`).toBeLessThan(10);
    }
  }
});

test("the period before is read from the kept slices' spend, not from its calls", () => {
  const db = store();
  keep(db);
  const whole = scratch(db, { days: 7 });
  const { ran } = statementsRan(db, /sum\(cost_micros\)/, () => expect(rolled(db, { days: 7 }).json).toBe(whole));
  // Its two ends are summed from the calls, each within an hour.
  expect(ran.length).toBeLessThanOrEqual(2);
  for (const r of ran) expect(Date.parse(r.params[1] as string) - Date.parse(r.params[0] as string)).toBeLessThanOrEqual(HOUR);
  expect(JSON.parse(whole).ledger.previousSpendMicros).toBeGreaterThan(0);
});

test("an empty store, and one whose calls are all in the hour under way", () => {
  const { db } = freshLedgerDb();
  expect(rolled(db).json).toBe(scratch(db));
  keep(db);
  expect(rolled(db).json).toBe(scratch(db));
  const { db: live } = freshLedgerDb();
  seedCall(live, { id: "just-now", t: now - BASE - 1_000 });
  expect(rolled(live).json).toBe(scratch(live));
  keep(live);
  expect(rolled(live, { days: 1 }).json).toBe(scratch(live, { days: 1 }));
});

// A Claude model's ratio is read from its first call's rates: slices merge
// oldest first, kept or just read.
test("what depends on which call came first is read oldest first, across kept slices", () => {
  const tiered = createPriceCatalog({
    litellm: {
      date: "2026-01-02",
      entries: Object.assign(Object.create(null), {
        "claude-tier-test": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, tiers: [{ above: 200_000, rates: { input: 8, output: 30, cacheRead: 0.5 } }] } }
      })
    },
    modelsDev: null
  });
  const tierDeps = { catalog: tiered, providers: ledgerProviders };
  const tierInputs = rollupInputs(tiered, ledgerProviders);
  const ref = JSON.stringify({ origin: "litellm", providerId: "anthropic", providerName: "anthropic", modelId: "claude-tier-test", dataDate: "2026-01-02" });
  for (const [firstInput, ratio] of [[100_000, 25], [300_000, 10]] as const) {
    const { db } = freshLedgerDb();
    seedCall(db, { id: "a", t: -3 * DAY, model: "anthropic/claude-tier-test", ref, input: firstInput, micros: 300_000 });
    seedCall(db, { id: "b", scopeId: "t-global", t: -DAY, model: "anthropic/claude-tier-test", ref, input: firstInput === 100_000 ? 300_000 : 100_000, micros: 300_000 });
    const whole = summarizeActivity(db, input(), tierDeps);
    expect(whole.ledger.claudeWriteReadRatio, `first call of ${firstInput} tokens`).toBe(ratio);
    const first = summarizeActivityRolled(db, input(), tierDeps, tierInputs);
    expect(JSON.stringify(first.result)).toBe(JSON.stringify(whole));
    keepSlices(db, first.built, "0000");
    expect(JSON.stringify(summarizeActivityRolled(db, input(), tierDeps, tierInputs).result)).toBe(JSON.stringify(whole));
  }
});

test("slices older than what is kept are not handed back", () => {
  const db = store();
  seedCall(db, { id: "long-ago", t: -80 * DAY });
  const { json, built } = rolled(db, { days: 90 });
  expect(json).toBe(scratch(db, { days: 90 }));
  const horizon = sliceOf(iso(now - 62 * DAY));
  expect(built.length).toBeGreaterThan(0);
  expect(built.every((row) => row.start >= horizon)).toBe(true);
});
