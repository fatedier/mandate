import type { RateSet } from "../pricing/rates.js";

/**
 * Whether a step paid for a prompt the cache should have held, and why.
 *
 * A step's prompt is the previous step's prompt plus what happened since, so
 * the previous step's input is what this one could have read from the cache.
 * When it read clearly less, the difference was sent again: written to the
 * cache, or read as plain input. The verdict says which kind of loss it was;
 * "Cache expired" only where the cache's lifetime is fixed and known — from
 * the request (Mandate marks a cache, with a lifetime, on its Anthropic-
 * protocol calls) and the response (which says how long it kept what it wrote).
 */

/** One call of a thread, as the verdicts read it. */
export interface StepCall {
  id: string;
  purpose: string;
  model: string | null;
  /** The connection's API type (`anthropic`, `openai-compatible`, …). */
  apiType: string | null;
  /** The connection's name, or the provider type when none was recorded. */
  connection: string | null;
  status: string;
  inputTokens: number | null;
  /** The prompt the model read, when the call billed more (a continued
   *  Google reply sums its requests' prompts): what a later step can reuse. */
  contextTokens?: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cacheWrite1hTokens: number | null;
  /** Null when the provider did not split its writes by lifetime. */
  cacheWrite5mTokens: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** What the call's cache marks asked the provider for (Anthropic); null on
   *  calls recorded before it was kept, which asked for an hour. */
  requestedCacheTtl?: "5m" | "1h" | null;
}

export type CacheVerdictKind = "expired" | "miss" | "not_reused" | "rebuild";

export interface CacheVerdict {
  kind: CacheVerdictKind;
  /** From the previous call's end to this call's start: how long the thread sat. */
  idleMs: number;
  /** From the previous call's start to this call's start: what a cache's
   *  lifetime is measured against (it runs from the start of the request
   *  that wrote or read it, not from the end of its response). */
  sinceStartMs: number;
  /** Prompt tokens the previous call left in the cache that this one did not read. */
  shortfallTokens: number;
  /** The part of the shortfall this call wrote to the cache. */
  writtenTokens: number;
  /** Of that, the part written for an hour, in the call's own 1-hour share. */
  written1hTokens: number;
  /** The cache's fixed lifetime, when it has one. */
  lifetimeMs: number | null;
  /** What Mandate asked the provider to keep it for; null when it set no cache. */
  requestedLifetimeMs: number | null;
  /** What the previous call's response says it kept it for; null unreported. */
  writtenLifetimeMs: number | null;
  rebuildCause: "compaction" | "model" | null;
  previousModel: string | null;
}

const STEP = "agent_wake_step";
const COMPACTION = "agent_compression";
const SEAL = "agent_cache_seal";
const SUCCEEDED = "succeeded";

/** Below both, a shortfall is noise. */
const MIN_SHORTFALL_TOKENS = 2000;
const MIN_SHORTFALL_SHARE = 0.05;

const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;


/**
 * A cache with a fixed lifetime is one Mandate set: on its Anthropic-protocol
 * calls it marks the prompt for caching, and the provider keeps what it wrote
 * for five minutes, or an hour when it says it wrote for an hour. Elsewhere
 * (automatic caching, or Claude behind another protocol) no time is promised.
 */
export function fixedCacheLifetimeMs(apiType: string | null, previousWrote1h: boolean): number | null {
  if (apiType !== "anthropic") return null;
  return previousWrote1h ? ONE_HOUR : FIVE_MINUTES;
}

/** A step that marked its messages for five minutes: an hour-long write
 *  there is its system instruction, the messages were kept five minutes. */
const marksMessagesShort = (previous: StepCall) => previous.requestedCacheTtl === "5m";

/** How long the previous call's response says it kept what it wrote. */
function writtenLifetimeMs(previous: StepCall): number | null {
  if (marksMessagesShort(previous) && count(previous.cacheWrite5mTokens) > 0) return FIVE_MINUTES;
  if (count(previous.cacheWrite1hTokens) > 0) return ONE_HOUR;
  if (count(previous.cacheWrite5mTokens) > 0) return FIVE_MINUTES;
  return null;
}

const count = (value: number | null) => (value !== null && Number.isFinite(value) && value > 0 ? value : 0);

function timeOf(primary: string | null, fallback: string): number {
  const at = Date.parse(primary ?? fallback);
  return Number.isNaN(at) ? Date.parse(fallback) : at;
}

/** A call a later one can be judged against: a succeeded step, compaction
 *  or cache seal (which rewrites the end of a quiet thread for an hour). */
