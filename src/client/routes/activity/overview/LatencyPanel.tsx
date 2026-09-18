import type { ActivityBucketDto, ActivitySummaryResponse } from "@shared/api-contracts";
import { formatPercentileMs, latencyBucketIndex } from "../activity-model";

/**
 * The percentile strip for the section's header line: p50 · p95 · p99, and the
 * time to first token when the window measured one.
 *
 * TTFT is kept last and named apart rather than lined up as a fourth
 * percentile: it answers a different question — how long the provider took to
 * start — and it is measured over a different set of calls, since only those
 * recorded after the column existed have one. A window where nothing timed a
 * first token shows no TTFT figure at all — not a dash, not a zero — because
 * an empty reading dressed as a measurement is worse than none.
 */
export function LatencyStats({
  p50Ms, p95Ms, p99Ms, ttft
}: {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  ttft: ActivitySummaryResponse["ttft"];
}) {
  const fmt = formatPercentileMs;
  return (
    // Hidden on a phone: the strip is wider than the line has room for, and
    // the panel below pins the same percentiles onto their buckets.
    <span className="num min-w-0 truncate font-mono text-2xs text-faint @max-[34rem]:hidden">
      p50 {fmt(p50Ms)} · p95 {fmt(p95Ms)} · p99 {fmt(p99Ms)}
      {ttft.calls > 0 ? ` · TTFT p50 ${fmt(ttft.p50Ms)}` : ""}
    </span>
  );
}

/**
 * Where the calls sit on the clock: five buckets as horizontal bars, with
 * p50/p95/p99 pinned onto the bucket each falls in.
 *
 * Horizontal, not vertical: the counts span roughly 700× (10 against 7,275)
 * and a linear vertical bar makes the small buckets invisible.
 */
export function LatencyPanel({
  buckets, p50Ms, p95Ms, p99Ms
}: {
  buckets: ActivityBucketDto[];
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
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
          className="flex min-h-10 items-center gap-3 border-t border-border-soft px-3.5 first:border-t-0"
        >
          <span className="num w-[52px] shrink-0 font-mono text-2xs text-muted-foreground">{bucket.bucket}</span>
          <span data-slot="latency-track" className="relative block h-1.5 flex-1 overflow-hidden rounded-full bg-sel">
            <span
              className="block h-full rounded-full bg-faint"
              style={{ width: `${Math.max((bucket.calls / total) * 100, bucket.calls ? 1.5 : 0)}%` }}
            />
          </span>
          {/* The markers sit after the track, not on it: a 6px rail with
              `overflow-hidden` clips a 22px pill down to a sliver. And in a
              fixed slot on every row, pinned or not: a pill in the flex line
              would take its width from the track, and a bar is a share of its
              track — two rows with different tracks stop being comparable.
              8rem holds all three pills: on a fast window p50, p95 and p99
              can all land in the <1s bucket, and nothing here stops them.
              On a phone the slot shrinks to its pills instead — a fixed 8rem
              beside the label and the count left the track a few pixels. */}
          <span data-slot="latency-markers" className="flex w-32 shrink-0 items-center gap-1 @max-[34rem]:w-auto">
            {pins.get(index)?.map((label) => (
              <span key={label} className="pill pill-neutral">{label}</span>
            ))}
          </span>
          <span className="num w-14 shrink-0 text-right text-2xs text-muted-foreground">
            {bucket.calls.toLocaleString("en-US")}
          </span>
        </div>
      ))}
    </div>
  );
}
