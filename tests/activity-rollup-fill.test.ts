import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ProviderConfig } from "../src/server/config/types.js";
import { checkedKey, fillActivitySlices, rollupInputs, sliceHorizon, summarizeActivityRolled, type FillResult } from "../src/server/modules/activity/activity-rollup.js";
import { fillActivityAway, summarizeActivity, type FillRequest, type SummaryInput } from "../src/server/modules/activity/activity-summary-away.js";
import { ActivityFill } from "../src/server/modules/activity/slice-fill.js";
import { SliceKeeper } from "../src/server/modules/activity/slice-keeper.js";
import { sliceOf, sliceStartMs } from "../src/server/modules/activity/slice-schema.js";
import { keepSlices, SLICES_KEPT_DAYS } from "../src/server/modules/activity/slice-store.js";
import { BASE, DAY, freshLedgerDb, GPT, HOUR, ledgerCatalog, ledgerDeps, ledgerProviders, MIN, seedCall, seedVaried, seedWake } from "./helpers/ledger-seed.js";
import { statementsRan } from "./helpers/sql-watch.js";

// The slices no answer has asked for yet are worked out ahead: at start what
// is missing, and all of them again when the prices they were worked out
// with change. The first time under new prices, a month's answer from the
// slices is checked against the one from every call.

const deps = ledgerDeps;
const INPUTS = rollupInputs(ledgerCatalog, ledgerProviders);
const now = Date.now();
/** Every whole hour kept: the last 62 days of them. */
const WHOLE = SLICES_KEPT_DAYS * 24;
const month = (at = now): SummaryInput => ({ days: 30, group: "purpose", now: at, zone: "UTC", day: null });
const scratch = (db: Database, at = now) => JSON.stringify(summarizeActivity(db, month(at), deps));
/** The build these tests run as: a check noted under another is owed again. */
const BUILD = "build-a";
const KEY = checkedKey(INPUTS, BUILD);
const fill = (db: Database, inputs = INPUTS, at = now, build = BUILD) => fillActivitySlices(db, { now: at, checked: checkedKey(inputs, build) }, deps, inputs);
const keepAll = (db: Database, rows: FillResult["built"]) => keepSlices(db, rows, "0000");
const checked = (db: Database) => (db.prepare("select checked from activity_rollup_state where id = 1").get() as { checked: string | null }).checked;
const markChecked = (db: Database, inputs: string | null) => db.prepare("update activity_rollup_state set checked = ? where id = 1").run(inputs);
const keptCount = (db: Database) => (db.prepare("select count(*) n from activity_slices").get() as { n: number }).n;

/** The varied calls of two days ago, three weeks of calls before them, and
 *  one from before anything is kept. */
function store(): Database {
  const { db } = freshLedgerDb();
  seedVaried(db);
  for (let day = 1; day <= 21; day += 1) {
    seedWake(db, `w-day-${day}`, "t-manager", day % 3 ? "user" : "sweep");
    for (let k = 0; k < 4; k += 1) {
      seedCall(db, {
        id: `d${day}-${k}`, t: -day * DAY + k * 5 * HOUR + k * 7 * MIN, scopeId: k % 2 ? "t-global" : "t-manager", model: k === 2 ? GPT : undefined,
        read: k ? 80_000 : 0, write: k ? 5_000 : 100_000, micros: 40_000 + 1_000 * day + 10 * k, latencyMs: 900 + 130 * k,
        ...(k === 3 ? { status: "failed", source: null, micros: null } : {}),
        metadata: { wakeId: `w-day-${day}` }
      });
    }
  }
  db.prepare("update llm_calls set error_json = ? where id like 'd%-3'").run(JSON.stringify({ message: "Too Many Requests" }));
  seedCall(db, { id: "long-ago", t: -70 * DAY, micros: 900_000 });
  return db;
}

