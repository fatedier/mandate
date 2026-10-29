import type { ApiErrorResponse } from "./common.js";
import type { CallCostDto, PriceMatchDto } from "./pricing.js";

export interface LlmCallQuery {
  limit?: number;
  before?: string | null;
  /** The id of the row `before` came from. Rows are ordered by
   *  (created_at, id), so without it a page boundary falling inside a group
   *  that shares a millisecond skips the rest of that group for good. */
  beforeId?: string | null;
  status?: string | null;
  purpose?: string | null;
  provider?: string | null;
  model?: string | null;
  scopeType?: string | null;
  /** A single UTC day, `YYYY-MM-DD`. */
  day?: string | null;
  /** "1" for the calls the runtime marked as a fallback attempt, "0" for the
   *  rest — the two halves of the breakdown's fallback cut. */
  fallback?: string | null;
  q?: string | null;
  /** A ledger role (`managers`, `your_agent`, …): the calls By agent counted. */
  agent?: string | null;
  /** A preset: failed, slow (60 s or more), the Cache expired calls, or timers. */
  view?: LlmCallView | null;
  /** The page's window, for the views that answer a figure the Overview
   *  counted (Cache expired, Timers, an agent); ignored otherwise. */
  days?: number | null;
  /** The reader's time zone: `day` is their date. */
  tz?: string | null;
}

export type LlmCallView = "failed" | "slow" | "expired" | "timers";

/** Why a step paid for its prompt again; see the ledger's cache rows. */
export interface CacheVerdictDto {
  kind: ActivityCacheKind;
  /** From the previous call's end to this one's start: how long the thread sat. */
  idleMs: number;
  /** From the previous call's start to this one's start: what the cache's
   *  lifetime is measured against. */
  sinceStartMs: number;
  rewrittenTokens: number;
  /** Paid above reading the cache; null when the call's amount is not
   *  spend or its rates are not known. */
  extraMicros: number | null;
  lifetimeMs: number | null;
  /** What Mandate asked the provider to keep the cache for; null when it set none. */
  requestedLifetimeMs: number | null;
  /** What the previous call's response says it kept it for; null unreported. */
  writtenLifetimeMs: number | null;
  rebuildCause: "compaction" | "model" | null;
  previousModel: string | null;
}

/** Why a judgement's answer was not acted on: the thread stopped first (its
 *  stop ended the wait), a newer reply came first, the thread waits for the
 *  user's answer, a newer reply's verdict is kept, the thread was archived;
 *  for a memory repeat check, a stored memory it read changed meanwhile. */
export type JudgementNotUsed = "stopped" | "newer_reply" | "question_open" | "newer_verdict" | "archived" | "memory_changed";

/** The reply a manager check was about, and for a manager request check the
 *  request (Your agent's handoff). Times are ISO. */
export interface ReplyJudgementSubjectDto {
  replySeq: number;
  replyAt: string;
  handoffId?: string;
  requestAt?: string;
}

/** The memory a memory repeat check was about: its text, and the ids of the
 *  stored memories it was read beside, the most like it first. */
export interface MemoryJudgementSubjectDto {
  memory: string;
  similar: string[];
}

/** What a judgement was about. */
export type JudgementSubjectDto = ReplyJudgementSubjectDto | MemoryJudgementSubjectDto;

/** What a judgement answered, kept in the metadata of the call that gave it
 *  as `judgement`: the options it had, the one it chose, a decision model's
 *  probabilities, what it was about, and why it was not acted on, if not. */
export interface JudgementRecordDto {
  options: string[];
  answer: string;
  probabilities?: Record<string, number>;
  subject: JudgementSubjectDto;
  notUsed?: JudgementNotUsed;
}

/** Who made a call and what it paid for, as Logs shows it. */
export interface LlmCallLedgerDto {
  role: string;
  threadTitle: string | null;
  /** The call belongs to a thread that has been deleted. */
  threadDeleted: boolean;
  /** The call belongs to a thread (titled or not, shown somewhere or not,
   *  deleted or not), rather than to an agent of no thread (the dream). */
  inThread: boolean;
  /** The wake group key (`messages`, `alarms`, …), when the call ran in a wake. */
  wakeKey: string | null;
  /** Where its thread is shown: a manager's thread, Your agent, or a
   *  worker's tab in its manager's thread; null when nowhere. */
  link: { to: "thread"; threadId: string } | { to: "agent" } | { to: "worker"; threadId: string; workerId: string } | null;
  verdict: CacheVerdictDto | null;
}

