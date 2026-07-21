import { type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { ActivitySummaryResponse } from "@shared/api-contracts";
import {
  cacheHitRate,
  fillDailyGaps,
  formatCount,
  formatTokenCount,
  summarizeDailyTotals
} from "../activity-model";
import { BreakdownTable } from "../BreakdownTable";
import { formatWindow } from "../useActivitySummary";
import { useOverviewPageSummary } from "../useActivityPageSummary";
import { DailyChart } from "./DailyChart";
import { LatencyPanel } from "./LatencyPanel";

/**
 * What the rows could not answer: how much ran, how much of it failed, how
 * long it took, and which purpose is responsible.
 *
 * Every figure here comes from the same 30-day window, so the chart total, the
 * group totals and the headline reconcile. Nothing on this tab pages — the
 * moment it grows a scrolling list it has become the Logs tab with worse
 * filters.
 */
export function OverviewTab({
  data,
  loading,
  onSelectPattern
}: {
  data: ActivitySummaryResponse | null;
  loading: boolean;
  onSelectPattern: (key: string) => void;
}) {
  // Before the early returns: the agent asking what this page shows has to get
  // an answer while it is still loading, and hooks cannot be conditional.
  useOverviewPageSummary(data);

  if (!data) return loading ? <OverviewSkeleton /> : null;

  const totals = summarizeDailyTotals(data.daily);
  if (totals.calls === 0) {
    return (
      <Card label={`Last ${formatWindow(data.days)}`}>
        <p className="text-xs text-chrome">
          No LLM calls in this window. Anything the agent runs shows up here.
        </p>
      </Card>
    );
  }

  // `data.days + 1` because the window opens partway through its first day, so
  // the rows can span one more date than the window has days.
  const daily = fillDailyGaps(data.daily, todayUtc(), data.days + 1);
  const failedRate = (totals.failed / totals.calls) * 100;
  const cached = cacheHitRate(totals.inputTokens, totals.cacheReadTokens);

  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-3 rounded-lg border border-border-soft bg-card p-4">
        <div className="flex flex-wrap items-baseline gap-x-7 gap-y-3">
          <Total value={formatCount(totals.calls)} label={`calls · ${formatWindow(data.days)}`} />
          {/* Colour at 5%: retries make a low rate ordinary, so a figure that
              is red at 1% would be red forever and stop meaning anything. */}
          <Total
            value={`${failedRate.toFixed(1)}%`}
            label={`failed · ${formatCount(totals.failed)}`}
            tone={failedRate >= 5 ? "alert" : undefined}
          />
          {/* Input, not output. The two figures beside each other have to be
              about the same quantity: the hit rate is a share of the input,
              and pairing it with what came back left its own denominator off
              the page. On the real store the window carries
              3.5B in against 9.2M out — the output is 0.3% of the traffic,
              and it was the only token figure here. It keeps its place in the
              day card and the call panel. */}
          <Total value={formatTokenCount(totals.inputTokens)} label="input tokens" />
          <Total value={cached === null ? "—" : `${Math.round(cached)}%`} label="cache hit rate" />
        </div>
        {/* The chart owns the line under it now: hovering a day replaces the
            range with that day's figures. */}
        <DailyChart daily={daily} />
      </section>

      <Card label="How long calls take">
        <LatencyPanel
          buckets={data.buckets}
          p50Ms={data.p50Ms}
          p95Ms={data.p95Ms}
          p99Ms={data.p99Ms}
          ttft={data.ttft}
        />
      </Card>

      {/* The Breakdown's table, pinned to the cut this tab is about — the same
          component with the same columns, which is the only reason a table in
          two places describes one window rather than disagreeing about it.
          The page holds a single summary, so while the reader's own grouping
          is the one in hand there is nothing here to draw: a model breakdown
          under a "Purpose" heading would be worse than no table. */}
      {data.group === "purpose" && (
        <Card label="Where the time and the failures go">
          <BreakdownTable groups={data.groups} group="purpose" onSelect={onSelectPattern} />
        </Card>
      )}
    </div>
  );
}

/** UTC, because the endpoint's dates come from `substr(created_at, 1, 10)` on
 *  an ISO string. A local date would mismatch the chart's own rows by a day
 *  either side of midnight. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function Total({
  value,
  label,
  tone
}: {
  value: string;
  label: string;
  tone?: "alert";
}) {
  return (
    <div>
      <div
        className={
          tone === "alert"
            ? "num text-2xl leading-none text-destructive"
            : "num text-2xl leading-none"
        }
      >
        {value}
      </div>
      <div className="mt-1 text-2xs text-chrome">{label}</div>
    </div>
  );
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-border-soft bg-card p-4">
      <h2 className="label-micro text-chrome">{label}</h2>
      {children}
    </section>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border-soft bg-card p-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-3 h-52 w-full" />
      </div>
      <Skeleton className="h-40 rounded-lg" />
      <Skeleton className="h-56 rounded-lg" />
    </div>
  );
}
