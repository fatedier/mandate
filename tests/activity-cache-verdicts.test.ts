import { expect, test } from "bun:test";
import {
  extraMicros,
  fixedCacheLifetimeMs,
  judgeSequence,
  judgeStep,
  type CacheVerdict,
  type StepCall
} from "../src/server/modules/activity/cache-verdicts.js";
import { loadWindowVerdicts } from "../src/server/modules/activity/window-verdicts.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const t = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

let n = 0;
function step(o: Partial<StepCall> & { input?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number; cacheWrite5m?: number | null; at?: number; took?: number } = {}): StepCall {
  const at = o.at ?? 0;
  const model = o.model === undefined ? "anthropic/claude-opus-x" : o.model;
  return {
    id: o.id ?? `c${++n}`,
    purpose: o.purpose ?? "agent_wake_step",
    model,
    // Mandate marks a cache on its Anthropic-protocol calls; a fixture's
    // Claude goes that way unless it says otherwise.
    apiType: o.apiType ?? (model?.includes("claude") ? "anthropic" : "openai-compatible"),
    connection: o.connection ?? "gw",
    status: o.status ?? "succeeded",
    inputTokens: o.input ?? 100_000,
    cacheReadTokens: o.cacheRead ?? 0,
    cacheWriteTokens: o.cacheWrite ?? 0,
    cacheWrite1hTokens: o.cacheWrite1h ?? 0,
    cacheWrite5mTokens: o.cacheWrite5m === undefined ? null : o.cacheWrite5m,
    startedAt: o.startedAt ?? t(at),
    finishedAt: o.finishedAt === undefined ? t(at + (o.took ?? 10_000)) : o.finishedAt,
    createdAt: o.createdAt ?? t(at),
    ...(o.requestedCacheTtl !== undefined ? { requestedCacheTtl: o.requestedCacheTtl } : {})
  };
}

test("expired: Claude idle past five minutes", () => {
  const prev = step({ input: 100_000, at: 0, took: 0 });
  const call = step({ input: 110_000, cacheRead: 20_000, cacheWrite: 89_000, at: 6 * MIN });
  expect(judgeStep(prev, call)).toEqual({
    kind: "expired", idleMs: 360_000, sinceStartMs: 360_000, shortfallTokens: 80_000, writtenTokens: 80_000, written1hTokens: 0,
    lifetimeMs: 300_000, requestedLifetimeMs: 3_600_000, writtenLifetimeMs: null, rebuildCause: null, previousModel: "anthropic/claude-opus-x"
  });
});

test("miss inside the lifetime; one hour when the previous call wrote a 1-hour cache", () => {
  const prev = step({ at: 0, took: 0 });
  expect(judgeStep(prev, step({ cacheRead: 10_000, at: 4 * MIN }))?.kind).toBe("miss");
  // Exactly the lifetime is still inside it.
  expect(judgeStep(prev, step({ cacheRead: 10_000, at: 5 * MIN }))?.kind).toBe("miss");
  const prev1h = step({ at: 0, took: 0, cacheWrite: 50_000, cacheWrite1h: 50_000 });
  expect(judgeStep(prev1h, step({ cacheRead: 10_000, at: 30 * MIN }))).toMatchObject({ kind: "miss", lifetimeMs: 3_600_000 });
  expect(judgeStep(prev1h, step({ cacheRead: 10_000, at: 61 * MIN }))).toMatchObject({ kind: "expired", lifetimeMs: 3_600_000 });
});

test("not_reused for a model without a fixed lifetime, at any idle", () => {
  const prev = step({ model: "openai/gpt-x", at: 0, took: 0 });
  expect(judgeStep(prev, step({ model: "openai/gpt-x", cacheRead: 10_000, at: 120 * MIN }))).toMatchObject({ kind: "not_reused", lifetimeMs: null });
  expect(judgeStep(prev, step({ model: "openai/gpt-x", cacheRead: 10_000, at: MIN }))?.kind).toBe("not_reused");
});

test("rebuild after a compaction and after a model or connection change", () => {
  const compaction = step({ purpose: "agent_compression", at: 0, took: 0 });
  expect(judgeStep(compaction, step({ cacheRead: 0, at: 10 * MIN }))).toMatchObject({ kind: "rebuild", rebuildCause: "compaction" });
  const other = step({ model: "deepseek/deepseek-x", at: 0, took: 0 });
  expect(judgeStep(other, step({ at: MIN }))).toMatchObject({ kind: "rebuild", rebuildCause: "model", previousModel: "deepseek/deepseek-x" });
  const elsewhere = step({ connection: "other-gw", at: 0, took: 0 });
  expect(judgeStep(elsewhere, step({ at: MIN }))).toMatchObject({ kind: "rebuild", rebuildCause: "model" });
});

