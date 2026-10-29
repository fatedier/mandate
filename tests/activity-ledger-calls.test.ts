import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import type { ActivitySummaryResponse, LlmCallDetailResponse, LlmCallsResponse } from "../src/shared/api-contracts.js";
import type { AppDeps } from "../src/server/app/deps.js";
import type { Config } from "../src/server/config/types.js";
import { activityModule } from "../src/server/modules/activity/module.js";
import { annotateCalls } from "../src/server/modules/activity/call-annotations.js";
import { loadWindowVerdicts } from "../src/server/modules/activity/window-verdicts.js";
import { DAY, freshLedgerDb, GPT, HOUR, ledgerCatalog, ledgerDeps, ledgerProviders, MIN, seedCall, seedThread, seedWake } from "./helpers/ledger-seed.js";
import { stub } from "./helpers/typed.js";

function app(store: AppDeps["store"]) {
  const hono = new Hono();
  const deps = stub<AppDeps>({
    store,
    config: stub<Config>({ models: stub<Config["models"]>({ providers: ledgerProviders, prices: { autoUpdate: false } }) }),
    priceData: { catalog: () => ledgerCatalog }
  });
  activityModule.mountRoutes?.(hono, { deps, upgradeWebSocket: createBunWebSocket().upgradeWebSocket });
  return hono;
}

