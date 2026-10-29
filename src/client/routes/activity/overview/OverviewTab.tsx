import type { ActivitySummaryResponse } from "@shared/api-contracts";
import { Section } from "@/components/Section";
import { InlineError } from "@/components/ViewState";
import { cn } from "@/lib/utils";
import { dailyForDates, summarizeDailyTotals } from "../activity-model";
import { ActivitySkeleton } from "../ActivitySkeleton";
import { estimateFootnote } from "../ledger-copy";
import { formatWindow } from "../useActivitySummary";
import { AgentsSection } from "./AgentsSection";
import { CacheSection, SealPauseNotes } from "./CacheSection";
import { SpendSection } from "./SpendSection";
import { TokensSection } from "./TokensSection";
import { WakesSection } from "./WakesSection";

/**
 * The window's money, and what made it: spend and spend per day; who spent
 * it; the calls that paid for their prompt again; what the spend is made of;
 * what woke the agents. How long calls take is on the Breakdown tab.
 *
 * Every figure comes from the same window, so the parts reconcile. Nothing
 * here pages — a growing list belongs to Logs.
 *
 * A picked day narrows it: the chart still draws the window, and the figures
 * and every section below are that day's own answer. Until it arrives, what
 * was shown stays, marked as not yet the day's.
 */
export function OverviewTab({
  data,
  loading,
  day = null,
  windowDays = data?.days ?? null,
  dayData = null,
  dayError = "",
  onRetryDay = () => {},
  onPickDay = () => {}
}: {
  data: ActivitySummaryResponse | null;
  loading: boolean;
  day?: string | null;
  /** The window the reader chose: the answers in hand may still be an earlier one's. */
  windowDays?: number | null;
  dayData?: ActivitySummaryResponse | null;
  dayError?: string;
  onRetryDay?: () => void;
  onPickDay?: (day: string | null) => void;
}) {
  if (!data) return loading ? <ActivitySkeleton /> : null;

  const totals = summarizeDailyTotals(data.daily);
  if (totals.calls === 0) {
    return (
      <Section title="Spend" meta={`last ${formatWindow(data.days)}`}>
        <p className="px-3.5 py-3 text-2xs text-faint">
          No LLM calls in this window. Anything the agent runs shows up here.
        </p>
        {/* A paused cache seal outlives the window's calls. */}
        <SealPauseNotes pauses={data.cacheSeal?.paused ?? []} />
      </Section>
    );
  }

  // The dates come from the server, which cut them in the reader's zone.
  const daily = dailyForDates(data.daily, data.dates);
  const shown = day && dayData ? dayData : data;
  // The day's own answer is one for this day of this window: the same date
  // in another window can count a different part of it (a window's first
  // day is cut at the window's start).
  const pending = day !== null && (dayData?.day !== day || dayData.days !== windowDays);
  const estimated = shown.spend.estimated;

  return (
    <div className="flex flex-col gap-6">
      {day && dayError && (
        <InlineError detail={dayError} onRetry={onRetryDay}>Couldn't load this day.</InlineError>
      )}
      <SpendSection data={data} daily={daily} figures={shown} day={day} pending={pending} onPickDay={onPickDay} />
      <div
        data-slot={pending ? "activity-day-pending" : undefined}
        className={cn("flex flex-col gap-6 transition-opacity", pending && "opacity-50")}
      >
        <div className="flex flex-wrap items-start gap-6">
          <div className="min-w-0 grow-[7] basis-[35rem]">
            <AgentsSection ledger={shown.ledger} estimated={estimated} day={day} />
          </div>
          <div className="flex min-w-0 grow-[5] basis-[24rem] flex-col gap-6">
            <CacheSection ledger={shown.ledger} spend={shown.spend} days={day ? 1 : shown.days} day={day} sealPauses={shown.cacheSeal?.paused ?? []} />
            <TokensSection ledger={shown.ledger} estimated={estimated} />
          </div>
        </div>
        <WakesSection ledger={shown.ledger} estimated={estimated} />
      </div>
      {estimated && shown.ledger.priceDataDate && (
        <p className="text-2xs text-faint">{estimateFootnote(shown.ledger.priceDataDate)}</p>
      )}
    </div>
  );
}