test("small shortfalls are not judged", () => {
  // On a small prompt the 2,000-token floor decides: exactly 2,000 short is not over it.
  const prev = step({ input: 30_000, at: 0, took: 0 });
  expect(judgeStep(prev, step({ input: 30_000, cacheRead: 28_000, at: 10 * MIN }))).toBeNull();
  expect(judgeStep(prev, step({ input: 30_000, cacheRead: 27_999, at: 10 * MIN }))?.kind).toBe("expired");
  // Over 2,000 but not over 5% of a large prompt.
  const big = step({ input: 1_000_000, at: 0, took: 0 });
  expect(judgeStep(big, step({ input: 1_000_000, cacheRead: 950_000, at: 10 * MIN }))).toBeNull();
  expect(judgeStep(big, step({ input: 1_000_000, cacheRead: 949_999, at: 10 * MIN }))?.kind).toBe("expired");
  // The shortfall counts against the smaller prompt: a shrunk prompt is not a miss.
  expect(judgeStep(step({ input: 200_000, at: 0, took: 0 }), step({ input: 50_000, cacheRead: 50_000, at: 10 * MIN }))).toBeNull();
});

test("only a succeeded step is judged, against a succeeded call", () => {
  const prev = step({ at: 0, took: 0 });
  expect(judgeStep(prev, step({ status: "failed", at: 10 * MIN }))).toBeNull();
  expect(judgeStep(prev, step({ purpose: "agent_compression", at: 10 * MIN }))).toBeNull();
  expect(judgeStep(step({ status: "failed", at: 0 }), step({ at: 10 * MIN }))).toBeNull();
  expect(judgeStep(null, step({ at: 10 * MIN }))).toBeNull();
});

test("idle runs from the previous finish to this start, never below zero", () => {
  const prev = step({ at: 0, took: 2 * MIN });
  expect(judgeStep(prev, step({ at: 8 * MIN }))?.idleMs).toBe(6 * MIN);
  // No finish recorded: from when it was created; no start: from created.
  const noFinish = step({ at: 0, finishedAt: null });
  expect(judgeStep(noFinish, step({ at: 6 * MIN, startedAt: null }))?.idleMs).toBe(6 * MIN);
  const overlapping = step({ at: 0, took: 10 * MIN });
  expect(judgeStep(overlapping, step({ at: MIN }))?.idleMs).toBe(0);
});

test("a fixed lifetime only where Mandate marked the cache: its Anthropic-protocol calls", () => {
  expect(fixedCacheLifetimeMs("anthropic", false)).toBe(300_000);
  expect(fixedCacheLifetimeMs("anthropic", true)).toBe(3_600_000);
  expect(fixedCacheLifetimeMs("openai-compatible", false)).toBeNull();
  expect(fixedCacheLifetimeMs("kilo", true)).toBeNull();
  expect(fixedCacheLifetimeMs(null, false)).toBeNull();
  // Claude through an OpenAI-compatible gateway: Mandate set no cache, so no lifetime to expire.
  const prev = step({ model: "anthropic/claude-opus-x", apiType: "openai-compatible", at: 0, took: 0 });
  expect(judgeStep(prev, step({ model: "anthropic/claude-opus-x", apiType: "openai-compatible", at: 30 * MIN }))).toMatchObject({ kind: "not_reused", lifetimeMs: null, requestedLifetimeMs: null });
});

test("a verdict says what Mandate asked for and what the provider wrote", () => {
  const call = (o: Parameters<typeof step>[0]) => step({ at: 30 * MIN, ...o });
  // Reported as written for 5 minutes, though an hour was asked for.
  expect(judgeStep(step({ at: 0, took: 0, cacheWrite: 90_000, cacheWrite1h: 0, cacheWrite5m: 90_000 }), call({}))).toMatchObject({
    kind: "expired", lifetimeMs: 300_000, requestedLifetimeMs: 3_600_000, writtenLifetimeMs: 300_000
  });
  // Written for an hour: still inside it at 30 minutes.
  expect(judgeStep(step({ at: 0, took: 0, cacheWrite: 90_000, cacheWrite1h: 90_000, cacheWrite5m: 0 }), call({}))).toMatchObject({
    kind: "miss", lifetimeMs: 3_600_000, writtenLifetimeMs: 3_600_000
  });
  // The split not reported: five minutes assumed, nothing claimed about what was written.
  expect(judgeStep(step({ at: 0, took: 0, cacheWrite: 90_000, cacheWrite1h: 0 }), call({}))).toMatchObject({
    kind: "expired", lifetimeMs: 300_000, writtenLifetimeMs: null
  });
});

