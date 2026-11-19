import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ACTIVITY_GROUP_KEYS } from "../src/shared/api/activity.js";
import { buildActivitySummary } from "../src/server/modules/activity/activity-summary.js";
import { summarizeActivity, summarizeActivityAway } from "../src/server/modules/activity/activity-summary-away.js";
import { buildActivityLedger } from "../src/server/modules/activity/ledger-summary.js";
import { activityRange } from "../src/server/modules/activity/local-days.js";
import { freshLedgerDb, HOUR, ledgerCatalog, ledgerProviders, MIN, seedCall, seedSteady, seedVaried } from "./helpers/ledger-seed.js";
import { answerSummary, rollupInputs } from "../src/server/modules/activity/activity-rollup.js";
import { keepSlices } from "../src/server/modules/activity/slice-store.js";
import { statementsRan, watchStatements } from "./helpers/sql-watch.js";

// Opening Activity worked out the whole window from every stored call on the
// server's one thread, long enough to feel with a month of calls, while every request,
// terminal and agent waited. It is worked out on a thread of its own now,
// from the same database and the price list in use.

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

function seeded() {
  const ledger = freshLedgerDb();
  seedSteady(ledger.db);
  return ledger;
}

const request = { days: 7, group: "purpose" as const, now: Date.now(), zone: "Asia/Singapore", day: null };

test("the summary worked out on its own thread is the one the main thread would have worked out, priced with the list in use", async () => {
  const { db } = seeded();
  const away = await summarizeActivityAway({ ...request, dbPath: db.filename, providers: ledgerProviders, prices: ledgerCatalog.sources(), inputs: null });
  expect(json(away.result)).toEqual(json(summarizeActivity(db, request, { catalog: ledgerCatalog, providers: ledgerProviders })));
  // Without the list the token split differs: the worker priced with it.
  expect(json(away.result)).not.toEqual(json(summarizeActivity(db, request, { catalog: null, providers: ledgerProviders })));
  // Asked from every call, it has no slice to keep.
  expect([away.built, away.fellBack]).toEqual([[], null]);
});

test("the main thread goes on while the summary is worked out", async () => {
  const { db } = seeded();
  const order: string[] = [];
  setTimeout(() => order.push("main thread"), 0);
  await summarizeActivityAway({ ...request, dbPath: db.filename, providers: ledgerProviders, prices: null, inputs: null }).then(() => order.push("summary"));
  expect(order).toEqual(["main thread", "summary"]);
});

test("a database the worker cannot open is an error, not a page that waits", async () => {
  const { env } = seeded();
  const missing = `${env.dir}/no-such-dir/mandate.db`;
  await expect(summarizeActivityAway({ ...request, dbPath: missing, providers: ledgerProviders, prices: null, inputs: null })).rejects.toThrow(/unable to open/);
});

// Given the inputs in use, the worker answers from the kept slices and what
// is new, and hands back the slices it worked out for the server to keep.
test("the worker answers from the slices, and hands back what it worked out to keep", async () => {
  const { db } = varied();
  const inputs = rollupInputs(ledgerCatalog, ledgerProviders);
  const ask = () => summarizeActivityAway({ ...request, dbPath: db.filename, providers: ledgerProviders, prices: ledgerCatalog.sources(), inputs });
  const whole = json(summarizeActivity(db, request, { catalog: ledgerCatalog, providers: ledgerProviders }));
  const first = await ask();
  expect(json(first.result)).toEqual(whole);
  expect(first.fellBack).toBeNull();
  // Seven days of hours, every one of them, as rows the server can keep as they are.
  expect(first.built.length).toBeGreaterThan(24 * 6);
  expect(first.built.every((row) => row.inputs === inputs && row.vals instanceof Uint8Array && typeof row.facts === "string")).toBe(true);
  keepSlices(db, first.built, "0000");
  const second = await ask();
  expect(json(second.result)).toEqual(whole);
  expect(second.built).toEqual([]);
});

