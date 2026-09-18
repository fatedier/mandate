import type { ActivityGroupDto, ActivityGroupKey } from "@shared/api-contracts";
import { cn } from "@/lib/utils";
import {
  cacheHitRate,
  formatCount,
  formatPercentileMs,
  formatTokenCount
} from "./activity-model";
import { GROUP_HEADINGS } from "./breakdown-model";

/** Drop tail metrics at 52rem, then input and cache at 40rem. The remaining
 *  space belongs to the group label; long names and reasons must not widen
 *  the table and push these retained metrics outside the container. */
const TIER_2 = "@max-[52rem]:hidden";
const TIER_1 = "@max-[40rem]:hidden";

/** The column heads are the one place a `label-micro` eyebrow is allowed
 *  inside a panel: a table needs names over its columns. */
const HEAD = "label-micro py-2 pl-3 text-right font-normal text-chrome first:pl-3.5 first:text-left last:pr-3.5";
// py-2: two lines of 2xs plus 16px of padding is the same 52px the `h-13`
// floor gives a one-line row, so the pitch holds down the column.
const CELL = "num py-2 pl-3 text-right text-2xs text-muted-foreground last:pr-3.5";

export function BreakdownTable({
  groups,
  group,
  onSelect
}: {
  groups: ActivityGroupDto[];
  group: ActivityGroupKey;
  onSelect: (key: string) => void;
}) {
  if (groups.length === 0) {
    return <p className="px-3.5 py-3 text-2xs text-faint">No calls in this window.</p>;
  }

  return (
    <div className="@container">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-xs">
          <thead>
            <tr data-slot="table-head" className="bg-sel/40">
              <th scope="col" className={HEAD}>{GROUP_HEADINGS[group]}</th>
              <th scope="col" className={HEAD}>Calls</th>
              <th scope="col" className={HEAD}>p50</th>
              <th scope="col" className={HEAD}>p95</th>
              <th scope="col" className={cn(HEAD, TIER_2)}>p99</th>
              <th scope="col" className={cn(HEAD, TIER_2)}>max</th>
              <th scope="col" className={HEAD}>Failed</th>
              <th scope="col" className={cn(HEAD, TIER_2)}>Fallback</th>
              <th scope="col" className={cn(HEAD, TIER_1)}>Input</th>
              <th scope="col" className={cn(HEAD, TIER_1)}>Cache</th>
              <th scope="col" className={cn(HEAD, TIER_2)}>Output</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((entry) => {
              const reason = entry.reasons[0];
              const cached = cacheHitRate(entry.inputTokens, entry.cacheReadTokens);
              const failedRate = entry.calls ? (entry.failed / entry.calls) * 100 : 0;
              const fallbackRate = entry.calls ? (entry.fallbackCalls / entry.calls) * 100 : 0;
              return (
                // The whole row is the target, and the button in the name cell
                // is the control. Not the same claim: a `<tr>` carrying
                // role="button" announces cleanly and takes the table's own
                // semantics down with it, so the row keeps no role — only the
                // handler and the pointer affordance — while focus and Enter
                // reach the real button. Eleven columns of figures with a
                // clickable strip of text at the left edge is a target the
                // width of the longest model name.
                //
                // `h-13`: a table row's height is its minimum, so a one-line
                // group still gets the 52px pitch a two-line one has.
                <tr
                  key={entry.key}
                  onClick={() => onSelect(entry.key)}
                  className="h-13 cursor-pointer border-t border-border-soft align-top hover:bg-sel focus-within:bg-sel"
                >
                  <td className="w-full max-w-0 py-2 pl-3.5 pr-3">
                    <button
                      type="button"
                      // Bubbling would reach the row's handler and select the
                      // same group twice.
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(entry.key);
                      }}
                      className="block max-w-full truncate text-left font-mono text-xs font-medium text-foreground"
                      title={entry.label}
                    >
                      {entry.label}
                    </button>
                    {reason && (
                      <span
                        data-group-reason
                        className="mt-0.5 block max-w-[26rem] truncate text-2xs text-faint"
                        title={`${reason.reason} (${formatCount(reason.calls)})`}
                      >
                        {reason.reason} · {formatCount(reason.calls)}
                      </span>
                    )}
                  </td>
                  <td className={CELL}>{formatCount(entry.calls)}</td>
                  <td className={CELL}>{formatPercentileMs(entry.p50Ms)}</td>
                  <td className={CELL}>{formatPercentileMs(entry.p95Ms)}</td>
                  <td className={cn(CELL, TIER_2)}>{formatPercentileMs(entry.p99Ms)}</td>
                  <td className={cn(CELL, TIER_2)}>{formatPercentileMs(entry.maxMs)}</td>
                  {/* Failures are the only coloured figure on the page. */}
                  <td
                    data-col="failed"
                    data-alert={entry.failed > 0 ? "true" : "false"}
                    className={cn(CELL, entry.failed > 0 && "text-destructive")}
                  >
                    {failedRate.toFixed(1)}%
                  </td>
                  <td className={cn(CELL, TIER_2)}>
                    {entry.fallbackCalls === 0 ? "—" : `${fallbackRate.toFixed(1)}%`}
                  </td>
                  <td className={cn(CELL, TIER_1)}>{formatTokenCount(entry.inputTokens)}</td>
                  <td className={cn(CELL, TIER_1)}>
                    {cached === null ? "—" : `${Math.round(cached)}%`}
                  </td>
                  <td className={cn(CELL, TIER_2)}>{formatTokenCount(entry.outputTokens)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
