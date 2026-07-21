import type { ActivityBucketDto, ActivitySummaryResponse } from "@shared/api-contracts";
import { formatPercentileMs, latencyBucketIndex } from "../activity-model";

/**
 * Where the calls sit on the clock: five buckets as horizontal bars, with
 * p50/p95/p99 pinned onto the bucket each falls in.
 *
 * Horizontal, not vertical: the counts span roughly 700× (10 against 7,275)
 * and a linear vertical bar makes the small buckets invisible.
 */
export function LatencyPanel({
  buckets, p50Ms, p95Ms, p99Ms, ttft
}: {
  buckets: ActivityBucketDto[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  ttft: ActivitySummaryResponse["ttft"];
}) {
  const total = buckets.reduce((sum, b) => sum + b.calls, 0) || 1;
  const percentiles = [["p50", p50Ms], ["p95", p95Ms], ["p99", p99Ms]] as const;
  const pins = new Map<number, string[]>();
  for (const [label, ms] of percentiles) {
    // Zero means nothing was measured, not a call that returned instantly, so
    // it names no bucket. Pinning it would put "p50" on the <1s bar of a
    // window whose latencies are all null.
    if (!ms) continue;
    const index = latencyBucketIndex(ms);
    pins.set(index, [...(pins.get(index) ?? []), label]);
  }

  return (
    <div>
      {buckets.map((bucket, index) => (
        <div
          key={bucket.bucket}
          data-latency-bucket={bucket.bucket}
          className="grid grid-cols-[4.2rem_minmax(0,1fr)_4rem] items-center gap-3 py-1"
        >
          <span className="num text-2xs text-muted-foreground">{bucket.bucket}</span>
          {/* The pin sits outside the track, not inside it: an 8px rail with
              `overflow-hidden` clips a 12px badge down to a sliver. */}
          <span className="relative block">
            <span className="block h-2 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-primary/55"
                    style={{ width: `${Math.max((bucket.calls / total) * 100, bucket.calls ? 1.5 : 0)}%` }} />
            </span>
            {pins.has(index) && (
              <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded-xs border border-border-soft bg-card px-1 text-2xs font-semibold text-primary">
                {pins.get(index)?.join(" ")}
              </span>
            )}
          </span>
          <span className="num text-right text-2xs text-muted-foreground">{bucket.calls.toLocaleString("en-US")}</span>
        </div>
      ))}
      <div className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3 border-t border-border-soft pt-3">
        {percentiles.map(([label, ms]) => (
          <div key={label} className="text-2xs text-chrome">
            {label}
            <b className="num block text-base font-semibold text-foreground">
              {formatPercentileMs(ms)}
            </b>
          </div>
        ))}
        {/* Time to first token, kept apart from the three above rather than
            lined up with them: it answers a different question — how long the
            provider took to start — and it is measured over a different set of
            calls, since only those recorded after the column existed have one.
            Side by side they would read as four views of one population. */}
        {ttft.calls > 0 && (
          <div className="border-l border-border-soft pl-6 text-2xs text-chrome">
            TTFT p50
            <b className="num block text-base font-semibold text-foreground">
              {formatPercentileMs(ttft.p50Ms)}
            </b>
            <span className="num">
              {ttft.calls.toLocaleString("en-US")} calls · p95 {formatPercentileMs(ttft.p95Ms)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