test("judgeSequence skips failed and running calls and judges a retry against the last success", () => {
  const ok = step({ id: "ok", at: 0, took: 0 });
  const failed = step({ id: "failed", status: "failed", at: 25 * MIN, input: 120_000 });
  const retry = step({ id: "retry", at: 26 * MIN, input: 120_000, cacheRead: 0, cacheWrite: 120_000 });
  const running = step({ id: "running", status: "running", at: 27 * MIN, finishedAt: null });
  const after = step({ id: "after", at: 27 * MIN + 30_000, input: 125_000, cacheRead: 120_000 });
  const verdicts = judgeSequence([after, running, retry, failed, ok]); // any order in, judged in time order
  expect(verdicts.get("retry")).toMatchObject({ kind: "expired", idleMs: 26 * MIN });
  expect(verdicts.has("failed")).toBe(false);
  expect(verdicts.has("running")).toBe(false);
  expect(verdicts.has("after")).toBe(false); // judged against retry: read it all
  expect([...verdicts.keys()]).toEqual(["retry"]);
});

test("judgeSequence uses the call before the window for the first one", () => {
  const before = step({ id: "before", at: 0, took: 0 });
  const first = step({ id: "first", at: 30 * MIN });
  expect(judgeSequence([first], before).get("first")?.kind).toBe("expired");
  expect(judgeSequence([first]).has("first")).toBe(false);
  expect(judgeSequence([first], step({ id: "before-failed", status: "failed", at: 0 })).has("first")).toBe(false);
});

function verdict(o: Partial<CacheVerdict>): CacheVerdict {
  return { kind: "expired", idleMs: 0, sinceStartMs: 0, shortfallTokens: 0, writtenTokens: 0, written1hTokens: 0, lifetimeMs: 300_000, requestedLifetimeMs: 3_600_000, writtenLifetimeMs: null, rebuildCause: null, previousModel: null, ...o };
}

test("extra at the call's rates, missing cache rates falling back to input", () => {
  expect(extraMicros(verdict({ shortfallTokens: 80_000, writtenTokens: 80_000 }), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })).toBe(384_000);
  expect(extraMicros(verdict({ shortfallTokens: 10_000, writtenTokens: 0 }), { input: 2, output: 10, cacheRead: 0.1 })).toBe(19_000);
  expect(extraMicros(verdict({ shortfallTokens: 10_000, writtenTokens: 4_000 }), { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 })).toBe(21_000);
  expect(extraMicros(verdict({ shortfallTokens: 10_000, writtenTokens: 0 }), { input: 2, output: 10 })).toBe(0);
  // A write priced below a read (a list's oddity) is no negative extra.
  expect(extraMicros(verdict({ shortfallTokens: 10_000, writtenTokens: 10_000 }), { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 })).toBe(0);
});

test("1-hour writes count at the 1-hour write rate in the extra", () => {
  const prev = step({ at: 0, took: 0 });
  const call = step({ at: 70 * MIN, cacheRead: 0, cacheWrite: 100_000, cacheWrite1h: 100_000 });
  const verdict = judgeStep(prev, call)!;
  expect(verdict.written1hTokens).toBe(100_000);
  // All of it written for an hour: (8 − 0.2) per 1M, not (5 − 0.2).
  expect(extraMicros(verdict, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 })).toBe(780_000);
  // Half for an hour.
  const half = judgeStep(prev, step({ at: 70 * MIN, cacheRead: 0, cacheWrite: 100_000, cacheWrite1h: 50_000 }))!;
  expect(half.written1hTokens).toBe(50_000);
  expect(extraMicros(half, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 })).toBe(630_000);
});

// A continued Google step bills the sum of its requests' prompts; the next
// step reuses what the model read, the context kept beside the sum.
test("a step after a continued one is judged against the context it read, not its billed sum", () => {
  const prev = step({ model: "gemini-4-argon", apiType: "google", input: 272_768, at: 0, took: 0 });
  const call = step({ model: "gemini-4-argon", apiType: "google", input: 185_540, cacheRead: 152_768, at: MIN });
  expect(judgeStep(prev, call)).not.toBeNull();
  expect(judgeStep({ ...prev, contextTokens: 120_000 }, call)).toBeNull();
});

