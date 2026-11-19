import { expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ActivitySummaryResponse } from "../src/shared/api-contracts.js";
import type { Config } from "../src/server/config/types.js";
import { summarizeActivity, type SummaryResult } from "../src/server/modules/activity/activity-summary-away.js";
import { sliceKeeperFor } from "../src/server/modules/activity/slice-keeper.js";
import { buildActivityTestApp } from "./helpers/activity-app.js";
import { freshLedgerDb, HOUR, ledgerCatalog, ledgerProviders, seedCall, seedVaried } from "./helpers/ledger-seed.js";
import { stub } from "./helpers/typed.js";

// The page's answer is read from the hours kept as slices; what an answer
// had to work out is kept once it is sent, for the next one.

const ZONE = "Asia/Singapore";
const deps = { catalog: ledgerCatalog, providers: ledgerProviders };
const keptCount = (db: Database) => (db.prepare("select count(*) n from activity_slices").get() as { n: number }).n;
/** As the page receives it. */
const overTheWire = (summary: SummaryResult) => JSON.parse(JSON.stringify(summary)) as SummaryResult;

function served() {
  const { env, db } = freshLedgerDb();
  seedVaried(db);
  const app = buildActivityTestApp({
    store: env.store,
    priceData: { catalog: () => ledgerCatalog },
    config: stub<Config>({ models: stub<Config["models"]>({ providers: ledgerProviders }) })
  });
  const read = async (query = "days=7&group=purpose") => {
    const { cacheSeal: _cacheSeal, ...summary } = await (await app.request(`/api/activity/summary?${query}&tz=${encodeURIComponent(ZONE)}`)).json() as ActivitySummaryResponse;
    return summary satisfies SummaryResult;
  };
  /** The answer worked out from every call, on this thread. */
  const whole = (days = 7) => overTheWire(summarizeActivity(db, { days, group: "purpose", now: Date.now(), zone: ZONE, day: null }, deps));
  return { db, read, whole, keeper: sliceKeeperFor(db) };
}

test("the page's answer is the one worked out from every call, and what it worked out is kept for the next", async () => {
  const { db, read, whole, keeper } = served();
  expect(await read()).toEqual(whole());
  await keeper.idle();
  // Seven days of whole hours.
  const kept = keptCount(db);
  expect(kept).toBeGreaterThan(24 * 6);
  // The next answer reads them, and has nothing more to keep.
  expect(await read()).toEqual(whole());
  await keeper.idle();
  expect(keptCount(db)).toBe(kept);
  // A call written since shows in the answer after it.
  seedCall(db, { id: "since", t: 30 * HOUR, micros: 77_000 });
  expect(await read()).toEqual(whole());
  // A longer window keeps its older hours too.
  expect(await read("days=30&group=purpose")).toEqual(whole(30));
  await keeper.idle();
  expect(keptCount(db)).toBeGreaterThan(24 * 29);
});

/** What was logged as an error while `run` ran, kept off the test's output. */
async function errorsLogged(run: () => Promise<void>): Promise<string[]> {
  const said = spyOn(console, "error").mockImplementation(() => {});
  try {
    await run();
    return said.mock.calls.map((call) => String(call[0]));
  } finally {
    said.mockRestore();
  }
}

test("turned off, the page answers from every call: nothing kept is read, and nothing more is kept", async () => {
  const { db, read, whole, keeper } = served();
  await read();
  await keeper.idle();
  const kept = keptCount(db);
  // Every kept hour made to look empty, and newer than anything that could put it out of date.
  db.prepare("update activity_slices set facts = (select facts from activity_slices where spend_calls = 0 limit 1), vals = x'', spend_micros = 0, spend_calls = 0, built_seq = 1000000").run();
  expect((await read()).spend.micros).toBe(0);
  const said = await errorsLogged(async () => {
    keeper.off("the answers differ");
    expect(await read()).toEqual(whole());
    await keeper.idle();
  });
  expect((await read()).spend.micros).toBeGreaterThan(0);
  expect(keptCount(db)).toBe(kept);
  expect(db.prepare("select count(*) n from activity_slices where spend_calls > 0").get()).toEqual({ n: 0 });
  expect(said.length).toBe(1);
  expect(said[0]).toContain("the answers differ");
});

test("a kept slice that cannot be read: the page still answers, from every call, and the slices are turned off", async () => {
  const { db, read, whole, keeper } = served();
  await read();
  await keeper.idle();
  db.prepare("update activity_slices set facts = 'not json' where start = (select max(start) from activity_slices where spend_calls > 0)").run();
  const before = db.prepare("select seq, floor from activity_rollup_state where id = 1").get() as { seq: number; floor: number };
  expect(keeper.enabled).toBe(true);
  const said = await errorsLogged(async () => {
    expect(await read()).toEqual(whole());
    expect(keeper.enabled).toBe(false);
    // Nothing kept so far is trusted again.
    expect(db.prepare("select seq, floor from activity_rollup_state where id = 1").get()).toEqual({ seq: before.seq + 1, floor: before.seq + 1 });
    expect(await read()).toEqual(whole());
  });
  // Said once, with what went wrong, however many answers follow.
  expect(said.length).toBe(1);
  expect(said[0]).toMatch(/JSON/);
});
