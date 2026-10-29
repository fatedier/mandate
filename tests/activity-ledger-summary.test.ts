import { expect, test } from "bun:test";
import { buildActivityLedger } from "../src/server/modules/activity/ledger-summary.js";
import { buildActivitySummary } from "../src/server/modules/activity/activity-summary.js";
import { createPriceCatalog } from "../src/server/modules/pricing/catalog.js";
import { loadWindowVerdicts, PREVIOUS_BEFORE_SQL, PREVIOUS_THROUGH_SQL } from "../src/server/modules/activity/window-verdicts.js";
import { at, dayOf, freshLedgerDb, GPT, HOUR, ledgerDeps, ledgerProviders, MIN, seedCall, seedWake } from "./helpers/ledger-seed.js";

const deps = ledgerDeps;
const providers = ledgerProviders;
const fresh = freshLedgerDb;

test("spend per day with the cache-expired extra", () => {
  const { db } = fresh();
  seedCall(db, { id: "a", t: 0, write: 100_000, micros: 520_000 });
  // Six minutes later: 80,000 tokens the cache held were written again.
  seedCall(db, { id: "b", t: 6 * MIN, input: 110_000, read: 20_000, write: 89_000, micros: 470_000 });
  const ledger = buildActivityLedger(db, 7, deps);
  const day = ledger.days.find((d) => d.date === dayOf(0))!;
  expect(day.spendMicros).toBe(990_000);
  expect(day.expiredExtraMicros).toBe(384_000);
  expect(ledger.priceDataDate).toBe("2026-01-02");
  expect(ledger.claudeWriteReadRatio).toBe(25);
});

test("agents by role, with their expired extra", () => {
  const { db } = fresh();
  seedCall(db, { id: "m1", t: 0, micros: 300_000 });
  seedCall(db, { id: "m2", t: 10 * MIN, micros: 300_000 });
  seedCall(db, { id: "g1", scopeId: "t-global", t: 0, micros: 400_000 });
  seedCall(db, { id: "w1", scopeId: "t-worker", model: GPT, t: 0, micros: 50_000 });
  // A deleted thread whose step recorded its scope counts under that role.
  seedCall(db, { id: "w-gone", scopeId: "t-gone", model: GPT, t: 0, micros: 20_000, metadata: { threadScope: "worker" } });
  seedCall(db, { id: "gone", scopeId: "t-gone-2", model: GPT, t: 0, micros: 10_000 });
  seedCall(db, { id: "d1", purpose: "memory_dream", scopeType: "memory", scopeId: "global", model: GPT, t: 0, micros: 30_000 });
  seedCall(db, { id: "c1", purpose: "agent_compression", t: 20 * MIN, micros: 25_000 });
  const ledger = buildActivityLedger(db, 7, deps);
  expect(ledger.agents.map((a) => [a.role, a.calls, a.spendMicros])).toEqual([
    ["managers", 2, 600_000], ["your_agent", 1, 400_000], ["workers", 2, 70_000],
    ["dream", 1, 30_000], ["compaction", 1, 25_000], ["deleted_thread", 1, 10_000]
  ]);
  const managers = ledger.agents.find((a) => a.role === "managers")!;
  expect(managers.expiredExtraMicros).toBeGreaterThan(0);
  expect(managers.money).toBe("spend");
});

test("cache rows, within-an-hour count and median idle", () => {
  const { db } = fresh();
  seedCall(db, { id: "s0", t: 0 });
  seedCall(db, { id: "s1", t: 10 * MIN });            // expired, idle 10 min
  seedCall(db, { id: "s2", t: 30 * MIN });            // expired, idle 20 min
  seedCall(db, { id: "s3", t: 150 * MIN });           // expired, idle 2 h
  seedCall(db, { id: "s4", t: 152 * MIN });           // miss, idle 2 min
  seedCall(db, { id: "c", purpose: "agent_compression", t: 153 * MIN });
  seedCall(db, { id: "s5", t: 154 * MIN });           // rebuild after the compaction
  seedCall(db, { id: "g0", scopeId: "t-worker", model: GPT, t: 0 });
  seedCall(db, { id: "g1", scopeId: "t-worker", model: GPT, t: HOUR });  // not reused
  const ledger = buildActivityLedger(db, 7, deps);
  expect(ledger.cache.rows.map((r) => [r.kind, r.calls])).toEqual([["expired", 3], ["miss", 1], ["not_reused", 1], ["rebuild", 1]]);
  expect(ledger.cache.expiredWithinHour).toBe(2);
  expect(ledger.cache.medianExpiredIdleMs).toBe(20 * MIN);
  expect(ledger.cache.wrote1h).toBe(false);
  expect(ledger.cache.rows.find((r) => r.kind === "not_reused")!.topFamily).toBe("gpt");
  const expired = ledger.cache.rows.find((r) => r.kind === "expired")!;
  expect(expired.rewrittenTokens).toBe(300_000);
  // Nothing written to the cache: 100k tokens each read as plain input, (4 − 0.2) per 1M.
  expect(expired.extraMicros).toBe(3 * 380_000);
  // The same verdicts the Logs view will list.
  const verdicts = loadWindowVerdicts(db, new Date(Date.now() - 7 * 24 * HOUR).toISOString());
  expect([...verdicts].filter(([, v]) => v.kind === "expired").map(([id]) => id).sort()).toEqual(["s1", "s2", "s3"]);
});

