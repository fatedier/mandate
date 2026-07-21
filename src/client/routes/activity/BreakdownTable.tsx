import type { ActivityGroupDto, ActivityGroupKey } from "@shared/api-contracts";
import { cn } from "@/lib/utils";
import {
  cacheHitRate,
  formatCount,
  formatPercentileMs,
  formatTokenCount
} from "./activity-model";

/** Drop tail metrics at 52rem, then input and cache at 40rem. The remaining
 *  space belongs to the group label; long names and reasons must not widen
 *  the table and push these retained metrics outside the container. */
const TIER_2 = "@max-[52rem]:hidden";
const TIER_1 = "@max-[40rem]:hidden";

const HEADINGS: Record<ActivityGroupKey, string> = {
  model: "Provider / model",
  purpose: "Purpose",
  scopeType: "Scope type",
  day: "Day",
  fallback: "Fallback"
};

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
    return <p className="text-xs text-chrome">No calls in this window.</p>;
  }

  return (
    <div className="@container">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-collapse text-xs">
          <thead>
            <tr className="text-2xs text-chrome">
              <th scope="col" className="py-1 text-left font-normal">{HEADINGS[group]}</th>
              <th scope="col" className="py-1 pl-3 text-right font-normal">Calls</th>
              <th scope="col" className="py-1 pl-3 text-right font-normal">p50</th>
              <th scope="col" className="py-1 pl-3 text-right font-normal">p95</th>
              <th scope="col" className={cn("py-1 pl-3 text-right font-normal", TIER_2)}>p99</th>
              <th scope="col" className={cn("py-1 pl-3 text-right font-normal", TIER_2)}>max</th>
              <th scope="col" className="py-1 pl-3 text-right font-normal">Failed</th>
              <th scope="col" className={cn("py-1 pl-3 text-right font-normal", TIER_2)}>Fallback</th>
              <th scope="col" className={cn("py-1 pl-3 text-right font-normal", TIER_1)}>Input</th>
              <th scope="col" className={cn("py-1 pl-3 text-right font-normal", TIER_1)}>Cache</th>
              <th scope="col" className={cn("py-1 pl-3 text-right font-normal", TIER_2)}>Output</th>
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
                <tr
                  key={entry.key}
                  onClick={() => onSelect(entry.key)}
                  className="cursor-pointer border-t border-border-soft align-top hover:bg-muted/50 focus-within:bg-muted/50"
                >
                  <td className="w-full max-w-0 py-2 pr-3">
                    <button
                      type="button"
                      // Bubbling would reach the row's handler and select the
                      // same group twice.
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(entry.key);
                      }}
                      className="block max-w-full truncate text-left font-medium text-foreground"
                      title={entry.label}
                    >
                      {entry.label}
                    </button>
                    {reason && (
                      <span
                        data-group-reason
                        className="mt-0.5 block max-w-[26rem] truncate text-2xs text-chrome"
                        title={`${reason.reason} (${formatCount(reason.calls)})`}
                      >
                        {reason.reason} · {formatCount(reason.calls)}
                      </span>
                    )}
                  </td>
                  <td className="num py-2 pl-3 text-right">{formatCount(entry.calls)}</td>
                  <td className="num py-2 pl-3 text-right">{formatPercentileMs(entry.p50Ms)}</td>
                  <td className="num py-2 pl-3 text-right">{formatPercentileMs(entry.p95Ms)}</td>
                  <td className={cn("num py-2 pl-3 text-right", TIER_2)}>{formatPercentileMs(entry.p99Ms)}</td>
                  <td className={cn("num py-2 pl-3 text-right", TIER_2)}>{formatPercentileMs(entry.maxMs)}</td>
                  <td className={cn("num py-2 pl-3 text-right", entry.failed > 0 && "text-destructive")}>
                    {failedRate.toFixed(1)}%
                  </td>
                  <td className={cn("num py-2 pl-3 text-right", TIER_2)}>
                    {entry.fallbackCalls === 0 ? "—" : `${fallbackRate.toFixed(1)}%`}
                  </td>
                  <td className={cn("num py-2 pl-3 text-right", TIER_1)}>{formatTokenCount(entry.inputTokens)}</td>
                  <td className={cn("num py-2 pl-3 text-right", TIER_1)}>
                    {cached === null ? "—" : `${Math.round(cached)}%`}
                  </td>
                  <td className={cn("num py-2 pl-3 text-right", TIER_2)}>{formatTokenCount(entry.outputTokens)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
