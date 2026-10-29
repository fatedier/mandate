import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ActivityDailyDto, ActivitySummaryResponse } from "@shared/api-contracts";
import { Section } from "@/components/Section";
import { formatCalendarDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import { cacheHitRate, formatCount, formatTokenCount, summarizeDailyTotals } from "../activity-model";
import { LEDGER_COPY, oneDayOf, previousPeriod, showAll } from "../ledger-copy";
import { formatUsd, spendLine, spendValue } from "../money";
import { formatWindow } from "../useActivitySummary";
import { DailyChart } from "./DailyChart";
import { SpendChart, type SpendDay } from "./SpendChart";

/**
 * The window's spend, the figures beside it, and spend per day — or, for a
 * window with no spend at all (plans, local models, nothing priced), calls
 * per day as before. A bar picks its day: the figures are then that day's
 * (`figures`), compared with the day before, and a chip beside the title
 * steps through the window's days or lets go of the pick.
 */
export function SpendSection({ data, daily, figures = data, day = null, pending = false, onPickDay = () => {} }: {
  data: ActivitySummaryResponse;
  daily: ActivityDailyDto[];
  figures?: ActivitySummaryResponse;
  day?: string | null;
  pending?: boolean;
  onPickDay?: (day: string | null) => void;
}) {
  const totals = summarizeDailyTotals(figures.daily);
  const failedRate = totals.calls ? (totals.failed / totals.calls) * 100 : 0;
  const cached = cacheHitRate(totals.inputTokens, totals.cacheReadTokens);
  const previous = figures.ledger.previousSpendMicros;
  const detail = [
    previous !== null ? `${formatUsd(previous, figures.spend.estimated)} ${previousPeriod(day ? 1 : data.days)}` : "",
    spendLine(figures.spend)
  ].filter(Boolean).join(" · ");
  const byDate = new Map(data.ledger.days.map((d) => [d.date, d]));
  const spendDays: SpendDay[] = daily.map((d) => ({
    date: d.date,
    calls: d.calls,
    failed: d.failed,
    spendMicros: byDate.get(d.date)?.spendMicros ?? 0,
    expiredExtraMicros: byDate.get(d.date)?.expiredExtraMicros ?? 0
  }));
  const window = formatWindow(data.days);
  const pickOrLetGo = (date: string) => onPickDay(date === day ? null : date);

  return (
    <Section
      title={LEDGER_COPY.spend}
      meta={day ? oneDayOf(window) : `last ${window}`}
      trailing={day
        ? <DayChip day={day} dates={data.dates} window={window} onPickDay={onPickDay} />
        : (
          <span className="num shrink-0 text-2xs text-faint">
            {formatCalendarDay(daily[0]?.date ?? "")} → {formatCalendarDay(daily[daily.length - 1]?.date ?? "")}
          </span>
        )}
    >
      {/* The spend, then the four others as one group: when both do not fit
          one line the group moves down whole; narrow, it is two by two. */}
      <div
        data-slot="activity-totals"
        className={cn("flex flex-wrap items-baseline gap-x-7 gap-y-3 px-3.5 pt-3.5 pb-1 transition-opacity", pending && "opacity-50")}
      >
        <Total value={spendValue(figures.spend)} label="spend" detail={detail} />
        <div className="flex items-baseline gap-x-7 @max-[34rem]:grid @max-[34rem]:w-full @max-[34rem]:grid-cols-2 @max-[34rem]:gap-y-3">
          <Total value={formatCount(totals.calls)} label="calls" />
          <Total
            value={`${failedRate.toFixed(1)}%`}
            label={`failed · ${formatCount(totals.failed)}`}
            tone={failedRate >= 5 ? "alert" : undefined}
          />
          <Total value={formatTokenCount(totals.inputTokens)} label="input tokens" />
          <Total value={cached === null ? "—" : `${Math.round(cached)}%`} label="cache hit rate" />
        </div>
      </div>
      <div className="px-3.5 pt-2 pb-3">
        {data.spend.pricedCalls > 0
          ? <SpendChart days={spendDays} estimated={data.spend.estimated} picked={day} onPick={pickOrLetGo} />
          : <DailyChart daily={daily} picked={day} onPick={pickOrLetGo} />}
      </div>
    </Section>
  );
}

/** The picked day, the days either side of it in the window, and the way
 *  back to the whole window. Each control is its own button. */
function DayChip({ day, dates, window, onPickDay }: { day: string; dates: readonly string[]; window: string; onPickDay: (day: string | null) => void }) {
  const index = dates.indexOf(day);
  const earlier = index > 0 ? dates[index - 1] : undefined;
  const later = index >= 0 && index < dates.length - 1 ? dates[index + 1] : undefined;
  const control = "hit relative flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground disabled:opacity-35 disabled:hover:bg-transparent pointer-coarse:size-8";
  return (
    <span data-slot="activity-day-chip" className="num flex shrink-0 items-center rounded-full bg-sel text-2xs text-foreground">
      <button type="button" aria-label={LEDGER_COPY.previousDay} disabled={!earlier} onClick={() => earlier && onPickDay(earlier)} className={control}>
        <ChevronLeft className="size-3.5" aria-hidden />
      </button>
      <span className="px-0.5">{formatCalendarDay(day)}</span>
      <button type="button" aria-label={LEDGER_COPY.nextDay} disabled={!later} onClick={() => later && onPickDay(later)} className={control}>
        <ChevronRight className="size-3.5" aria-hidden />
      </button>
      <span className="mx-0.5 h-3.5 w-px bg-border-soft" aria-hidden />
      <button type="button" aria-label={showAll(window)} onClick={() => onPickDay(null)} className={cn(control, "mr-0.5")}>
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

function Total({ value, label, tone, detail }: { value: string; label: string; tone?: "alert"; detail?: string }) {
  return (
    <div data-slot="activity-total">
      <div className={cn("num text-xl font-semibold leading-none", tone === "alert" && "text-destructive")}>{value}</div>
      <div className="mt-1 text-2xs text-faint">{label}</div>
      {detail ? <div data-slot="activity-total-detail" className="mt-0.5 text-2xs text-faint">{detail}</div> : null}
    </div>
  );
}
