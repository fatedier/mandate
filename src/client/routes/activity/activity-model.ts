import type { ActivityDailyDto } from "@shared/api-contracts";

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
 * that was cached — a subset, not a sibling. Verified against the provider's
 * own accounting on every one of the 33,267 calls in a 30-day window:
 * `input_tokens` equals `inputTokenDetails.noCacheTokens +
 * inputTokenDetails.cacheReadTokens` in all of them, and is never below
 * `cache_read_tokens` in any.
 *
 * This used to add the two, which counted the cached half twice and halved
 * every reading: a store running at 88% reported 47%, and the total prompt
 * read 6.5B against a true 3.5B. The names invite it — two columns, both
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
 * The two pairs this serves are containments, not comparisons: measured over
 * 32,352 calls, `cacheReadTokens <= inputTokens` and `reasoningTokens <=
 * outputTokens` hold without exception. One formula so the two never disagree
 * about what a share means.
 */
export function sharePercent(part: number | null, whole: number | null): number | null {
  const total = whole ?? 0;
  if (total === 0) return null;
  return Math.round(((part ?? 0) / total) * 1000) / 10;
}

/** Milliseconds as a figure that fits a fixed-width column: sub-second in ms,
 *  then one decimal, then whole seconds once the decimal stops carrying. */
export function formatCallDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

/** A token count for a column three characters wide: thousands and millions
 *  carry one decimal, anything under a thousand is written out. Shared by the
 *  Overview's headline figures and the log row's input column so the two
 *  cannot render the same number differently — `—` for a count that was never
 *  recorded, which is not the same reading as zero. */
export function formatTokenCount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  // Billions are not hypothetical here: a 30-day window on the real store holds
  // 6.5B input tokens, which without this tier reads as "6530.3M".
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString("en-US");
}

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

const MS_PER_DAY = 86_400_000;

/** Zero-fill the days the endpoint left out.
 *
 *  The daily query groups by date, so a day with no calls has no row — and a
 *  chart drawing one bar per row puts 1 Aug beside 4 Aug, which reads as an
 *  axis of consecutive days. Runs from the first day that has data through
 *  `todayUtc` (dates come from `substr(created_at, 1, 10)`, so they are UTC),
 *  and is bounded: a single stale row must not turn into years of bars. */
export function fillDailyGaps(
  daily: ActivityDailyDto[],
  todayUtc: string,
  maxDays: number
): ActivityDailyDto[] {
  const first = daily[0]?.date;
  if (!first) return [];
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const lastDate = daily[daily.length - 1]?.date ?? first;
  // Walk back from the later of today and the newest row: rows dated ahead of
  // the clock (a machine whose time moved) must not fall off the chart.
  let cursor = Date.parse(`${todayUtc > lastDate ? todayUtc : lastDate}T00:00:00.000Z`);
  if (!Number.isFinite(cursor)) return daily;

  const filled: ActivityDailyDto[] = [];
  while (filled.length < maxDays) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    filled.push(byDate.get(date) ?? emptyDay(date));
    if (date <= first) break;
    cursor -= MS_PER_DAY;
  }
  return filled.reverse();
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

export interface ActivityWindowTotals {
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