test("a first fill works out every hour kept, and finds the month's answer from them the calls' own", () => {
  const db = store();
  const total = (db.prepare("select count(*) n from llm_calls").get() as { n: number }).n;
  const { result: first, ran } = statementsRan(db, /from llm_calls l\b/, () => fill(db));
  // The check reads the month's calls whole once, for the answer from every
  // call; the answer from the slices is merged from the ones just worked out.
  expect(ran.filter((run) => Array.isArray(run.result) && run.result.length > total / 2).length).toBe(1);
  expect(first.built.length).toBe(WHOLE);
  expect(new Set(first.built.map((row) => row.start)).size).toBe(WHOLE);
  expect(first.compared).toEqual({ same: true, where: null });
  // Kept, a month's answer has no whole hour left to read.
  keepAll(db, first.built);
  const answer = summarizeActivityRolled(db, month(), deps, INPUTS);
  expect(answer.built).toEqual([]);
  expect(JSON.stringify(answer.result)).toBe(scratch(db));
});

// An ordinary start: the slices are in the database, and were checked.
test("with every hour kept and checked a fill has nothing to do, and reads no call", () => {
  const db = store();
  keepAll(db, fill(db).built);
  markChecked(db, KEY);
  const { result, ran } = statementsRan(db, /from llm_calls\b/, () => fill(db));
  expect(result).toEqual({ built: [], compared: null });
  expect(ran).toEqual([]);
});

test("a start some hours later works out those hours only", () => {
  const db = store();
  keepAll(db, fill(db).built);
  markChecked(db, KEY);
  const later = fill(db, INPUTS, now + 3 * HOUR);
  expect(later.built.length).toBe(3);
  expect(later.compared).toBeNull();
});

test("a call changed in a kept hour: the next fill works out that hour and every one after it", () => {
  const db = store();
  keepAll(db, fill(db).built);
  markChecked(db, KEY);
  db.prepare("update llm_calls set cost_micros = cost_micros + 1 where id = 'd3-1'").run();
  const { created_at: changedAt } = db.prepare("select created_at from llm_calls where id = 'd3-1'").get() as { created_at: string };
  const again = fill(db);
  const starts = again.built.map((row) => row.start).sort();
  expect(starts[0]).toBe(sliceOf(changedAt));
  expect(starts.length).toBe((Math.floor(now / HOUR) * HOUR - sliceStartMs(sliceOf(changedAt))) / HOUR);
  expect(again.compared).toBeNull();
  // Kept, they are the calls' own again.
  keepAll(db, again.built);
  expect(JSON.stringify(summarizeActivityRolled(db, month(), deps, INPUTS).result)).toBe(scratch(db));
  expect(fill(db).built).toEqual([]);
});

// A page opened before the fill ran kept its window's hours already: the
// fill works out the rest, and the check is still owed.
test("hours an answer kept before the fill are not worked out again; the check is still made", () => {
  const db = store();
  const answered = summarizeActivityRolled(db, { ...month(), days: 90 }, deps, INPUTS).built;
  expect(answered.length).toBe(WHOLE);
  keepAll(db, answered);
  expect(fill(db)).toEqual({ built: [], compared: { same: true, where: null } });
});

// A slice is worked out by the code as well as from its calls: another
// build may work it out otherwise, and the prices say nothing of that.
test("a new build checks again what an older one checked, and works out nothing", () => {
  const db = store();
  keepAll(db, fill(db).built);
  markChecked(db, KEY);
  expect(fill(db)).toEqual({ built: [], compared: null });
  expect(fill(db, INPUTS, now, "build-b")).toEqual({ built: [], compared: { same: true, where: null } });
});

test("hours the code before worked out otherwise are found at a new build's first fill", () => {
  const db = store();
  keepAll(db, fill(db).built);
  markChecked(db, KEY);
  // What another version of the code would have kept: an hour with spend, as if empty.
  db.prepare(`update activity_slices set facts = (select facts from activity_slices where spend_calls = 0 limit 1), vals = x'', spend_micros = 0, spend_calls = 0
    where start = (select max(start) from activity_slices where spend_calls > 0)`).run();
  expect(fill(db).compared).toBeNull();
  expect(fill(db, INPUTS, now, "build-b").compared?.same).toBe(false);
});