test("token split adds up to the spend; reported amounts unsplit", () => {
  const { db } = fresh();
  seedCall(db, { id: "a", t: 0, input: 100_000, read: 20_000, write: 70_000, output: 2_000, micros: 434_000 });
  seedCall(db, { id: "b", scopeId: "t-worker", model: GPT, t: 0, input: 50_000, read: 40_000, output: 500, micros: 29_000 });
  seedCall(db, { id: "r", scopeId: "t-worker", t: HOUR, source: "reported", micros: 4_200 });
  const ledger = buildActivityLedger(db, 7, deps);
  const t = ledger.tokens;
  expect(t.uncachedInputMicros + t.cacheReadMicros + t.cacheWriteMicros + t.outputMicros + t.reportedUnsplitMicros).toBe(434_000 + 29_000 + 4_200);
  expect(t.reportedUnsplitMicros).toBe(4_200);
  expect(t.cacheWriteMicros).toBe(350_000);
});

test("what woke the agents", () => {
  const { db } = fresh();
  seedWake(db, "w-user", "t-manager", "user");
  seedWake(db, "w-alarm", "t-global", "alarm");
  seedWake(db, "w-hb", "t-manager", "work-item-heartbeat");
  seedCall(db, { id: "u1", t: 0, micros: 200_000, metadata: { wakeId: "w-user" } });
  seedCall(db, { id: "u2", t: MIN, micros: 100_000, metadata: { wakeId: "w-user" } });
  seedCall(db, { id: "a1", scopeId: "t-global", t: 0, micros: 50_000, metadata: { wakeId: "w-alarm" } });
  seedCall(db, { id: "h1", t: 30 * MIN, micros: 80_000, metadata: { wakeId: "w-hb" } });
  // Its wake row is gone with its thread; the step recorded the reason.
  seedCall(db, { id: "r1", scopeId: "t-gone", t: 0, micros: 40_000, metadata: { wakeId: "w-gone", wakeReason: "worker-report", threadScope: "manager" } });
  seedCall(db, { id: "d1", purpose: "memory_dream", scopeType: "memory", scopeId: "global", model: GPT, t: 0, micros: 30_000 });
  seedCall(db, { id: "d2", purpose: "memory_dream", scopeType: "memory", scopeId: "global", model: GPT, t: HOUR, micros: 30_000 });
  seedCall(db, { id: "q1", purpose: "manager_request_check", t: 0, model: GPT, micros: 100 });
  seedCall(db, { id: "s1", purpose: "manager_stop_check", t: 0, model: GPT, micros: 70 });
  seedCall(db, { id: "s2", purpose: "manager_stop_check", t: MIN, model: GPT, micros: 70 });
  for (const id of ["dr1", "dr2"]) {
    db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at) values (?, 'schedule', 'succeeded', 'user', ?)").run(id, at(0));
  }
  const ledger = buildActivityLedger(db, 7, deps);
  const byKey = Object.fromEntries(ledger.wakes.map((w) => [w.key, w]));
  expect(byKey.messages).toMatchObject({ runs: 1, spendMicros: 300_000, timer: false, roles: ["managers"] });
  expect(byKey.alarms).toMatchObject({ runs: 1, spendMicros: 50_000, timer: true, roles: ["your_agent"] });
  expect(byKey.check_ins).toMatchObject({ runs: 1, timer: true });
  expect(byKey.check_ins!.expiredExtraMicros).toBeGreaterThan(0);
  expect(byKey.worker_reports).toMatchObject({ runs: 1, spendMicros: 40_000, roles: ["managers"] });
  expect(byKey.dream).toMatchObject({ runs: 2, spendMicros: 60_000, timer: true, roles: ["dream"] });
  expect(byKey.manager_request_check).toMatchObject({ runs: 1, spendMicros: 100, timer: false });
  // Each manager stop check is one call: its runs are its calls.
  expect(byKey.manager_stop_check).toMatchObject({ runs: 2, spendMicros: 140, timer: false, roles: ["manager_stop_check"] });
  expect(ledger.wakes[0]!.key).toBe("messages");
});