function isAnchor(call: StepCall): boolean {
  return call.status === SUCCEEDED && (call.purpose === STEP || call.purpose === COMPACTION || call.purpose === SEAL);
}

/** What Mandate asked to keep the previous call's cache for: its marks'
 *  lifetime, an hour on calls from before it was recorded. */
function requestedLifetimeMs(previous: StepCall): number {
  return previous.requestedCacheTtl === "5m" ? FIVE_MINUTES : ONE_HOUR;
}

/** A succeeded step judged against the thread's last succeeded step or
 *  compaction before it; null when it is not judged. */
export function judgeStep(previous: StepCall | null, call: StepCall): CacheVerdict | null {
  if (!previous || !isAnchor(previous) || call.purpose !== STEP || call.status !== SUCCEEDED) return null;
  const input = count(call.inputTokens);
  const shortfall = Math.min(count(previous.contextTokens ?? previous.inputTokens), input) - count(call.cacheReadTokens);
  if (shortfall <= MIN_SHORTFALL_TOKENS || shortfall <= MIN_SHORTFALL_SHARE * input) return null;

  const startedAt = timeOf(call.startedAt, call.createdAt);
  const idleMs = Math.max(0, startedAt - timeOf(previous.finishedAt, previous.createdAt));
  const sinceStartMs = Math.max(0, startedAt - timeOf(previous.startedAt, previous.createdAt));
  const writtenTokens = Math.min(shortfall, count(call.cacheWriteTokens));
  const written1hTokens = count(call.cacheWriteTokens) > 0
    ? Math.round(writtenTokens * Math.min(1, count(call.cacheWrite1hTokens) / count(call.cacheWriteTokens)))
    : 0;
  // A seal marks its end for an hour: one that wrote nothing found it kept
  // for an hour already, and that hour is still the cache's. One that wrote
  // for five minutes (the provider shortened it) keeps its five minutes.
  const sealFoundHour = previous.purpose === SEAL && count(previous.cacheWriteTokens) === 0;
  const lifetimeMs = fixedCacheLifetimeMs(call.apiType, !marksMessagesShort(previous) && (count(previous.cacheWrite1hTokens) > 0 || sealFoundHour));
  const base = {
    idleMs, sinceStartMs, shortfallTokens: shortfall, writtenTokens, written1hTokens, lifetimeMs,
    requestedLifetimeMs: call.apiType === "anthropic" ? requestedLifetimeMs(previous) : null,
    writtenLifetimeMs: call.apiType === "anthropic" ? writtenLifetimeMs(previous) : null,
    previousModel: previous.model
  };

  if (previous.purpose === COMPACTION) return { kind: "rebuild", ...base, rebuildCause: "compaction" };
  if (previous.model !== call.model || previous.connection !== call.connection) return { kind: "rebuild", ...base, rebuildCause: "model" };
  if (lifetimeMs === null) return { kind: "not_reused", ...base, rebuildCause: null };
  return { kind: sinceStartMs > lifetimeMs ? "expired" : "miss", ...base, rebuildCause: null };
}

/**
 * One thread's calls judged in time order, each against the last succeeded
 * step or compaction before it — `before` for the first, when the caller
 * found one earlier than these. Failed and running calls are neither judged
 * nor judged against: a retry is measured from the call that succeeded.
 */
export function judgeSequence(calls: StepCall[], before: StepCall | null = null): Map<string, CacheVerdict> {
  const verdicts = new Map<string, CacheVerdict>();
  const ordered = [...calls].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // judgeStep refuses a previous call that is no anchor, `before` included.
  let previous = before;
  for (const call of ordered) {
    const verdict = judgeStep(previous, call);
    if (verdict) verdicts.set(call.id, verdict);
    if (isAnchor(call)) previous = call;
  }
  return verdicts;
}

/** What the shortfall cost above reading it from the cache, in micro-dollars,
 *  at the call's rates (a missing cache rate is the input rate; a missing
 *  1-hour rate the write rate). Never below 0. */
export function extraMicros(verdict: CacheVerdict, rates: RateSet): number {
  const read = rates.cacheRead ?? rates.input;
  const write = rates.cacheWrite ?? rates.input;
  const write1h = rates.cacheWrite1h ?? write;
  const written1h = Math.min(verdict.written1hTokens, verdict.writtenTokens);
  const unwritten = verdict.shortfallTokens - verdict.writtenTokens;
  const usd = ((verdict.writtenTokens - written1h) * (write - read) + written1h * (write1h - read) + unwritten * (rates.input - read)) / 1_000_000;
  return Number.isFinite(usd) && usd > 0 ? Math.round(Number((usd * 1_000_000).toPrecision(12))) : 0;
}
