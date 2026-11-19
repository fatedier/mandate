import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { ActivitySummaryResponse, LlmCallDetailResponse, LlmCallsResponse } from "../src/shared/api-contracts.js";
import type { AppDeps } from "../src/server/app/deps.js";
import type { Config } from "../src/server/config/types.js";
import { annotateCalls } from "../src/server/modules/activity/call-annotations.js";
import { loadWindowVerdicts } from "../src/server/modules/activity/window-verdicts.js";
import { DAY, freshLedgerDb, GPT, HOUR, ledgerCatalog, ledgerDeps, ledgerProviders, MIN, seedCall, seedThread, seedWake } from "./helpers/ledger-seed.js";
import { preparedByAsync } from "./helpers/sql-watch.js";
import { stub } from "./helpers/typed.js";
import { buildActivityTestApp } from "./helpers/activity-app.js";

const app = (store: AppDeps["store"]) => buildActivityTestApp({
  store,
  config: stub<Config>({ models: stub<Config["models"]>({ providers: ledgerProviders, prices: { autoUpdate: false } }) }),
  priceData: { catalog: () => ledgerCatalog }
});

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
  seedWake(db, "w-hb", "t-manager", "sweep");
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

// A timer's call is told by the reason the call recorded, as the Overview
// counts it: its wake's row is not asked.
test("view=timers and a row's wake read what the call recorded, not its wake's row", async () => {
  const { env, db } = freshLedgerDb();
  seedWake(db, "w-alarm", "t-global", "alarm");
  seedWake(db, "w-user", "t-manager", "user");
  seedCall(db, { id: "recorded", scopeId: "t-global", t: 0, metadata: { wakeId: "w-alarm", wakeReason: "alarm" } });
  // Its wake's row says alarm; the call recorded nothing.
  seedCall(db, { id: "unrecorded", scopeId: "t-global", t: MIN, metadata: { wakeId: "w-alarm", wakeReason: null } });
  seedCall(db, { id: "user", t: 2 * MIN, metadata: { wakeId: "w-user", wakeReason: "user" } });
  const hono = app(env.store);
  const wakes = async () => Object.fromEntries((await list(hono, "")).map((c) => [c.id, c.ledger?.wakeKey]));
  expect(ids(await list(hono, "view=timers&days=7"))).toEqual(["recorded"]);
  expect(await wakes()).toEqual({ recorded: "alarms", unrecorded: "unknown", user: "messages" });
  // The thread's wakes go; nothing moves.
  db.prepare("delete from agent_wakes").run();
  expect(ids(await list(hono, "view=timers&days=7"))).toEqual(["recorded"]);
  expect(await wakes()).toEqual({ recorded: "alarms", unrecorded: "unknown", user: "messages" });
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
  // A reported amount ($0.0042, a hundredth of its list price): its extra scaled the same.
  expect(calls.r1!.ledger?.verdict).toMatchObject({ kind: "expired", extraMicros: 3_800 });
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
  // A reported amount, split as its model's rates share it.
  const reported = await (await hono.request("/api/activity/calls/r")).json() as Extract<LlmCallDetailResponse, { call: unknown }>;
  expect(reported.call.tokenSplit!.rows).toEqual([
    { kind: "output", tokens: 1_000, micros: 200 },
    { kind: "uncached_input", tokens: 100_000, micros: 4_000 }
  ]);
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

// The page shows a view's totals from its first page; an older page is only
// more rows, read with the same cursor.
test("an older page of a period view lists the next calls and leaves the totals to the first page", async () => {
  const { env, db } = freshLedgerDb();
  seedExpiredMix(db);
  const hono = app(env.store);
  const page = async (query: string) => (await (await hono.request(`/api/activity/calls?limit=1&${query}`)).json()) as LlmCallsResponse;
  for (const view of ["view=expired&days=7", "agent=managers&days=7"]) {
    const first = await page(view);
    expect(first.totals?.calls).toBeGreaterThan(1);
    const last = first.calls.at(-1)!;
    const older = await page(`${view}&before=${encodeURIComponent(last.createdAt)}&beforeId=${encodeURIComponent(last.id)}`);
    expect(older.calls).toHaveLength(1);
    expect(older.calls[0]!.id).not.toBe(last.id);
    expect(older.totals).toBeUndefined();
  }
});

/** The SQL `run` prepares on `db`, the server's own connection, its whitespace collapsed. */
const preparedOn = async (db: Database, run: () => Promise<unknown>) => (await preparedByAsync(db, run)).map((sql) => sql.replace(/\s+/g, " "));

// A month of every thread's steps is read to judge which expired: on the
// server's own thread that held every agent and request for a fifth of a
// second, on every page of the view.
test("Cache expired is judged off the server's thread: its connection never reads the window's steps", async () => {
  const { env, db } = freshLedgerDb();
  seedExpiredMix(db);
  const hono = app(env.store);
  let body: LlmCallsResponse | null = null;
  const sql = await preparedOn(db, async () => { body = (await (await hono.request("/api/activity/calls?limit=100&view=expired&days=7")).json()) as LlmCallsResponse; });
  expect(ids(body!.calls)).toEqual(["s1", "s3"]);
  expect(body!.totals).toEqual({ calls: 2, extraMicros: expect.any(Number) });
  expect(sql.filter((s) => s.includes("purpose in ('agent_wake_step', 'agent_compression', 'agent_cache_seal') and created_at > ?"))).toEqual([]);
});

// A count is all the timers and agent views show, over a month of calls
// (a timer is told by its turn's reason, looked up call by call): counted
// off the server's thread, never read out one by one on it.
test("a period view's totals are counted off the server's thread", async () => {
  const { env, db } = freshLedgerDb();
  seedExpiredMix(db);
  seedWake(db, "w-alarm", "t-global", "alarm");
  seedCall(db, { id: "alarm", scopeId: "t-global", t: 2 * MIN, metadata: { wakeId: "w-alarm" } });
  const hono = app(env.store);
  for (const [query, calls] of [["agent=managers&days=7", 4], ["view=timers&days=7", 1]] as const) {
    let totals: LlmCallsResponse["totals"];
    const sql = await preparedOn(db, async () => { totals = ((await (await hono.request(`/api/activity/calls?limit=1&${query}`)).json()) as LlmCallsResponse).totals; });
    expect(totals).toEqual({ calls, extraMicros: null });
    expect(sql.filter((s) => /^\s*select (id|count\(\*\)( as n)?) from llm_calls/.test(s))).toEqual([]);
  }
});

// A provider is the name a call's connection has in Settings.
test("the provider filter keeps every call of the provider, newest first, page by page", async () => {
  const { env, db } = freshLedgerDb();
  const add = (id: string, minutes: number, provider: string, providerName: string) => {
    const at = new Date(Date.parse("2026-10-20T10:00:00.000Z") + minutes * MIN).toISOString();
    db.prepare(`insert into llm_calls (id, purpose, scope_type, scope_id, provider, provider_name, model, status, started_at, created_at, updated_at)
      values (?, 'agent_wake_step', 'agent_thread', 't-manager', ?, ?, 'model-a', 'succeeded', ?, ?, ?)`).run(id, provider, providerName, at, at, at);
  };
  add("named-old", 0, "openai", "solo");
  add("family", 1, "solo", "solo");
  add("other-name", 2, "solo", "elsewhere");
  add("named-new", 3, "anthropic", "solo");
  add("busy", 4, "openai", "gw");
  const hono = app(env.store);
  const page = async (query: string) => ((await (await hono.request(`/api/activity/calls?limit=2&provider=solo${query}`)).json()) as LlmCallsResponse).calls.map((c) => c.id);
  const first = await page("");
  expect(first).toEqual(["named-new", "family"]);
  const cursor = env.store.listLlmCallSummaries(1, { q: "family" })[0]!;
  expect(await page(`&before=${encodeURIComponent(cursor.createdAt)}&beforeId=family`)).toEqual(["named-old"]);
});

test("Cache expired's extra is unknown, not $0, when none of its calls has rates", async () => {
  const { env, db } = freshLedgerDb();
  seedCall(db, { id: "a", model: "anthropic/claude-unpriced", t: 0, source: "reported", micros: 5_000 });
  seedCall(db, { id: "b", model: "anthropic/claude-unpriced", t: 10 * MIN, source: "reported", micros: 5_000 });
  const body = (await (await app(env.store).request("/api/activity/calls?view=expired&days=7")).json()) as LlmCallsResponse;
  expect(body.totals).toEqual({ calls: 1, extraMicros: null });
});

test("each row names where its thread is: a manager's, the personal agent, a worker's under its manager", async () => {
  const { env, db } = freshLedgerDb();
  db.exec("pragma foreign_keys = off");
  db.prepare(`insert into workers (id, project_id, name, mode, tmux_window_name, ownership, created_at, updated_at, owner_thread_id)
    values ('wkr-1', 'proj-1', 'Invented worker', 'shared-cwd', 'w1', 'app', ?, ?, 't-manager')`).run(new Date().toISOString(), new Date().toISOString());
  db.prepare("update agent_threads set scope_id = 'wkr-1' where id = 't-worker'").run();
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
  expect(calls.cw).toMatchObject({ link: { to: "worker", threadId: "t-manager", workerId: "wkr-1" } });
  expect(calls.m).toMatchObject({ threadTitle: "Invented manager", link: { to: "thread", threadId: "t-manager" } });
  expect(calls.g).toMatchObject({ link: { to: "agent" } });
  expect(calls.w).toMatchObject({ threadTitle: "Invented worker", link: { to: "worker", threadId: "t-manager", workerId: "wkr-1" } });
  expect(calls.p).toMatchObject({ link: null });
});

// The log has a view of the tool-call review's calls that held one back.
test("the Held back filter lists only held reviews", async () => {
  const { env, db } = freshLedgerDb();
  seedCall(db, { id: "held", purpose: "tool_review", t: 0, metadata: { stage: "second_look", verdict: "held" } });
  seedCall(db, { id: "allowed", purpose: "tool_review", t: MIN, metadata: { stage: "second_look", verdict: "allowed" } });
  seedCall(db, { id: "screen", purpose: "tool_review", t: 2 * MIN, metadata: { stage: "screen" } });
  // Another purpose's metadata that happens to say held is not a review.
  seedCall(db, { id: "other", t: 3 * MIN, metadata: { verdict: "held" } });
  seedCall(db, { id: "broken", purpose: "tool_review", t: 4 * MIN, metadata: "{not json" });
  const res = await app(env.store).request("/api/activity/calls?limit=100&view=held");
  expect(res.status).toBe(200);
  expect(((await res.json()) as LlmCallsResponse).calls.map((c) => c.id)).toEqual(["held"]);
});