/** A call's amount split by kind of token, the largest kinds first by fixed order. */
export interface TokenSplitDto {
  rows: Array<{ kind: "cache_write" | "cache_read" | "output" | "uncached_input"; tokens: number; micros: number }>;
}

interface LlmCallErrorSummaryDto {
  name?: string;
  message: string;
}

export interface LlmCallSummaryDto {
  id: string;
  purpose: string;
  scopeType: string | null;
  scopeId: string | null;
  provider: string;
  /** The connection's name in Settings when the call was made; null on the
   *  oldest calls, which recorded none. */
  providerName: string | null;
  model: string | null;
  baseURL: string | null;
  apiMode: string | null;
  requestHash: string;
  responseHash: string;
  request: null;
  response: null;
  output: null;
  usage: null;
  metadata: Record<string, unknown> | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  status: string;
  error: LlmCallErrorSummaryDto | null;
  startedAt: string | null;
  finishedAt: string | null;
  latencyMs: number | null;
  /** Time to first token: elapsed to the provider's first output part. Null for
   *  a call it never answered, and for every call recorded before 2026-08-04,
   *  when the column was added — nothing can backfill it. */
  ttftMs: number | null;
  createdAt: string;
  updatedAt: string;
  /** What it cost; null while it waits to be priced. */
  cost: CallCostDto | null;
  /** Role, thread, wake and cache verdict, on the list and detail routes. */
  ledger?: LlmCallLedgerDto;
}

export interface LlmCallDetailDto extends Omit<
  LlmCallSummaryDto,
  "request" | "response" | "output" | "usage" | "error"
> {
  request: unknown;
  response: unknown;
  output: unknown;
  usage: unknown;
  error: unknown;
  /** For an Unpriced call: a catalog model its name looks like, to offer. */
  priceSuggestion: PriceMatchDto | null;
  /** Its amount by kind of token, on the detail route; null without rates. */
  tokenSplit?: TokenSplitDto | null;
}

export interface LlmCallsResponse {
  calls: LlmCallSummaryDto[];
  /** For a view that answers an Overview figure (Cache expired, Timers, an
   *  agent): all its calls in the window, and for Cache expired what they
   *  paid on top of a cache read — the same figures the Overview shows. */
  totals?: { calls: number; extraMicros: number | null };
}

export type LlmCallDetailResponse = {
  call: LlmCallDetailDto;
} | ApiErrorResponse;

