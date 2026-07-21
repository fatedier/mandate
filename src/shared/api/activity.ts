import type { ApiErrorResponse } from "./common.js";

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
  parentCallId: string | null;
  provider: string;
  /** For legacy calls without a recorded metadata.providerName: the unique
   *  current provider matching the recorded API type and base URL. */
  matchedProviderName?: string;
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
}

export interface LlmCallsResponse {
  calls: LlmCallSummaryDto[];
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
}

export interface ActivitySummaryResponse {
  days: number;
  daily: ActivityDailyDto[];
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
}
