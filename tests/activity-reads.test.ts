import { expect, test } from "bun:test";
import { annotateCalls } from "../src/server/modules/activity/call-annotations.js";
import { freshLedgerDb, ledgerDeps, MIN, seedCall } from "./helpers/ledger-seed.js";
import { plansOf } from "./helpers/sql-watch.js";

// Every model call is recorded: tens of thousands a day. The Logs page reads
// the newest few and, for each, the step before it in its thread; both are
// found in order, never by sorting every call there is.

test("the newest calls and the step before each are read in order, without sorting every call", () => {
  const { env, db } = freshLedgerDb();
  for (let i = 0; i < 40; i++) {
    seedCall(db, { id: `step-${i}`, t: i * MIN, scopeId: i % 2 ? "t-manager" : "t-worker" });
    seedCall(db, { id: `judge-${i}`, t: i * MIN + 1, purpose: "manager_stop_check", scopeType: "manager_check", scopeId: "t-manager" });
  }
  const plans = plansOf(db, /from llm_calls/, () => {
    const calls = env.store.listLlmCallSummaries(20, {});
    annotateCalls(db, calls, ledgerDeps);
  });
  for (const plan of plans) {
    expect(plan).not.toContain("USE TEMP B-TREE");
    expect(plan).not.toMatch(/SCAN llm_calls(?! USING)/);
  }
});