test("previous period spend", () => {
  const { db } = fresh();
  expect(buildActivityLedger(db, 7, deps).previousSpendMicros).toBeNull();
  seedCall(db, { id: "old", t: -7 * 24 * HOUR, micros: 77_000 });
  seedCall(db, { id: "older", t: -20 * 24 * HOUR, micros: 1 });
  seedCall(db, { id: "now", t: 0, micros: 5 });
  expect(buildActivityLedger(db, 7, deps).previousSpendMicros).toBe(77_000);
});

test("no spend: agents keep their calls", () => {
  const { db } = fresh();
  seedCall(db, { id: "a", t: 0, source: "included", micros: null });
  seedCall(db, { id: "b", t: 10 * MIN, source: "included", micros: null });
  seedCall(db, { id: "f", scopeId: "t-worker", t: 0, source: "free", micros: null });
  const ledger = buildActivityLedger(db, 7, deps);
  expect(ledger.agents.map((a) => [a.role, a.calls, a.spendMicros, a.money])).toEqual([["managers", 2, 0, "included"], ["workers", 1, 0, "free"]]);
  expect(Object.values(ledger.tokens).every((v) => v === 0)).toBe(true);
  // The verdict stands without a price; its extra is not money.
  expect(ledger.cache.rows).toEqual([{ kind: "expired", calls: 1, pricedCalls: 0, rewrittenTokens: 100_000, extraMicros: 0, topFamily: null }]);
  expect(ledger.claudeWriteReadRatio).toBeNull();
});

test("a row with unreadable metadata is counted, not fatal", () => {
  const { db } = fresh();
  seedCall(db, { id: "bad", t: 0, metadata: "{not json" });
  seedCall(db, { id: "bad2", scopeId: "t-gone", t: 0, metadata: "{also not json" });
  const ledger = buildActivityLedger(db, 7, deps);
  expect(ledger.agents.map((a) => a.role).sort()).toEqual(["deleted_thread", "managers"]);
});