test("the context kept on a call reaches the verdicts read from the database", () => {
  const env = freshStoresEnv("md-verdict-context-");
  try {
    const insert = env.store.db.prepare(`
      insert into llm_calls (id, purpose, scope_type, scope_id, model, provider, provider_name, status, input_tokens, cache_read_tokens, cache_write_tokens, metadata_json, started_at, finished_at, created_at, updated_at)
      values (?, 'agent_wake_step', 'agent_thread', 'thr_g', 'gemini-4-argon', 'google', 'goo', 'succeeded', ?, ?, 0, ?, ?, ?, ?, ?)`);
    insert.run("call_a", 272_768, 0, JSON.stringify({ contextInputTokens: 120_000 }), t(0), t(0), t(0), t(0));
    insert.run("call_b", 185_540, 152_768, null, t(MIN), t(MIN + 1000), t(MIN), t(MIN));
    expect(loadWindowVerdicts(env.store.db, t(-MIN)).has("call_b")).toBe(false);
  } finally { env.cleanup(); }
});

// A seal rewrites the end of a quiet thread for an hour: the step after it
// is judged against the seal, not the step before.
test("a step after a sealed pause is judged against the seal", () => {
  const first = step({ at: 0, input: 20_000, cacheWrite: 20_000, cacheWrite5m: 20_000, requestedCacheTtl: "5m" });
  const seal = step({ purpose: "agent_cache_seal", at: 270_000, input: 20_053, cacheRead: 20_000, cacheWrite: 53, cacheWrite1h: 53, requestedCacheTtl: "1h" });
  const read = step({ at: 670_000, input: 20_100, cacheRead: 20_053 });
  const missed = step({ at: 670_000, input: 20_100, cacheRead: 0 });
  expect(judgeSequence([first, seal, read]).has(read.id)).toBe(false);
  expect(judgeSequence([first, seal, missed]).get(missed.id)).toMatchObject({ kind: "miss", lifetimeMs: 3_600_000 });
  // The seal itself is not judged.
  expect(judgeSequence([first, seal]).has(seal.id)).toBe(false);
});

// A seal that found the end already kept for an hour writes nothing: the
// hour is still the cache's, not the five minutes of a call that wrote none.
test("a seal that only read keeps the hour it found", () => {
  const first = step({ at: 0, input: 20_000, cacheWrite: 20_000, cacheWrite1h: 20_000, requestedCacheTtl: "1h" });
  const seal = step({ purpose: "agent_cache_seal", at: 270_000, input: 20_053, cacheRead: 20_053, cacheWrite: 0, cacheWrite1h: 0, requestedCacheTtl: "1h" });
  const missed = step({ at: 270_000 + 20 * MIN, input: 20_100, cacheRead: 0 });
  expect(judgeSequence([first, seal, missed]).get(missed.id)).toMatchObject({ kind: "miss", lifetimeMs: 3_600_000 });
});

test("a seal that wrote for five minutes keeps its five minutes", () => {
  const first = step({ at: 0, input: 20_000, cacheWrite: 20_000, cacheWrite5m: 20_000, requestedCacheTtl: "5m" });
  const seal = step({ purpose: "agent_cache_seal", at: 270_000, input: 20_053, cacheRead: 20_000, cacheWrite: 53, cacheWrite1h: 0, cacheWrite5m: 53, requestedCacheTtl: "1h" });
  const missed = step({ at: 270_000 + 20 * MIN, input: 20_100, cacheRead: 0 });
  expect(judgeSequence([first, seal, missed]).get(missed.id)).toMatchObject({ kind: "expired", lifetimeMs: 300_000 });
});

// The cache a step found expired was written by the call before it: what
// that call asked for is what Mandate asked for (a sealed step asks for five
// minutes on purpose, which is not the provider shortening it).
test("a step's requested lifetime is what the call before it asked for", () => {
  const late = (prev: StepCall) => judgeStep(prev, step({ at: 20 * MIN, cacheRead: 0, cacheWrite: 100_000 }));
  expect(late(step({ at: 0, cacheWrite5m: 100_000, requestedCacheTtl: "5m" }))).toMatchObject({ kind: "expired", requestedLifetimeMs: 300_000 });
  expect(late(step({ at: 0, cacheWrite5m: 100_000 }))).toMatchObject({ kind: "expired", requestedLifetimeMs: 3_600_000 });
});