export interface ActivityDailyDto {
  date: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ActivityBucketDto {
  /** One of "<1s" | "1-5s" | "5-15s" | "15-60s" | ">60s". */
  bucket: string;
  calls: number;
}

/**
 * The dimensions the breakdown can group by, in the order the selector offers
 * them. `status` is deliberately absent: it is a column on every group
 * (`failed`), not a key — one row per purpose, not one per purpose × status.
 *
 * One list, and the type below is read off it rather than written beside it.
 * The client and the server each need the values at runtime — one to offer the
 * pills, one to validate `?group=` — and two hand-written lists over the same
 * union are both individually valid to TypeScript however far apart they drift:
 * the client would go on offering a dimension the server had stopped answering
 * for, silently serving the `model` cut under the other one's heading. Derived,
 * a dimension can only be added or removed here, and every `switch` and
 * `Record<ActivityGroupKey, …>` over it is then a completeness check.
 */
export const ACTIVITY_GROUP_KEYS = ["model", "purpose", "scopeType", "day", "fallback"] as const;

export type ActivityGroupKey = (typeof ACTIVITY_GROUP_KEYS)[number];

export interface ActivityGroupDto {
  /** Stable identity, and what a row click filters the log by. */
  key: string;
  /** What the reader sees. Equal to `key` for every dimension today; separate
   *  so a future dimension can render something the filter would not accept. */
  label: string;
  calls: number;
  failed: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** The whole prompt, cached part included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Calls in this group the runtime recorded as a fallback attempt rather than
   *  a first try. */
  fallbackCalls: number;
  /** Most frequent first. Empty when the group had no failures. */
  reasons: Array<{ reason: string; calls: number }>;
  /** Reported and estimated spend, micro-dollars. */
  spendMicros: number;
  /** Some of that spend is an estimate rather than a reported charge. */
  spendEstimated: boolean;
  unpricedCalls: number;
}

/** The window's spend. Included and Free calls are not spend; Unpriced ones
 *  are counted, never added as 0. */
export interface ActivitySpendDto {
  micros: number;
  reportedMicros: number;
  estimated: boolean;
  /** Calls with an amount (reported or estimated): with none, the total
   *  is not a figure to show. */
  pricedCalls: number;
  unpricedCalls: number;
  includedCalls: number;
  includedApiMicros: number;
  /** Calls not priced yet (older calls are priced in the background). */
  pendingCalls: number;
}

/** How a ledger row's money reads: spend when any of its calls cost
 *  something; else what its calls were (included in a plan, free, unpriced). */
export type LedgerMoneyKind = "spend" | "included" | "free" | "unpriced" | "none";

export interface ActivityLedgerDayDto {
  /** UTC day, as `daily` keys its days. */
  date: string;
  spendMicros: number;
  /** What the day's Cache expired calls paid above reading the cache. */
  expiredExtraMicros: number;
}

export interface ActivityAgentRowDto {
  /** A role key (`managers`, `your_agent`, …, `deleted_thread`) or
   *  `purpose:<id>` for a purpose no role names. */
  role: string;
  calls: number;
  spendMicros: number;
  expiredExtraMicros: number;
  money: LedgerMoneyKind;
}

export type ActivityCacheKind = "expired" | "miss" | "not_reused" | "rebuild";

export interface ActivityCacheRowDto {
  kind: ActivityCacheKind;
  calls: number;
  /** Of those, the calls whose extra is known (spend with rates): with none,
   *  the row's extra is unknown, not $0. */
  pricedCalls: number;
  /** Prompt tokens sent again that the cache could have served. */
  rewrittenTokens: number;
  /** Paid above reading them from the cache, on calls whose amount is spend. */
  extraMicros: number;
  /** For `not_reused`: the model family with the most extra (`gpt`). */
  topFamily: string | null;
}

export interface ActivityWakeRowDto {
  /** A wake group key (`messages`, `alarms`, …, `dream`, `manager_request_check`),
   *  or a wake reason no group names. */
  key: string;
  timer: boolean;
  runs: number;
  spendMicros: number;
  expiredExtraMicros: number;
  /** The roles among its runs, most spend first. */
  roles: string[];
  money: LedgerMoneyKind;
}

/** The Overview's money: where the window's spend went and what made it. */
export interface ActivityLedgerDto {
  /** The same length of time before the window; null when it had no spend. */
  previousSpendMicros: number | null;
  days: ActivityLedgerDayDto[];
  agents: ActivityAgentRowDto[];
  cache: {
    /** Expired, miss, not reused, rebuild, in that order; rows with no calls left out. */
    rows: ActivityCacheRowDto[];
    expiredWithinHour: number;
    medianExpiredIdleMs: number | null;
    /** Some call in the window wrote a 1-hour cache. */
    wrote1h: boolean;
  };
  tokens: {
    uncachedInputMicros: number;
    cacheReadMicros: number;
    cacheWriteMicros: number;
    outputMicros: number;
    reportedUnsplitMicros: number;
  };
  wakes: ActivityWakeRowDto[];
  /** The newest price data date among the window's estimates. */
  priceDataDate: string | null;
  /** Cache write over cache read for the Claude model with the most spend. */
  claudeWriteReadRatio: number | null;
}

/** Why a model's cache seal is paused. */
export type CacheSealFailure = "short_write" | "output" | "errors" | "not_read" | "prefix_changed";

/** A model whose cache seal is paused, and when a seal is tried again. */
export interface CacheSealPauseDto {
  model: string;
  failure: CacheSealFailure;
  /** ISO time a seal may go through again, as a try. */
  nextTryAt: string;
  /** The seal's output tokens, for an `output` failure. */
  outputTokens?: number;
}

export interface ActivitySummaryResponse {
  days: number;
  /** The one day of the window this answer counts, when the reader picked one. */
  day?: string | null;
  ledger: ActivityLedgerDto;
  spend: ActivitySpendDto;
  daily: ActivityDailyDto[];
  /** The reader's dates the chart draws, oldest first: every date from the
   *  first with calls to today, silent ones included. The server cuts them,
   *  so the chart, a picked day and the log agree on where a day starts. */
  dates: string[];
  buckets: ActivityBucketDto[];
  group: ActivityGroupKey;
  groups: ActivityGroupDto[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Time-to-first-token percentiles, and how many calls in the window carried
   *  one at all. The count is what tells a reader whether the figures beside it
   *  describe the window or a corner of it: the column is newer than the
   *  window, so early on almost nothing has it. */
  ttft: {
    calls: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
  /** The models whose cache seal is paused now, whatever the window. */
  cacheSeal?: { paused: CacheSealPauseDto[] };
}
