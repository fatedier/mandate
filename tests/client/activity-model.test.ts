import { describe, expect, test } from "bun:test";
import {
  cacheHitRate,
  fillDailyGaps,
  formatCallDurationMs,
  formatPercentileMs,
  latencyBucketIndex,
  summarizeDailyTotals,
  tokensPerSecond
} from "@/routes/activity/activity-model";

/**
 * Both are on the log row because both vary and neither is visible in the
 * totals. Measured over a day: 15.9 tok/s on average across a 0–54.6 range,
 * and ten calls at 0% cache inside an aggregate reading 48.6%.
 */
describe("tokensPerSecond", () => {
  test("is output tokens over elapsed seconds", () => {
    expect(tokensPerSecond(300, 10_000)).toBe(30);
  });

  test("carries one decimal, because the column is 4rem wide", () => {
    // Every figure in the brief's own cases divides exactly, so an
    // implementation that skipped rounding would satisfy them and then render
    // 15.905172413793103 into a fixed-width numeric column.
    expect(tokensPerSecond(157, 9871)).toBe(15.9);
  });

  test("answers null rather than Infinity when there is no elapsed time", () => {
    // A call that failed before its first chunk has latency 0; dividing by it
    // puts Infinity in a column that is right-aligned against real figures.
    expect(tokensPerSecond(300, 0)).toBeNull();
    expect(tokensPerSecond(300, null)).toBeNull();
    expect(tokensPerSecond(null, 10_000)).toBeNull();
  });
});

describe("cacheHitRate", () => {
  test("is cache reads over the prompt they are part of", () => {
    // The first argument is the whole prompt and the second is the cached part
    // of it — verified against the provider's own accounting on all 33,267
    // calls in a 30-day window. Read as siblings and added, a store running at
    // 88% reports 47%, which is what this used to do.
    expect(cacheHitRate(100, 50)).toBe(50);
    expect(cacheHitRate(100, 100)).toBe(100);
    expect(cacheHitRate(127_345, 126_464)).toBe(99.3);
  });

  test("a cached share cannot exceed the prompt it came out of", () => {
    // Guards the reading the old formula made ordinary: under it, 88% of a
    // real prompt came back as 47%, and nothing about the number looked wrong.
    const rate = cacheHitRate(127_345, 126_464)!;
    expect(rate).toBeGreaterThan(90);
    expect(rate).toBeLessThanOrEqual(100);
  });

  test("carries one decimal", () => {
    // 1/3 of the prompt came from cache. Unrounded that is 33.33333333333333,
    // which every other case here would have accepted.
    expect(cacheHitRate(3, 1)).toBe(33.3);
  });

  test("zero is a reading, not a missing value", () => {
    // Ten of five hundred calls read nothing from cache, and those are the
    // ones worth seeing; collapsing them into "—" hides the finding.
    expect(cacheHitRate(100, 0)).toBe(0);
  });

  test("nothing read at all is missing, not zero", () => {
    expect(cacheHitRate(null, null)).toBeNull();
    expect(cacheHitRate(0, 0)).toBeNull();
  });
});

