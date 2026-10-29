import type { ActivityLedgerDto, ActivityWakeRowDto } from "@shared/api-contracts";
import { Section } from "@/components/Section";
import { cn } from "@/lib/utils";
import { formatCount } from "../activity-model";
import { LEDGER_COPY, WAKE_HEADS, wakeLabel, whoList } from "../ledger-copy";
import { formatUsd, ledgerMoneyLabel } from "../money";

/** Rows past this many fold into one "N more" row on a narrow pane. */
const NARROW_ROWS = 7;
const HEAD = "label-micro py-2 font-normal text-chrome";
const CELL = "num flex items-center justify-end border-t border-border-soft self-stretch";
/** Wide: every column. Below 40rem Who goes under Why; below 28rem (a phone)
 *  Runs and Per run go too, so Why keeps room to be read. */
const GRID = "grid items-center gap-x-3.5 grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_4rem_4.5rem_4.5rem_7.5rem] @max-[40rem]:grid-cols-[minmax(0,1fr)_3rem_4rem_4.5rem_5rem] @max-[28rem]:grid-cols-[minmax(0,1fr)_4.5rem_5rem] @max-[28rem]:gap-x-2.5";
const WIDE_ONLY = "@max-[28rem]:hidden";

function expiredCell(row: Pick<ActivityWakeRowDto, "expiredExtraMicros" | "spendMicros">, estimated: boolean) {
  if (row.expiredExtraMicros <= 0) return <span className="text-faint">—</span>;
  if (row.expiredExtraMicros < 1_000_000) return <span className="text-faint">{LEDGER_COPY.underOneDollar}</span>;
  const share = row.spendMicros > 0 ? Math.round((row.expiredExtraMicros / row.spendMicros) * 100) : null;
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-amber">{formatUsd(row.expiredExtraMicros, estimated)}</span>
      {share !== null && <span className="text-2xs text-faint">{share}%</span>}
    </span>
  );
}

/** What woke the agents: each wake reason's runs and what they cost. */
export function WakesSection({ ledger, estimated }: { ledger: ActivityLedgerDto; estimated: boolean }) {
  if (ledger.wakes.length === 0) return null;
  const folded = ledger.wakes.slice(NARROW_ROWS);
  const rest = folded.reduce((sum, row) => ({
    runs: sum.runs + row.runs, spendMicros: sum.spendMicros + row.spendMicros, expiredExtraMicros: sum.expiredExtraMicros + row.expiredExtraMicros
  }), { runs: 0, spendMicros: 0, expiredExtraMicros: 0 });
  // The folded rows' money reads as theirs would: spend if any spent, else
  // the first kind they share by the same precedence.
  const restMoney = (["spend", "included", "free", "unpriced"] as const).find((kind) => folded.some((row) => row.money === kind)) ?? "none";

  return (
    <Section title={LEDGER_COPY.wakes} meta={LEDGER_COPY.wakesMeta}>
      <div className="@container">
        <div className={cn(GRID, "px-3.5 text-xs")}>
          <span className={HEAD}>{WAKE_HEADS.why}</span>
          <span className={cn(HEAD, "@max-[40rem]:hidden")}>{WAKE_HEADS.who}</span>
          <span className={`${HEAD} text-right ${WIDE_ONLY}`}>{WAKE_HEADS.runs}</span>
          <span className={`${HEAD} text-right ${WIDE_ONLY}`}>{WAKE_HEADS.perRun}</span>
          <span className={`${HEAD} text-right`}>{WAKE_HEADS.spend}</span>
          <span className={`${HEAD} text-right`}>
            <span className="@max-[40rem]:hidden">{WAKE_HEADS.expired}</span>
            <span className="hidden @max-[40rem]:inline">{WAKE_HEADS.expiredNarrow}</span>
          </span>
        </div>
        {ledger.wakes.map((row, index) => (
          <div key={row.key} data-wake-row={row.key} className={cn(GRID, "px-3.5 text-xs", index >= NARROW_ROWS && "@max-[40rem]:hidden")}>
            <span className="flex min-w-0 flex-col gap-0.5 border-t border-border-soft py-2.5">
              <span className="truncate font-medium">
                {wakeLabel(row.key)}
                {row.timer && <span className="pill pill-neutral ml-1.5 align-middle">{LEDGER_COPY.timer}</span>}
              </span>
              <span data-wake-who="inline" className="hidden truncate text-2xs text-faint @max-[40rem]:block">{whoList(row.roles)}</span>
            </span>
            <span data-wake-who="column" className="flex items-center self-stretch truncate border-t border-border-soft text-muted-foreground @max-[40rem]:hidden">{whoList(row.roles)}</span>
            <span className={`${CELL} text-muted-foreground ${WIDE_ONLY}`}>{formatCount(row.runs)}</span>
            <span className={`${CELL} text-muted-foreground ${WIDE_ONLY}`}>
              {row.money === "spend" && row.runs > 0 ? formatUsd(Math.round(row.spendMicros / row.runs), estimated) : ledgerMoneyLabel(0, row.money, estimated)}
            </span>
            <span className={CELL}>{ledgerMoneyLabel(row.spendMicros, row.money, estimated)}</span>
            <span className={CELL}>{expiredCell(row, estimated)}</span>
          </div>
        ))}
        {folded.length > 0 && (
          <div data-wake-row="more" className={cn(GRID, "hidden px-3.5 text-xs @max-[40rem]:grid")}>
            <span className="border-t border-border-soft py-2.5 text-muted-foreground">{folded.length} more</span>
            <span className={`${CELL} text-muted-foreground ${WIDE_ONLY}`}>{formatCount(rest.runs)}</span>
            <span className={`${CELL} ${WIDE_ONLY}`} />
            <span className={CELL}>{ledgerMoneyLabel(rest.spendMicros, restMoney, estimated)}</span>
            <span className={CELL}>{expiredCell(rest, estimated)}</span>
          </div>
        )}
      </div>
    </Section>
  );
}