test("under other prices every hour is worked out again, and checked again", () => {
  const db = store();
  keepAll(db, fill(db).built);
  markChecked(db, KEY);
  const again = fill(db, "other-inputs");
  expect(again.built.length).toBe(WHOLE);
  expect(again.built.every((row) => row.inputs === "other-inputs")).toBe(true);
  expect(again.compared).toEqual({ same: true, where: null });
});

/** The value at a path as the check names one: `spend.micros`, `groups[2].calls`. */
function valueAt(value: unknown, path: string): unknown {
  let at = value;
  for (const step of path.match(/[^.[\]]+/g) ?? []) at = (at as Record<string, unknown> | undefined)?.[step];
  return at;
}

test("a kept slice that is wrong shows in the check, which names where the answers part", () => {
  const db = store();
  keepAll(db, summarizeActivityRolled(db, month(), deps, INPUTS).built);
  // An hour with spend made to look empty, and still valid.
  db.prepare(`update activity_slices set facts = (select facts from activity_slices where spend_calls = 0 limit 1), vals = x'', spend_micros = 0, spend_calls = 0
    where start = (select max(start) from activity_slices where spend_calls > 0)`).run();
  const { built, compared } = fill(db);
  expect(built.length).toBeGreaterThan(0);
  expect(compared?.same).toBe(false);
  const where = compared!.where!;
  const wrong = JSON.parse(JSON.stringify(summarizeActivityRolled(db, month(), deps, INPUTS, built).result)) as unknown;
  const right = JSON.parse(scratch(db)) as unknown;
  // A place in the answer, where the two do differ.
  expect(valueAt(right, where)).not.toBeUndefined();
  expect(valueAt(wrong, where)).not.toEqual(valueAt(right, where));
});

test("a fill reads the calls a week at a time", () => {
  const db = store();
  // Calls on the last millisecond of one week's read and the first of the next.
  const edge = sliceStartMs(sliceHorizon(now)) + 7 * 7 * DAY;
  seedCall(db, { id: "week-end", t: edge - 1 - BASE, micros: 31_000 });
  seedCall(db, { id: "week-start", t: edge - BASE, scopeId: "t-global", micros: 47_000 });
  markChecked(db, KEY);
  const total = (db.prepare("select count(*) n from llm_calls").get() as { n: number }).n;
  const { result, ran } = statementsRan(db, /from llm_calls l\b/, () => fill(db));
  const reads = ran.map((run) => (Array.isArray(run.result) ? run.result.length : 0)).filter((rows) => rows > 0);
  // Three weeks of calls and the varied day: no read hands back most of them.
  expect(reads.length).toBeGreaterThanOrEqual(3);
  expect(Math.max(...reads)).toBeLessThan(total / 2);
  // And what the weeks give together is what one read of the whole would.
  keepAll(db, result.built);
  // Each of the two is in its own hour's slice, with whatever else that hour holds.
  for (const [id, at] of [["week-end", edge - 1], ["week-start", edge]] as const) {
    const hour = sliceOf(new Date(at).toISOString());
    const spent = db.prepare("select coalesce(sum(cost_micros), 0) micros, count(*) calls, coalesce(sum(id = ?), 0) own from llm_calls where substr(created_at, 1, 13) = ? and cost_source = 'list'").get(id, hour);
    expect(spent).toMatchObject({ own: 1 });
    expect(db.prepare("select spend_micros micros, spend_calls calls, 1 own from activity_slices where start = ?").get(hour), id).toEqual(spent);
  }
  expect(JSON.stringify(summarizeActivityRolled(db, month(), deps, INPUTS).result)).toBe(scratch(db));
});