test("seals are anchors in the verdicts read from the database, with each call's requested lifetime", () => {
  const env = freshStoresEnv("md-verdict-seal-");
  try {
    const insert = env.store.db.prepare(`
      insert into llm_calls (id, purpose, scope_type, scope_id, model, provider, provider_name, status, input_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cache_write_5m_tokens, metadata_json, started_at, finished_at, created_at, updated_at)
      values (?, ?, 'agent_thread', 'thr_s', 'anthropic/claude-sonnet-x', 'anthropic', 'gw', 'succeeded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run("step_a", "agent_wake_step", 20_000, 0, 20_000, 0, 20_000, JSON.stringify({ cacheTtl: "5m" }), t(0), t(10_000), t(0), t(0));
    insert.run("seal_a", "agent_cache_seal", 20_053, 20_000, 53, 53, 0, JSON.stringify({ cacheTtl: "1h" }), t(270_000), t(272_000), t(270_000), t(270_000));
    insert.run("step_b", "agent_wake_step", 20_100, 0, 20_100, 0, 20_100, JSON.stringify({ cacheTtl: "5m" }), t(670_000), t(680_000), t(670_000), t(670_000));
    const verdicts = loadWindowVerdicts(env.store.db, t(-MIN));
    // Judged against the seal (an hour): a miss inside its lifetime, not an expiry of step_a's five minutes.
    expect(verdicts.get("step_b")).toMatchObject({ kind: "miss", lifetimeMs: 3_600_000, requestedLifetimeMs: 3_600_000 });
    expect(verdicts.has("seal_a")).toBe(false);
    // A window that starts after the seal judges its first step against it too.
    expect(loadWindowVerdicts(env.store.db, t(300_000)).get("step_b")).toMatchObject({ kind: "miss", lifetimeMs: 3_600_000 });
  } finally { env.cleanup(); }
});

// A sealed step writes its system instruction for an hour and its messages
// for five minutes: what a later step misses is the messages, kept five.
test("a step that marked its messages for five minutes kept them five, whatever it wrote for an hour", () => {
  const prev = step({ at: 0, took: 0, input: 60_000, cacheWrite: 60_000, cacheWrite1h: 20_000, cacheWrite5m: 40_000, requestedCacheTtl: "5m" });
  const after = (minutes: number) => judgeStep(prev, step({ at: minutes * MIN, input: 61_000, cacheRead: 20_000, cacheWrite: 41_000 }));
  expect(after(12)).toMatchObject({ kind: "expired", lifetimeMs: 300_000, requestedLifetimeMs: 300_000, writtenLifetimeMs: 300_000 });
  expect(after(4)).toMatchObject({ kind: "miss", lifetimeMs: 300_000 });
  // Asked for an hour (older rows, a paused model): the hour stands.
  const prev1h = step({ at: 0, took: 0, input: 60_000, cacheWrite: 60_000, cacheWrite1h: 20_000, cacheWrite5m: 40_000, requestedCacheTtl: "1h" });
  expect(judgeStep(prev1h, step({ at: 12 * MIN, input: 61_000, cacheRead: 20_000, cacheWrite: 41_000 }))).toMatchObject({ kind: "miss", lifetimeMs: 3_600_000, writtenLifetimeMs: 3_600_000 });
});

// Anthropic's docs: a cache's lifetime "is measured from the start of the
// request that writes or reads the cache entry, not from the end of its
// response". A step after a long call is judged from that call's start.
test("expired or miss is judged from the previous call's start; idle stays from its end", () => {
  const prev = step({ at: 0, took: 4 * MIN, input: 100_000, cacheWrite: 100_000, cacheWrite5m: 100_000, requestedCacheTtl: "5m" });
  const call = step({ at: 6 * MIN, input: 101_000, cacheRead: 0, cacheWrite: 101_000 });
  expect(judgeStep(prev, call)).toMatchObject({ kind: "expired", idleMs: 2 * MIN, sinceStartMs: 6 * MIN, lifetimeMs: 5 * MIN });
  expect(judgeStep(prev, step({ at: 5 * MIN, input: 101_000, cacheRead: 0, cacheWrite: 101_000 }))).toMatchObject({ kind: "miss", sinceStartMs: 5 * MIN });
});
