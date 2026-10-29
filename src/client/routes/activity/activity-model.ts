import type { ActivityDailyDto } from "@shared/api-contracts";
import { formatTokenCount } from "@shared/format-tokens";
import { formatDuration } from "@/lib/format";

/** Output tokens per second of wall clock. Null when the rate is not defined —
 *  a call with no elapsed time or no output has no speed, and rendering
 *  Infinity into a right-aligned numeric column is worse than rendering "—". */
export function tokensPerSecond(
  outputTokens: number | null,
  latencyMs: number | null
): number | null {
  if (!outputTokens || !latencyMs) return null;
  return Math.round((outputTokens / latencyMs) * 1000 * 10) / 10;
}

/**
 * Share of the prompt that came from cache, as a percentage.
 *
 * `input_tokens` is the whole prompt and `cache_read_tokens` is the part of it
 * that was cached — a subset, not a sibling. The provider's own accounting
 * says so: `inputTokenDetails.cacheReadTokens` is one of the parts
 * `input_tokens` is the sum of, so it is never above it.
 *
 * This used to add the two, which counted the cached half twice and halved
 * every reading: a hit rate of 90% would read as 47%, and the total prompt
 * as nearly twice its size. The names invite it — two columns, both
 * counting input tokens — so the relationship is stated here rather than left
 * to whoever writes the next caller.
 *
 * Null only when nothing was read at all; zero is a genuine reading and one
 * worth showing, since those are the calls the average conceals.
 */
export function cacheHitRate(
  inputTokens: number | null,
  cacheReadTokens: number | null
): number | null {
  return sharePercent(cacheReadTokens, inputTokens);
}

/**
 * A part as a percentage of the whole it belongs to, to one decimal.
 *
 * The two pairs this serves are containments, not comparisons:
 * `cacheReadTokens <= inputTokens` and `reasoningTokens <= outputTokens` hold
 * without exception. One formula so the two never disagree about what a share
 * means.
 */
export function sharePercent(part: number | null, whole: number | null): number | null {
  const total = whole ?? 0;
  if (total === 0) return null;
  return Math.round(((part ?? 0) / total) * 1000) / 10;
}

/** Milliseconds as a figure that fits a column: sub-second in ms, then one
 *  decimal, then whole seconds once the decimal stops carrying, then from a
 *  minute up the app's own "1m 05s" / "1h 05m" (it read "3923s"). Seconds are
 *  rounded first, so 59.6s reads "1m 00s", not "60s". */
export function formatCallDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1000);
}

/** A token count for a column three characters wide: thousands and millions
 *  carry one decimal, anything under a thousand is written out. Shared by the
 *  Overview's headline figures and the log row's input column so the two
 *  cannot render the same number differently — `—` for a count that was never
 *  recorded, which is not the same reading as zero. */
export { formatTokenCount };

/** A percentile out of the summary endpoint, which is not quite a duration.
 *  Its window function skips null latencies but its coalesce does not: a group
 *  whose calls all recorded a null latency answers 0, indistinguishable from a
 *  measured 0ms. Zero therefore reads as "nothing measured", not as "instant" —
 *  no real call returns in under half a millisecond. */
export function formatPercentileMs(ms: number | null): string {
  if (!ms) return "—";
  return formatCallDurationMs(ms);
}

/** Which of the summary's five latency buckets a duration falls in. Mirrors
 *  the CASE in `activity-summary.ts`; kept here rather than inside the panel
 *  because an index off by one silently pins p95 onto the wrong bar, and
 *  nothing else on the page contradicts it. */
const BUCKET_EDGES_MS = [1000, 5000, 15_000, 60_000];

export function latencyBucketIndex(ms: number): number {
  const found = BUCKET_EDGES_MS.findIndex((edge) => ms < edge);
  return found < 0 ? BUCKET_EDGES_MS.length : found;
}


/** One row per date the server names for the chart, oldest first: a date
 *  without calls has no row, and becomes a bar of zero rather than a gap
 *  that would put 1 Aug beside 4 Aug. */
export function dailyForDates(daily: ActivityDailyDto[], dates: readonly string[]): ActivityDailyDto[] {
  const byDate = new Map(daily.map((day) => [day.date, day]));
  return dates.map((date) => byDate.get(date) ?? emptyDay(date));
}

function emptyDay(date: string): ActivityDailyDto {
  return {
    date,
    calls: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0
  };
}

interface ActivityWindowTotals {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** The window's headline figures, added up from the same rows the chart draws
 *  so the two cannot disagree. Latency is deliberately absent: percentiles do
 *  not sum, and the endpoint already answers them over the whole window. */
export function summarizeDailyTotals(daily: ActivityDailyDto[]): ActivityWindowTotals {
  const totals: ActivityWindowTotals = {
    calls: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0
  };
  for (const day of daily) {
    totals.calls += day.calls;
    totals.failed += day.failed;
    totals.inputTokens += day.inputTokens;
    totals.outputTokens += day.outputTokens;
    totals.cacheReadTokens += day.cacheReadTokens;
  }
  return totals;
}

/** Thousands separators, in the one locale the product speaks. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