test("the fill worked out on its own thread is the one this thread works out", async () => {
  const db = store();
  const away = await fillActivityAway({ dbPath: db.filename, providers: ledgerProviders, prices: ledgerCatalog.sources(), inputs: INPUTS, checked: KEY, now });
  const here = fill(db);
  expect(away.compared).toEqual({ same: true, where: null });
  expect(away.built.map((row) => [row.start, row.builtSeq, row.inputs, row.facts])).toEqual(here.built.map((row) => [row.start, row.builtSeq, row.inputs, row.facts]));
  expect(away.built.every((row) => row.vals instanceof Uint8Array)).toBe(true);
});

// ---- When a fill runs.

const OTHER: Record<string, ProviderConfig> = { gw: { type: "openai-compatible", baseURL: "https://gw.example.test/v1", apiKey: "", billing: "free", models: [] } };

function filler(db: Database, run?: (request: FillRequest) => Promise<FillResult>, build = BUILD) {
  const asked: FillRequest[] = [];
  const said: string[] = [];
  const settings = { idle: true, providers: ledgerProviders };
  const keeper = new SliceKeeper(db, { log: (message) => said.push(message) });
  const filling = new ActivityFill({
    db, keeper,
    catalog: () => ledgerCatalog,
    providers: () => settings.providers,
    pricingIdle: () => settings.idle,
    now: () => now,
    build,
    log: (message) => said.push(message),
    fill: (request) => {
      asked.push(request);
      return run ? run(request) : Promise.resolve(fillActivitySlices(db, { now: request.now, checked: request.checked }, { catalog: ledgerCatalog, providers: request.providers }, request.inputs));
    }
  });
  /** A check, and whatever it started done and kept. */
  const check = async () => {
    filling.check();
    await filling.settled();
    await keeper.idle();
  };
  return { filling, keeper, asked, said, settings, check };
}

test("a fill runs at the first check, keeps what it worked out, and notes the check made", async () => {
  const db = store();
  const { asked, check, said } = filler(db);
  await check();
  expect(asked.map((request) => request.inputs)).toEqual([INPUTS]);
  expect(asked[0]!.dbPath).toBe(db.filename);
  expect([keptCount(db), checked(db)]).toEqual([WHOLE, KEY]);
  // Filled under these settings: nothing more to ask.
  await check();
  await check();
  expect(asked.length).toBe(1);
  expect(said).toEqual([]);
});

test("after a restart the fill is asked once more, and has nothing to check", async () => {
  const db = store();
  const before = filler(db);
  await before.check();
  await before.check();
  const results: FillResult[] = [];
  const after = filler(db, async (request) => {
    const result = fillActivitySlices(db, { now: request.now, checked: request.checked }, deps, request.inputs);
    results.push(result);
    return result;
  });
  await after.check();
  await after.check();
  expect(results).toEqual([{ built: [], compared: null }]);
});

test("after a restart into a new build the fill checks once, and works out nothing", async () => {
  const db = store();
  const before = filler(db);
  await before.check();
  const results: FillResult[] = [];
  const after = filler(db, async (request) => {
    const result = fillActivitySlices(db, { now: request.now, checked: request.checked }, deps, request.inputs);
    results.push(result);
    return result;
  }, "build-b");
  await after.check();
  await after.check();
  expect(results).toEqual([{ built: [], compared: { same: true, where: null } }]);
  expect(checked(db)).toBe(checkedKey(INPUTS, "build-b"));
});

test("no fill while calls are being priced again", async () => {
  const db = store();
  const { asked, check, settings } = filler(db);
  settings.idle = false;
  await check();
  await check();
  await check();
  expect(asked).toEqual([]);
  settings.idle = true;
  await check();
  expect(asked.length).toBe(1);
});