test("a kept slice that cannot be read answers from every call, and says why", async () => {
  const { db } = varied();
  const inputs = rollupInputs(ledgerCatalog, ledgerProviders);
  const first = await summarizeActivityAway({ ...request, dbPath: db.filename, providers: ledgerProviders, prices: ledgerCatalog.sources(), inputs });
  keepSlices(db, first.built, "0000");
  db.prepare("update activity_slices set facts = '{\"tuples\": [' where start = (select max(start) from activity_slices where spend_calls > 0)").run();
  const away = await summarizeActivityAway({ ...request, dbPath: db.filename, providers: ledgerProviders, prices: ledgerCatalog.sources(), inputs });
  expect(json(away.result)).toEqual(json(summarizeActivity(db, request, { catalog: ledgerCatalog, providers: ledgerProviders })));
  expect(away.built).toEqual([]);
  expect(away.fellBack).toMatch(/JSON/);
});

// The worker reads beside the server, which goes on writing calls (agents,
// the pricing pass). Every read of one answer sees the same calls.
test.each([["from every call", null], ["from the slices", rollupInputs(ledgerCatalog, ledgerProviders)]])("every read of a summary worked out %s sees one snapshot, whatever the server writes between them", (_name, inputs) => {
  const { db } = seeded();
  const fail = (id: string) => db.prepare("update llm_calls set status = 'failed', error_json = ? where id = ?").run(JSON.stringify({ message: "Service Unavailable" }), id);
  fail("m-3");
  const reader = new Database(db.filename, { readonly: true });
  let wrote = false;
  // A failed call lands once the window's calls are read, before the
  // failures' reasons are.
  watchStatements(reader, undefined, (sql) => {
    if (!wrote && /status = 'failed'/.test(sql)) {
      wrote = true;
      // At the failed call's own time and of its kind: its reason would
      // count with that one's, whether the answer is cut by day or by hour.
      seedCall(db, { id: "meanwhile", t: 30 * MIN, micros: 777_000, metadata: { wakeId: "w-1", wakeReason: "user", threadScope: "manager" } });
      fail("meanwhile");
    }
  });
  try {
    const answer = answerSummary(reader, request, { catalog: ledgerCatalog, providers: ledgerProviders }, inputs);
    const summary = answer.result;
    expect(wrote).toBe(true);
    // Worked out the way the row names: the slices did not fall back to every call.
    expect(answer.fellBack).toBe(null);
    // The reasons count the failures the figures count: one, not the one that landed since.
    const steps = summary.groups.find((group) => group.key === "agent_wake_step")!;
    expect([steps.failed, steps.reasons]).toEqual([1, [{ reason: "Service Unavailable", calls: 1 }]]);
    expect(summary.ledger.days.reduce((sum, day) => sum + day.spendMicros, 0)).toBe(summary.spend.micros);
  } finally { reader.close(); }
});

// The figures and the ledger are worked out from the same calls: read once,
// not once for each.
test("a summary reads the window's calls once for both of its halves", () => {
  const { db } = seeded();
  const { ran } = statementsRan(db, /from llm_calls/, () => summarizeActivity(db, request, { catalog: ledgerCatalog, providers: ledgerProviders }));
  // The seed's 25 calls come back whole from one statement; the rest are
  // narrow reads (the failures, a sum, a thread's last step).
  const whole = ran.filter((run) => Array.isArray(run.result) && run.result.length >= 25);
  expect(whole.length).toBe(1);
});

function varied() {
  const ledger = freshLedgerDb();
  seedVaried(ledger.db);
  return ledger;
}

test("the halves worked out from the one read are the ones each works out from a read of its own", () => {
  const { db } = varied();
  const deps = { catalog: ledgerCatalog, providers: ledgerProviders };
  for (const group of ACTIVITY_GROUP_KEYS) {
    for (const day of [null, new Date(request.now - 2 * 24 * HOUR).toISOString().slice(0, 10)]) {
      const input = { ...request, group, day };
      const range = activityRange(input);
      const apart = { ...buildActivitySummary(db, input.days, group, input.now, range), ledger: buildActivityLedger(db, input.days, deps, input.now, range), day: range.day };
      expect(json(summarizeActivity(db, input, deps))).toEqual(json(apart));
    }
  }
  // The seed tells the cuts apart: a fallback, a failure with its reason, a verdict.
  const byFallback = summarizeActivity(db, { ...request, group: "fallback" }, deps);
  expect(byFallback.groups.map((group) => [group.key, group.calls])).toEqual([["primary", 36], ["fallback", 1]]);
  expect(byFallback.groups[0]!.reasons).toEqual([{ reason: "Service Unavailable", calls: 1 }]);
  expect(byFallback.ledger.cache.rows.map((row) => row.kind)).toContain("expired");
});
