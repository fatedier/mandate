import { useSearchParams } from "react-router";
import type { ActivityLedgerDto, ActivitySpendDto, CacheSealPauseDto } from "@shared/api-contracts";
import { Section, SectionLink } from "@/components/Section";
import { cn } from "@/lib/utils";
import { formatCount, formatTokenCount } from "../activity-model";
import { CACHE_HEADS, LEDGER_COPY, VERDICT_LABELS, cacheClosingLine, cacheSealPauseNote, periodWord, verdictDescription } from "../ledger-copy";
import { formatUsd } from "../money";
import { logsQuery } from "../useActivityFilters";

const HEAD = "label-micro py-2 font-normal text-chrome";
const CELL = "flex items-center justify-end border-t border-border-soft self-stretch";

/** The models whose cache seal is paused now, one line each. */
export function SealPauseNotes({ pauses }: { pauses: readonly CacheSealPauseDto[] }) {
  return pauses.map((pause, index) => (
    <p key={`${index}-${pause.model}`} data-slot="cache-seal-paused" className="px-3.5 pt-3 text-2xs text-amber">{cacheSealPauseNote(pause)}</p>
  ));
}

/** The calls that paid for a prompt the cache should have held, by why; and
 *  above them, any model whose cache seal is paused now. */
export function CacheSection({ ledger, spend, days, day = null, sealPauses = [] }: {
  ledger: ActivityLedgerDto;
  spend: ActivitySpendDto;
  days: number;
  day?: string | null;
  sealPauses?: CacheSealPauseDto[];
}) {
  const [searchParams] = useSearchParams();
  const rows = ledger.cache.rows;
  const expired = rows.find((row) => row.kind === "expired");
  const withMoney = spend.pricedCalls > 0;
  const showCalls = logsQuery(searchParams, { ...(day ? { day } : {}), view: "expired" });

  return (
    <Section
      title={LEDGER_COPY.cache}
      meta={LEDGER_COPY.cacheMeta}
      trailing={expired ? <SectionLink to={`/activity?${showCalls}`}>{LEDGER_COPY.showCalls}</SectionLink> : undefined}
    >
      <SealPauseNotes pauses={sealPauses} />
      {rows.length === 0 ? (
        <p className="px-3.5 py-3 text-2xs text-faint">{LEDGER_COPY.cacheEmpty}</p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] gap-x-3 px-3.5 text-xs">
            <span className={HEAD}>{CACHE_HEADS.verdict}</span>
            <span className={`${HEAD} text-right`}>{CACHE_HEADS.calls}</span>
            <span className={`${HEAD} text-right`}>{CACHE_HEADS.extra}</span>
            {rows.map((row) => [
              <span key={`${row.kind}-v`} data-cache-row={row.kind} className="flex flex-col items-start gap-1 border-t border-border-soft py-2.5">
                <span className={cn("pill", row.kind === "expired" ? "pill-amber" : "pill-neutral")}>{VERDICT_LABELS[row.kind]}</span>
                <span className="text-2xs text-faint">{verdictDescription(row.kind, row.topFamily)}</span>
              </span>,
              <span key={`${row.kind}-c`} className={`${CELL} num text-muted-foreground`}>{formatCount(row.calls)}</span>,
              <span key={`${row.kind}-x`} className={cn(CELL, "num", row.kind === "expired" && "font-semibold text-amber")}>
                {/* An extra is money only where some of the row's calls have
                    rates; otherwise it is unknown, and the tokens are what is known. */}
                {withMoney && row.pricedCalls > 0 ? formatUsd(row.extraMicros, spend.estimated) : `${formatTokenCount(row.rewrittenTokens)} tokens`}
              </span>
            ])}
          </div>
          {expired && ledger.cache.medianExpiredIdleMs !== null && (
            <p className="mx-3.5 border-t border-border-soft py-3 text-xs leading-relaxed text-muted-foreground">
              {cacheClosingLine({
                sharePct: withMoney && expired.pricedCalls > 0 && spend.micros > 0 ? Math.round((expired.extraMicros / spend.micros) * 100) : null,
                medianMinutes: Math.round(ledger.cache.medianExpiredIdleMs / 60_000),
                withinHour: ledger.cache.expiredWithinHour,
                expired: expired.calls,
                wrote1h: ledger.cache.wrote1h,
                periodWord: periodWord(days)
              })}
            </p>
          )}
        </>
      )}
    </Section>
  );
}
