import type { ActivityGroupDto, ActivityGroupKey } from "@shared/api-contracts";
import { formatCalendarDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  cacheHitRate,
  formatCount,
  formatPercentileMs,
  formatTokenCount
} from "./activity-model";
import { GROUP_LABELS } from "./breakdown-model";
import { groupSpendLabel } from "./money";

/** Drop tail metrics at 52rem, then input and cache at 40rem. The remaining
 *  space belongs to the group label; long names and reasons must not widen
 *  the table and push these retained metrics outside the container. */
const TIER_2 = "@max-[52rem]:hidden";
const TIER_1 = "@max-[40rem]:hidden";

/* Below 28rem (a phone) a group stacks: its name and reason across the row,
   then the four core figures on a line under them, each led by its column's
   name, since only the first column's head is left above them. Above, it is the table, with no
   floor of its own: a 34rem one scrolled a phone sideways past every figure
   and cut the Failed column off a 520px section. The figures fit
   one line at phone widths (a 375px screen and up); in anything narrower the
   row wraps them to a second line rather than overflow. The classes are
   spelled out whole: Tailwind finds them by reading the source. */

/** The column heads are the one place a `label-micro` eyebrow is allowed
 *  inside a panel: a table needs names over its columns. */
const HEAD = "label-micro py-2 pl-3 text-right font-normal text-chrome first:pl-3.5 first:text-left last:pr-3.5 @max-[28rem]:not-first:hidden";
// py-2: two lines of 2xs plus 16px of padding is the same 52px the `h-13`
// floor gives a one-line row, so the pitch holds down the column.
const CELL = cn(
  "num whitespace-nowrap py-2 pl-3 text-right text-2xs text-muted-foreground last:pr-3.5",
  "@max-[28rem]:p-0 @max-[28rem]:text-left @max-[28rem]:before:mr-1 @max-[28rem]:before:text-chrome @max-[28rem]:before:content-[attr(data-label)]"
);

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
  // The server labels a day with its key; it reads as a date.
  const labelOf = (entry: ActivityGroupDto) =>
    group === "day" ? formatCalendarDay(entry.key) || entry.label : entry.label;

  return (
    <div className="@container">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs @max-[28rem]:block">
          {/* Stacked, the head keeps its first cell: it names the grouping
              the rows were built from, which a regrouping still in flight
              leaves on screen under the newly pressed button. */}
          <thead className="@max-[28rem]:block">
            <tr data-slot="table-head" className="bg-sel/40 @max-[28rem]:block">
              <th scope="col" className={HEAD}>{GROUP_LABELS[group]}</th>
              <th scope="col" className={HEAD}>Calls</th>
              <th scope="col" className={HEAD}>Spend</th>
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
          <tbody className="@max-[28rem]:block">
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
                  className={cn(
                    "h-13 cursor-pointer border-t border-border-soft align-top hover:bg-sel focus-within:bg-sel",
                    "@max-[28rem]:relative @max-[28rem]:flex @max-[28rem]:h-auto @max-[28rem]:flex-wrap @max-[28rem]:gap-x-3 @max-[28rem]:gap-y-0.5 @max-[28rem]:px-3.5 @max-[28rem]:py-2.5",
                    // Stacked on a touch screen the name button's area is the
                    // whole row, so the row is not a second target around it.
                    "pointer-coarse:@max-[28rem]:cursor-auto"
                  )}
                >
                  {/* On a touch screen the name's touch area is its whole cell
                      (centred on the name it would reach into the row above);
                      stacked, its whole row, since the cell is the name alone. */}
                  <td className="w-full max-w-0 py-2 pl-3.5 pr-3 pointer-coarse:@min-[28rem]:relative @max-[28rem]:block @max-[28rem]:max-w-full @max-[28rem]:basis-full @max-[28rem]:p-0">
                    <button
                      type="button"
                      // Bubbling would reach the row's handler and select the
                      // same group twice.
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(entry.key);
                      }}
                      className={cn(
                        "block max-w-full text-left text-xs font-medium text-foreground pointer-coarse:after:absolute pointer-coarse:after:inset-0 pointer-coarse:after:content-['']",
                        // Models, purposes and scopes are identifiers; a day is a date.
                        group !== "day" && "font-mono"
                      )}
                      title={labelOf(entry)}
                    >
                      {/* Truncated inside: overflow on the button would clip its touch area. */}
                      <span className="block truncate">{labelOf(entry)}</span>
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
                  <td data-label="Calls" className={CELL}>{formatCount(entry.calls)}</td>
                  <td data-label="Spend" className={CELL}>{groupSpendLabel(entry)}</td>
                  <td data-label="p50" className={CELL}>{formatPercentileMs(entry.p50Ms)}</td>
                  <td data-label="p95" className={CELL}>{formatPercentileMs(entry.p95Ms)}</td>
                  <td data-label="p99" className={cn(CELL, TIER_2)}>{formatPercentileMs(entry.p99Ms)}</td>
                  <td data-label="max" className={cn(CELL, TIER_2)}>{formatPercentileMs(entry.maxMs)}</td>
                  {/* Failures are the only coloured figure on the page. */}
                  <td
                    data-col="failed"
                    data-label="Failed"
                    data-alert={entry.failed > 0 ? "true" : "false"}
                    className={cn(CELL, entry.failed > 0 && "text-destructive")}
                  >
                    {failedRate.toFixed(1)}%
                  </td>
                  <td data-label="Fallback" className={cn(CELL, TIER_2)}>
                    {entry.fallbackCalls === 0 ? "—" : `${fallbackRate.toFixed(1)}%`}
                  </td>
                  <td data-label="Input" className={cn(CELL, TIER_1)}>{formatTokenCount(entry.inputTokens)}</td>
                  <td data-label="Cache" className={cn(CELL, TIER_1)}>
                    {cached === null ? "—" : `${Math.round(cached)}%`}
                  </td>
                  <td data-label="Output" className={cn(CELL, TIER_2)}>{formatTokenCount(entry.outputTokens)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
