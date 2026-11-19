import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { newFiguresPart } from "../src/server/modules/activity/figures-part.js";
import { newLedgerPart } from "../src/server/modules/activity/ledger-part.js";
import { SliceKeeper, sliceKeeperFor } from "../src/server/modules/activity/slice-keeper.js";
import { encodeSlice, type SliceRow } from "../src/server/modules/activity/slice-store.js";
import { sliceOf } from "../src/server/modules/activity/slice-schema.js";
import { freshLedgerDb } from "./helpers/ledger-seed.js";

// The slices an answer worked out are kept after it is sent, by the server's
// own connection, a few at a time between other work.

const HOUR = 3_600_000;
/** The last `count` whole hours before this one, empty. */
const rows = (count: number, builtSeq = 1): SliceRow[] => Array.from({ length: count }, (_, i) =>
  encodeSlice(sliceOf(new Date(Date.now() - (count - i) * HOUR).toISOString()), { figures: newFiguresPart(), ledger: newLedgerPart() }, builtSeq, "inputs-a"));
const kept = (db: Database) => (db.prepare("select count(*) n from activity_slices").get() as { n: number }).n;
const state = (db: Database) => db.prepare("select seq, floor from activity_rollup_state where id = 1").get() as { seq: number; floor: number };

test("rows are kept a batch a turn, in the order they came", async () => {
  const { db } = freshLedgerDb();
  const turns: Array<() => void> = [];
  const keeper = new SliceKeeper(db, { batch: 2, later: (run) => { turns.push(run); } });
  keeper.keep(rows(5));
  // Nothing is written while the answer is being sent.
  expect([kept(db), turns.length]).toEqual([0, 1]);
  turns.shift()!();
  expect([kept(db), turns.length]).toEqual([2, 1]);
  // Rows that come meanwhile wait their turn behind the others: no turn of their own.
  keeper.keep(rows(1, 2));
  expect(turns.length).toBe(1);
  turns.shift()!();
  expect([kept(db), turns.length]).toEqual([4, 1]);
  // The last hour came twice; the later build is the one kept.
  turns.shift()!();
  expect([kept(db), turns.length]).toEqual([5, 0]);
  expect((db.prepare("select max(built_seq) m from activity_slices").get() as { m: number }).m).toBe(2);
  await keeper.idle();
});

test("idle resolves once everything handed over is kept", async () => {
  const { db } = freshLedgerDb();
  const keeper = new SliceKeeper(db, { batch: 2 });
  keeper.keep(rows(5));
  expect(kept(db)).toBe(0);
  await keeper.idle();
  expect(kept(db)).toBe(5);
  // With nothing waiting it resolves at once.
  await keeper.idle();
});

test("turned off, it keeps nothing more and nothing kept before is trusted", async () => {
  const { db } = freshLedgerDb();
  db.prepare("update activity_rollup_state set seq = 7, floor = 2").run();
  const logged: string[] = [];
  const keeper = new SliceKeeper(db, { log: (message) => logged.push(message) });
  keeper.keep(rows(3, 7));
  await keeper.idle();
  expect([keeper.enabled, kept(db)]).toEqual([true, 3]);
  keeper.off("the answers differ at ledger.tokens");
  expect(keeper.enabled).toBe(false);
  // The counter moves on and the floor with it: every row kept so far is below it.
  expect(state(db)).toEqual({ seq: 8, floor: 8 });
  keeper.keep(rows(4, 8));
  await keeper.idle();
  expect(kept(db)).toBe(3);
  // Said once, however often it is turned off.
  keeper.off("again");
  expect(logged.length).toBe(1);
  expect(logged[0]).toContain("the answers differ at ledger.tokens");
  expect(state(db)).toEqual({ seq: 8, floor: 8 });
});

test("a database closed under it is the end of its keeping: nothing thrown later, nothing to say", async () => {
  const { env, db } = freshLedgerDb();
  const logged: string[] = [];
  const keeper = new SliceKeeper(db, { batch: 1, log: (message) => logged.push(message) });
  keeper.keep(rows(3));
  // The server stopping with a turn still due.
  env.cleanup();
  await keeper.idle();
  expect(logged).toEqual([]);
});

test("rows that cannot be written are said and dropped; the next ones are kept", async () => {
  const { db } = freshLedgerDb();
  const logged: string[] = [];
  const keeper = new SliceKeeper(db, { batch: 2, log: (message) => logged.push(message) });
  db.exec("alter table activity_slices rename to activity_slices_away");
  keeper.keep(rows(3));
  await keeper.idle();
  // Once for the turn that failed, not once a row or a batch.
  expect(logged.length).toBe(1);
  expect(logged[0]).toContain("activity_slices");
  db.exec("alter table activity_slices_away rename to activity_slices");
  expect(kept(db)).toBe(0);
  // An answer that still needs them works them out and hands them over again.
  expect(keeper.enabled).toBe(true);
  keeper.keep(rows(3));
  await keeper.idle();
  expect(kept(db)).toBe(3);
});

test("one keeper for a database", () => {
  const { db } = freshLedgerDb();
  const { db: other } = freshLedgerDb();
  expect(sliceKeeperFor(db)).toBe(sliceKeeperFor(db));
  expect(sliceKeeperFor(db)).not.toBe(sliceKeeperFor(other));
});