// The pricing pass says when it has looked at changed settings and written
// what they change into the calls: the fill waits for that, however soon
// after the change the check comes.
test("changed price settings fill again, once the pricing pass is done with them", async () => {
  const db = store();
  const { asked, check, settings } = filler(db);
  await check();
  settings.providers = OTHER;
  settings.idle = false;
  await check();
  await check();
  expect(asked.length).toBe(1);
  settings.idle = true;
  await check();
  expect(asked.map((request) => request.inputs)).toEqual([INPUTS, rollupInputs(ledgerCatalog, OTHER)]);
  expect(asked[1]!.providers).toBe(OTHER);
  expect(checked(db)).toBe(checkedKey(rollupInputs(ledgerCatalog, OTHER), BUILD));
  expect((db.prepare("select count(*) n from activity_slices where inputs = ?").get(rollupInputs(ledgerCatalog, OTHER)) as { n: number }).n).toBe(WHOLE);
});

test("one fill at a time", async () => {
  const db = store();
  let finish!: (result: FillResult) => void;
  const { filling, asked } = filler(db, () => new Promise((resolve) => { finish = resolve; }));
  filling.check();
  filling.check();
  filling.check();
  expect(asked.length).toBe(1);
  finish({ built: [], compared: null });
  await filling.settled();
  filling.check();
  expect(asked.length).toBe(1);
});

test("a check that finds the answers apart turns the slices off, says where, and keeps nothing", async () => {
  const db = store();
  const { check, keeper, said, asked } = filler(db, async (request) => ({
    built: fillActivitySlices(db, { now: request.now, checked: request.checked }, deps, request.inputs).built,
    compared: { same: false, where: "ledger.tokens.input" }
  }));
  await check();
  await check();
  expect(keeper.enabled).toBe(false);
  expect([keptCount(db), checked(db)]).toEqual([0, null]);
  expect(said.length).toBe(1);
  expect(said[0]).toContain("ledger.tokens.input");
  // Off until the next start: no more fills.
  await check();
  await check();
  expect(asked.length).toBe(1);
});

test("turned off, nothing is worked out ahead", async () => {
  const db = store();
  const { keeper, check, asked } = filler(db);
  keeper.off("the answers differ");
  await check();
  await check();
  await check();
  expect(asked).toEqual([]);
});

test("turned off, the check owed is owed again at the next start", async () => {
  const db = store();
  const first = filler(db);
  await first.check();
  await first.check();
  expect(checked(db)).toBe(KEY);
  first.keeper.off("the answers differ");
  expect(checked(db)).toBeNull();
  // The next start: every hour again (the floor), and the check with it.
  const results: FillResult[] = [];
  const next = filler(db, async (request) => {
    const result = fillActivitySlices(db, { now: request.now, checked: request.checked }, deps, request.inputs);
    results.push(result);
    return result;
  });
  await next.check();
  await next.check();
  expect(results.map((result) => [result.built.length, result.compared])).toEqual([[WHOLE, { same: true, where: null }]]);
});

test("a fill that fails is said once and left until the settings change", async () => {
  const db = store();
  const { check, keeper, said, asked, settings } = filler(db, () => Promise.reject(new Error("unable to open database file")));
  await check();
  await check();
  await check();
  await check();
  expect(asked.length).toBe(1);
  expect(said.length).toBe(1);
  expect(said[0]).toContain("unable to open database file");
  // The answers go on reading and keeping slices of their own.
  expect(keeper.enabled).toBe(true);
  settings.providers = OTHER;
  await check();
  await check();
  expect(asked.length).toBe(2);
});

// The check runs on a timer of the server's: nothing it meets may be thrown there.
test("a check that cannot read the settings is said, not thrown", async () => {
  const db = store();
  const said: string[] = [];
  const filling = new ActivityFill({
    db, keeper: new SliceKeeper(db, { log: (message) => said.push(message) }),
    catalog: () => { throw new Error("the price data is unreadable"); },
    providers: () => ledgerProviders,
    pricingIdle: () => true,
    log: (message) => said.push(message),
    fill: () => Promise.reject(new Error("never asked"))
  });
  filling.check();
  await filling.settled();
  expect(said.length).toBe(1);
  expect(said[0]).toContain("the price data is unreadable");
});