test("the summary and the ledger share one window cutoff", () => {
  const { db } = fresh();
  const now = Date.now();
  // A call 1 ms inside the window at `now`: counted by both, or by neither.
  const edge = new Date(now - 7 * 24 * HOUR + 1).toISOString();
  db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, model, status, started_at, created_at, updated_at, cost_source, cost_micros)
    values ('edge', 'agent_wake_step', 'agent_thread', 't-manager', 'openai-compatible', 'm', 'succeeded', ?, ?, ?, 'list', 5000)`).run(edge, edge, edge);
  const summary = buildActivitySummary(db, 7, "purpose", now);
  const ledger = buildActivityLedger(db, 7, deps, now);
  expect(summary.spend.micros).toBe(5_000);
  expect(ledger.days.reduce((sum, d) => sum + d.spendMicros, 0)).toBe(5_000);
  // A moment later the call has left both.
  expect(buildActivitySummary(db, 7, "purpose", now + 2).spend.micros).toBe(0);
  expect(buildActivityLedger(db, 7, deps, now + 2).days).toEqual([]);
});

test("the write/read ratio is the Claude model with the most spend, reported spend included", () => {
  const { db } = fresh();
  // claude-test: $1 at list price plus $100 reported; a second Claude model at $10 list.
  seedCall(db, { id: "a", t: 0, micros: 1_000_000 });
  seedCall(db, { id: "b", t: HOUR, source: "reported", micros: 100_000_000 });
  seedCall(db, { id: "c", scopeId: "t-worker", model: "anthropic/claude-other", t: 0, micros: 10_000_000,
    ref: JSON.stringify({ origin: "litellm", providerId: "anthropic", providerName: "anthropic", modelId: "claude-other", dataDate: "2026-01-02" }) });
  const withOther = createPriceCatalog({
    litellm: {
      date: "2026-01-02",
      entries: Object.assign(Object.create(null), {
        "claude-test": { provider: "anthropic", rates: { base: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } } },
        "claude-other": { provider: "anthropic", rates: { base: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } } },
        "gpt-test": { provider: "openai", rates: { base: { input: 2, output: 10, cacheRead: 1, cacheWrite: 2 } } }
      })
    },
    modelsDev: null
  });
  // A model on another protocol outspends them all: it is not Claude, so not the ratio's.
  seedCall(db, { id: "g", scopeId: "t-worker", model: GPT, t: 0, micros: 900_000_000 });
  expect(buildActivityLedger(db, 7, { catalog: withOther, providers }).claudeWriteReadRatio).toBe(25);
});

test("dream runs show without calls", () => {
  const { db } = fresh();
  db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at) values ('dr', 'schedule', 'failed', 'user', ?)").run(at(0));
  const dream = buildActivityLedger(db, 7, deps).wakes.find((w) => w.key === "dream");
  expect(dream).toMatchObject({ runs: 1, spendMicros: 0, timer: true, money: "none" });
});

test("the median idle of an even number of expired calls is the middle two's mean", () => {
  const { db } = fresh();
  seedCall(db, { id: "s0", t: 0 });
  seedCall(db, { id: "s1", t: 10 * MIN });   // idle 10 min
  seedCall(db, { id: "s2", t: 40 * MIN });   // idle 30 min
  expect(buildActivityLedger(db, 7, deps).cache.medianExpiredIdleMs).toBe(20 * MIN);
});

test("a cache row whose calls have no rates says so: no priced calls, no extra", () => {
  const { db } = fresh();
  seedCall(db, { id: "a", t: 0, source: "reported", micros: 5_000 });
  seedCall(db, { id: "b", t: 10 * MIN, source: "reported", micros: 5_000 });
  seedCall(db, { id: "c", scopeId: "t-worker", t: 0 });
  seedCall(db, { id: "d", scopeId: "t-worker", t: 10 * MIN });
  const rows = buildActivityLedger(db, 7, deps).cache.rows;
  expect(rows).toEqual([{ kind: "expired", calls: 2, pricedCalls: 1, rewrittenTokens: 200_000, extraMicros: 380_000, topFamily: null }]);
});

test("the window-start lookup uses the thread index, with or without statistics", () => {
  const { db } = fresh();
  for (let i = 0; i < 30; i += 1) seedCall(db, { id: `x${i}`, scopeId: `t-${i % 5}`, t: -i * HOUR });
  const plan = (sql: string, ...params: unknown[]) =>
    (db.prepare(`explain query plan ${sql}`).all(...(params as string[])) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
  for (const detail of [plan(PREVIOUS_THROUGH_SQL, "t-1", at(0)), plan(PREVIOUS_BEFORE_SQL, "t-1", at(0), at(0), "x")]) {
    expect(detail).toContain("idx_llm_calls_scope_created");
    expect(detail.includes("idx_llm_calls_status_created")).toBe(false);
  }
});

test("with no extra to rank by (no rates), the family named is the one with the most tokens rewritten, not the first by name", () => {
  const { db } = fresh();
  // Two families of unpriced models, neither cached: alphabetically "aaa" comes first.
  seedCall(db, { id: "a0", scopeId: "t-a", model: "other/aaa-small", t: 0, input: 10_000 });
  seedCall(db, { id: "a1", scopeId: "t-a", model: "other/aaa-small", t: HOUR, input: 10_000 });
  seedCall(db, { id: "z0", scopeId: "t-z", model: "other/zeta-large", t: 0, input: 100_000 });
  seedCall(db, { id: "z1", scopeId: "t-z", model: "other/zeta-large", t: HOUR, input: 100_000 });
  const row = buildActivityLedger(db, 7, deps).cache.rows.find((r) => r.kind === "not_reused")!;
  expect([row.extraMicros, row.topFamily]).toEqual([0, "zeta"]);
});

test("the family named is the one that cost most on top, before the one with most tokens; tokens, then the name, only break ties", () => {
  const { db } = fresh();
  // GPT is priced: a small prompt costs something on top. The unpriced family rewrote more tokens and costs nothing.
  seedCall(db, { id: "g0", scopeId: "t-g", model: GPT, t: 0, input: 10_000 });
  seedCall(db, { id: "g1", scopeId: "t-g", model: GPT, t: HOUR, input: 10_000 });
  seedCall(db, { id: "z0", scopeId: "t-z", model: "other/zeta-large", t: 0, input: 100_000 });
  seedCall(db, { id: "z1", scopeId: "t-z", model: "other/zeta-large", t: HOUR, input: 100_000 });
  expect(buildActivityLedger(db, 7, deps).cache.rows.find((r) => r.kind === "not_reused")!.topFamily).toBe("gpt");
  // All even: the first by name.
  const even = fresh().db;
  for (const [id, model, t] of [["a0", "other/bbb-x", 0], ["a1", "other/bbb-x", HOUR], ["b0", "other/aaa-x", 0], ["b1", "other/aaa-x", HOUR]] as const) {
    seedCall(even, { id, scopeId: `t-${model}`, model, t, input: 10_000 });
  }
  expect(buildActivityLedger(even, 7, deps).cache.rows.find((r) => r.kind === "not_reused")!.topFamily).toBe("aaa");
});