async function list(hono: Hono, query: string): Promise<LlmCallsResponse["calls"]> {
  const res = await hono.request(`/api/activity/calls?limit=100&${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as LlmCallsResponse).calls;
}

const ids = (calls: Array<{ id: string }>) => calls.map((c) => c.id).sort();

function seedExpiredMix(db: Database) {
  seedCall(db, { id: "s0", t: 0 });
  seedCall(db, { id: "s1", t: 10 * MIN });
  seedCall(db, { id: "s2", t: 12 * MIN });           // miss
  seedCall(db, { id: "s3", t: 90 * MIN });           // expired
  seedCall(db, { id: "g0", scopeId: "t-worker", model: GPT, t: 0 });
  seedCall(db, { id: "g1", scopeId: "t-worker", model: GPT, t: HOUR }); // not reused
}

test("view=expired lists exactly the calls the summary counted", async () => {
  const { env, db } = freshLedgerDb();
  seedExpiredMix(db);
  const hono = app(env.store);
  const calls = await list(hono, "view=expired&days=7");
  expect(ids(calls)).toEqual(["s1", "s3"]);
  const verdicts = loadWindowVerdicts(db, new Date(Date.now() - 7 * DAY).toISOString());
  expect(ids([...verdicts].filter(([, v]) => v.kind === "expired").map(([id]) => ({ id })))).toEqual(["s1", "s3"]);
  const summary = await (await hono.request("/api/activity/summary?days=7")).json() as ActivitySummaryResponse;
  expect(summary.ledger.cache.rows.find((r) => r.kind === "expired")!.calls).toBe(calls.length);
});

test("window pass and row annotation agree at the window's edge", async () => {
  const { env, db } = freshLedgerDb();
  // The previous step is 8 days old; the next one, a day old, sits in a 7-day window.
  seedCall(db, { id: "old", t: -6 * DAY });
  seedCall(db, { id: "edge", t: DAY });
  const verdicts = loadWindowVerdicts(db, new Date(Date.now() - 7 * DAY).toISOString());
  expect(verdicts.get("edge")?.kind).toBe("expired");
  const [annotated] = annotateCalls(db, env.store.listLlmCallSummaries(10, { q: "edge" }), ledgerDeps);
  expect(annotated!.ledger?.verdict).toMatchObject({ kind: "expired", idleMs: verdicts.get("edge")!.idleMs });
  expect(ids(await list(app(env.store), "view=expired&days=7"))).toEqual(["edge"]);
});

test("view=slow, view=timers, view=failed", async () => {
  const { env, db } = freshLedgerDb();
  seedWake(db, "w-alarm", "t-global", "alarm");
  seedWake(db, "w-hb", "t-manager", "work-item-heartbeat");
  seedWake(db, "w-user", "t-manager", "user");
  seedCall(db, { id: "fast", t: 0, latencyMs: 59_999 });
  seedCall(db, { id: "slow", t: MIN, latencyMs: 60_000 });
  seedCall(db, { id: "alarm", scopeId: "t-global", t: 2 * MIN, metadata: { wakeId: "w-alarm" } });
  seedCall(db, { id: "hb", t: 3 * MIN, metadata: { wakeId: "w-hb" } });
  seedCall(db, { id: "user", t: 4 * MIN, metadata: { wakeId: "w-user" } });
  seedCall(db, { id: "gone-alarm", scopeId: "t-gone", t: 5 * MIN, metadata: { wakeId: "w-gone", wakeReason: "alarm" } });
  seedCall(db, { id: "dream", purpose: "memory_dream", scopeType: "memory", scopeId: "global", model: GPT, t: 6 * MIN });
  seedCall(db, { id: "failed", t: 7 * MIN, status: "failed" });
  // A recorded reason without a wake id belongs to no wake, as the summary reads it.
  seedCall(db, { id: "no-wake", t: 8 * MIN, metadata: { wakeReason: "alarm" } });
  seedCall(db, { id: "empty-wake", t: 9 * MIN, metadata: { wakeId: "", wakeReason: "alarm" } });
  const hono = app(env.store);
  expect(ids(await list(hono, "view=slow"))).toEqual(["slow"]);
  expect(ids(await list(hono, "view=timers&days=7"))).toEqual(["alarm", "dream", "gone-alarm", "hb"]);
  expect(ids(await list(hono, "view=failed"))).toEqual(ids(await list(hono, "status=failed")));
  expect(ids(await list(hono, "view=failed"))).toEqual(["failed"]);
});

test("agent filter and days", async () => {
  const { env, db } = freshLedgerDb();
  seedCall(db, { id: "m-new", t: 0 });
  seedCall(db, { id: "m-old", t: -10 * DAY });
  seedCall(db, { id: "g-new", scopeId: "t-global", t: 0 });
  const hono = app(env.store);
  expect(ids(await list(hono, "agent=managers&days=7"))).toEqual(["m-new"]);
  expect(ids(await list(hono, "agent=managers&days=30"))).toEqual(["m-new", "m-old"]);
  // A period on its own does not narrow All.
  expect(ids(await list(hono, "days=7"))).toEqual(["g-new", "m-new", "m-old"]);
});

test("each row carries its role, thread title and verdict", async () => {
  const { env, db } = freshLedgerDb();
  seedThread(db, "t-titled", "manager", "Invented title");
  seedWake(db, "w-report", "t-titled", "worker-report");
  seedCall(db, { id: "a", scopeId: "t-titled", t: 0 });
  seedCall(db, { id: "b", scopeId: "t-titled", t: 24 * MIN, write: 100_000, metadata: { wakeId: "w-report" } });
  seedCall(db, { id: "gone", scopeId: "t-gone", t: 0, metadata: { threadScope: "worker", wakeId: "w-x", wakeReason: "alarm" } });
  seedCall(db, { id: "r0", scopeId: "t-worker", t: 0 });
  seedCall(db, { id: "r1", scopeId: "t-worker", t: 30 * MIN, source: "reported", micros: 4_200 });
  seedCall(db, { id: "dream", purpose: "memory_dream", scopeType: "memory", scopeId: "global", model: GPT, t: 0 });
  // A subagent's thread compacting: no title, nowhere to open it, still a thread's call.
  seedThread(db, "t-sub", "subagent", "");
  seedCall(db, { id: "sub-c", purpose: "agent_compression", scopeId: "t-sub", t: 0 });
  const calls = Object.fromEntries((await list(app(env.store), "")).map((c) => [c.id, c]));
  // Not a thread's call: nothing deleted, no title.
  expect(calls.dream!.ledger).toEqual({ role: "dream", threadTitle: null, threadDeleted: false, inThread: false, wakeKey: null, link: null, verdict: null });
  expect(calls["sub-c"]!.ledger).toMatchObject({ role: "compaction", threadTitle: null, threadDeleted: false, inThread: true, link: null });
  expect(calls.b!.ledger).toEqual({
    role: "managers", threadTitle: "Invented title", threadDeleted: false, inThread: true, wakeKey: "worker_reports", link: { to: "thread", threadId: "t-titled" },
    verdict: { kind: "expired", idleMs: 24 * MIN, sinceStartMs: 24 * MIN, rewrittenTokens: 100_000, extraMicros: 480_000, lifetimeMs: 300_000, requestedLifetimeMs: 3_600_000, writtenLifetimeMs: null, rebuildCause: null, previousModel: "anthropic/claude-test" }
  });
  expect(calls.a!.ledger).toMatchObject({ role: "managers", verdict: null, wakeKey: null });
  expect(calls.gone!.ledger).toMatchObject({ role: "workers", threadTitle: null, threadDeleted: true, inThread: true, wakeKey: "alarms" });
  // A reported amount: the verdict, without an extra in money.
  expect(calls.r1!.ledger?.verdict).toMatchObject({ kind: "expired", extraMicros: null });
});

test("the call detail carries the split and the verdict", async () => {
  const { env, db } = freshLedgerDb();
  seedCall(db, { id: "a", t: 0 });
  seedCall(db, { id: "b", t: 24 * MIN, input: 165_630, read: 0, write: 165_626, output: 434, micros: 836_826 });
  seedCall(db, { id: "r", scopeId: "t-worker", t: 0, source: "reported", micros: 4_200 });
  const hono = app(env.store);
  const detail = await (await hono.request("/api/activity/calls/b")).json() as Extract<LlmCallDetailResponse, { call: unknown }>;
  expect(detail.call.ledger?.verdict?.kind).toBe("expired");
  expect(detail.call.tokenSplit!.rows.map((r) => r.kind)).toEqual(["cache_write", "output", "uncached_input"]);
  expect(detail.call.tokenSplit!.rows[0]).toEqual({ kind: "cache_write", tokens: 165_626, micros: 828_130 });
  expect(detail.call.tokenSplit!.rows.reduce((sum, r) => sum + r.micros, 0)).toBe(836_826);
  const reported = await (await hono.request("/api/activity/calls/r")).json() as Extract<LlmCallDetailResponse, { call: unknown }>;
  expect(reported.call.tokenSplit).toBeNull();
});

test("filters reject junk without a 500", async () => {
  const { env, db } = freshLedgerDb();
  seedCall(db, { id: "a", t: 0 });
  const hono = app(env.store);
  expect(ids(await list(hono, "view=nonsense"))).toEqual(["a"]);
  expect(ids(await list(hono, "view=expired&days=abc"))).toEqual([]);
  expect(ids(await list(hono, "agent=nobody&days=7"))).toEqual([]);
  // An unreadable window is the default 30 days; a negative one is clamped to a day, as the summary does.
  expect(ids(await list(hono, "agent=managers&days=abc"))).toEqual(["a"]);
  expect(ids(await list(hono, "agent=managers&days=-3"))).toEqual([]);
});

test("period views carry their totals; Cache expired's extra is the summary's", async () => {
  const { env, db } = freshLedgerDb();
  seedExpiredMix(db);
  seedCall(db, { id: "r", scopeId: "t-global", t: 0 });
  seedCall(db, { id: "r2", scopeId: "t-global", t: 30 * MIN, source: "reported", micros: 4_200 });
  const hono = app(env.store);
  const body = async (query: string) => (await (await hono.request(`/api/activity/calls?limit=1&${query}`)).json()) as LlmCallsResponse;
  const expired = await body("view=expired&days=7");
  const summary = await (await hono.request("/api/activity/summary?days=7")).json() as ActivitySummaryResponse;
  const row = summary.ledger.cache.rows.find((r) => r.kind === "expired")!;
  // Counted over the whole view, not the page of one row.
  expect(expired.calls.length).toBe(1);
  expect(expired.totals).toEqual({ calls: row.calls, extraMicros: row.extraMicros });
  expect(row.calls).toBe(3);
  expect((await body("agent=managers&days=7")).totals).toEqual({ calls: 4, extraMicros: null });
  expect((await body("view=slow")).totals).toBeUndefined();
  expect((await body("")).totals).toBeUndefined();
});

test("Cache expired's totals follow every other filter on the view", async () => {
  const { env, db } = freshLedgerDb();
  seedExpiredMix(db);
  seedCall(db, { id: "w0", scopeId: "t-worker", t: 0 });
  seedCall(db, { id: "w1", scopeId: "t-worker", t: 40 * MIN, write: 100_000 });
  const hono = app(env.store);
  const totals = async (query: string) => ((await (await hono.request(`/api/activity/calls?limit=1&${query}`)).json()) as LlmCallsResponse).totals;
  const all = await totals("view=expired&days=7");
  const managers = await totals("view=expired&days=7&agent=managers");
  const workers = await totals("view=expired&days=7&agent=workers");
  expect(all!.calls).toBe(3);
  expect(managers!.calls).toBe(2);
  expect(workers).toEqual({ calls: 1, extraMicros: 480_000 });
  expect(managers!.extraMicros! + workers!.extraMicros!).toBe(all!.extraMicros!);
  // Nothing matches: no calls, and nothing paid.
  expect(await totals("view=expired&days=7&q=nothing-like-it")).toEqual({ calls: 0, extraMicros: 0 });
});

test("Cache expired's extra is unknown, not $0, when none of its calls has rates", async () => {
  const { env, db } = freshLedgerDb();
  seedCall(db, { id: "a", t: 0, source: "reported", micros: 5_000 });
  seedCall(db, { id: "b", t: 10 * MIN, source: "reported", micros: 5_000 });
  const body = (await (await app(env.store).request("/api/activity/calls?view=expired&days=7")).json()) as LlmCallsResponse;
  expect(body.totals).toEqual({ calls: 1, extraMicros: null });
});

test("each row names where its thread is: a manager's, Your agent, a worker's under its manager", async () => {
  const { env, db } = freshLedgerDb();
  db.exec("pragma foreign_keys = off");
  db.prepare(`insert into features (id, project_id, name, mode, tmux_window_name, ownership, created_at, updated_at, owner_thread_id)
    values ('feat-1', 'proj-1', 'Invented worker feature', 'shared-cwd', 'w1', 'app', ?, ?, 't-manager')`).run(new Date().toISOString(), new Date().toISOString());
  db.prepare("update agent_threads set scope_id = 'feat-1' where id = 't-worker'").run();
  seedThread(db, "t-page", "subagent", "Invented page");
  seedCall(db, { id: "m", t: 0 });
  seedCall(db, { id: "g", scopeId: "t-global", t: 0 });
  seedCall(db, { id: "w", scopeId: "t-worker", t: 0 });
  seedCall(db, { id: "p", purpose: "page_subagent_step", scopeId: "t-page", t: 0 });
  // A compaction runs in its thread: it links where the thread is.
  seedCall(db, { id: "c", purpose: "agent_compression", t: MIN });
  seedCall(db, { id: "cw", purpose: "agent_compression", scopeId: "t-worker", t: MIN });
  const calls = Object.fromEntries((await list(app(env.store), "")).map((c) => [c.id, c.ledger]));
  expect(calls.c).toMatchObject({ role: "compaction", link: { to: "thread", threadId: "t-manager" } });
  expect(calls.cw).toMatchObject({ link: { to: "worker", threadId: "t-manager", workerId: "feat-1" } });
  expect(calls.m).toMatchObject({ threadTitle: "Invented manager", link: { to: "thread", threadId: "t-manager" } });
  expect(calls.g).toMatchObject({ link: { to: "agent" } });
  expect(calls.w).toMatchObject({ threadTitle: "Invented worker feature", link: { to: "worker", threadId: "t-manager", workerId: "feat-1" } });
  expect(calls.p).toMatchObject({ link: null });
});