describe("formatCallDurationMs", () => {
  test("sub-second reads in milliseconds", () => {
    expect(formatCallDurationMs(0)).toBe("0ms");
    expect(formatCallDurationMs(847.4)).toBe("847ms");
    expect(formatCallDurationMs(999)).toBe("999ms");
  });

  test("seconds carry a decimal only while it still says something", () => {
    // The three branches meet at 1000 and at 10000; a column that switches
    // format inside its own range is what makes rows unreadable.
    expect(formatCallDurationMs(1000)).toBe("1.0s");
    expect(formatCallDurationMs(9999)).toBe("10.0s");
    expect(formatCallDurationMs(10_000)).toBe("10s");
    expect(formatCallDurationMs(65_400)).toBe("65s");
  });

  test("no reading renders as an em dash rather than a number", () => {
    expect(formatCallDurationMs(null)).toBe("—");
    expect(formatCallDurationMs(-1)).toBe("—");
    expect(formatCallDurationMs(Number.NaN)).toBe("—");
    expect(formatCallDurationMs(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("formatPercentileMs", () => {
  test("a measured percentile reads like any other duration", () => {
    expect(formatPercentileMs(850)).toBe("850ms");
    expect(formatPercentileMs(4200)).toBe("4.2s");
  });

  test("zero is not a reading", () => {
    // The summary endpoint answers 0 for a window whose calls all recorded a
    // null latency, which is indistinguishable from a measured 0ms. Charting
    // it as "0ms" claims a speed nothing measured.
    expect(formatPercentileMs(0)).toBe("—");
  });
});

describe("latencyBucketIndex", () => {
  // Mirrors the server's CASE in activity-summary.ts, whose labels arrive in
  // this order: "<1s", "1-5s", "5-15s", "15-60s", ">60s". An index off by one
  // pins p95 onto the wrong bar and nothing else in the page disagrees.
  test("each edge belongs to the bucket above it", () => {
    expect(latencyBucketIndex(1)).toBe(0);
    expect(latencyBucketIndex(999)).toBe(0);
    expect(latencyBucketIndex(1000)).toBe(1);
    expect(latencyBucketIndex(4999)).toBe(1);
    expect(latencyBucketIndex(5000)).toBe(2);
    expect(latencyBucketIndex(14_999)).toBe(2);
    expect(latencyBucketIndex(15_000)).toBe(3);
    expect(latencyBucketIndex(59_999)).toBe(3);
    expect(latencyBucketIndex(60_000)).toBe(4);
    expect(latencyBucketIndex(600_000)).toBe(4);
  });
});

describe("fillDailyGaps", () => {
  const day = (date: string, calls: number) => ({
    date,
    calls,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0
  });

  test("a day with no calls is a bar of zero, not a missing bar", () => {
    // The endpoint groups by date, so a silent day has no row at all. Drawing
    // one bar per row makes 1 Aug and 4 Aug adjacent, which reads as an axis
    // of consecutive days that it is not.
    const filled = fillDailyGaps([day("2026-08-01", 12), day("2026-08-04", 5)], "2026-08-04", 31);
    expect(filled.map((d) => d.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04"
    ]);
    expect(filled.map((d) => d.calls)).toEqual([12, 0, 0, 5]);
  });

  test("silence up to today is part of the picture", () => {
    const filled = fillDailyGaps([day("2026-07-30", 4)], "2026-08-02", 31);
    expect(filled.map((d) => d.date)).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02"
    ]);
    expect(filled.map((d) => d.calls)).toEqual([4, 0, 0, 0]);
  });

  test("crosses a month and a leap day without inventing a date", () => {
    const filled = fillDailyGaps([day("2028-02-27", 1)], "2028-03-01", 31);
    expect(filled.map((d) => d.date)).toEqual([
      "2028-02-27",
      "2028-02-28",
      "2028-02-29",
      "2028-03-01"
    ]);
  });

  test("is bounded, so one stale row cannot draw six years of bars", () => {
    const filled = fillDailyGaps([day("2020-01-01", 1), day("2026-08-03", 9)], "2026-08-03", 31);
    expect(filled).toHaveLength(31);
    expect(filled[filled.length - 1]?.date).toBe("2026-08-03");
    expect(filled[filled.length - 1]?.calls).toBe(9);
  });

  test("an empty window stays empty rather than becoming a month of zeroes", () => {
    expect(fillDailyGaps([], "2026-08-03", 31)).toEqual([]);
  });
});

describe("summarizeDailyTotals", () => {
  const day = (over: Partial<Parameters<typeof summarizeDailyTotals>[0][number]> = {}) => ({
    date: "2026-08-01",
    calls: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    p50Ms: 0,
    p95Ms: 0,
    p99Ms: 0,
    ...over
  });

  test("adds the window up field by field", () => {
    // Distinct values per field: with the same number everywhere, a total that
    // read outputTokens where it meant inputTokens would still be right.
    const totals = summarizeDailyTotals([
      day({ date: "2026-08-01", calls: 10, failed: 1, inputTokens: 200, outputTokens: 30, cacheReadTokens: 4000 }),
      day({ date: "2026-08-02", calls: 7, failed: 3, inputTokens: 100, outputTokens: 50, cacheReadTokens: 6000 })
    ]);
    expect(totals).toEqual({
      calls: 17,
      failed: 4,
      inputTokens: 300,
      outputTokens: 80,
      cacheReadTokens: 10_000
    });
  });

  test("an empty window totals to zero rather than throwing", () => {
    expect(summarizeDailyTotals([])).toEqual({
      calls: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0
    });
  });
});
