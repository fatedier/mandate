import type { ActivityGroupKey, ActivitySummaryResponse } from "@shared/api-contracts";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BreakdownTable } from "./BreakdownTable";
import { GROUP_OPTIONS } from "./breakdown-model";
import { useBreakdownPageSummary } from "./useActivityPageSummary";

/**
 * The same table, re-grouped.
 *
 * Every column is the same whichever dimension is selected — only the first one
 * changes. That is what makes two groupings comparable: a reader switching from
 * model to scope type is reading the same figures about a different cut, not a
 * different report.
 */
export function BreakdownTab({
  data,
  loading,
  group,
  onSelectGroup,
  onSelectRow
}: {
  data: ActivitySummaryResponse | null;
  loading: boolean;
  group: ActivityGroupKey;
  onSelectGroup: (group: ActivityGroupKey) => void;
  onSelectRow: (key: string) => void;
}) {
  // Before the early return: the agent asking what this page shows has to get
  // an answer while it is still loading, and hooks cannot be conditional.
  useBreakdownPageSummary(data);

  if (!data) return loading ? <Skeleton className="h-64 rounded-lg" /> : null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border-soft bg-card p-4">
      {/* Named, because the header carries a second row of pressed buttons for
          the window. Two unlabelled groups of `aria-pressed` controls on one
          page are indistinguishable to anything that addresses them by state
          — a screen reader reading them out, or a test looking for the pressed
          one. */}
      <div role="group" aria-label="Group by" className="flex flex-wrap items-center gap-2">
        <span className="label-micro text-chrome">Group by</span>
        {GROUP_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={option.id === group}
            onClick={() => onSelectGroup(option.id)}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-2xs transition-colors",
              option.id === group
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {/* `data.group`, not the `group` prop: the table names the dimension the
          response was built from, so a request still in flight leaves the
          previous answer under its own heading rather than the new one's. */}
      <BreakdownTable groups={data.groups} group={data.group} onSelect={onSelectRow} />
    </section>
  );
}
