import type { ActivityGroupKey, ActivitySummaryResponse } from "@shared/api-contracts";
import { Section } from "@/components/Section";
import { cn } from "@/lib/utils";
import { ActivityListSkeleton } from "./ActivitySkeleton";
import { BreakdownTable } from "./BreakdownTable";
import { GROUP_HEADINGS, GROUP_OPTIONS } from "./breakdown-model";
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

  if (!data) return loading ? <ActivityListSkeleton /> : null;

  return (
    // `data.group`, not the `group` prop, names the section: the table shows
    // the dimension the response was built from, so a request still in flight
    // leaves the previous answer under its own heading rather than the new
    // one's. The picker, by contrast, presses the one the reader asked for.
    <Section
      title={GROUP_HEADINGS[data.group]}
      meta="grouped"
      // Five buttons do not fit beside the title on a phone; there the picker
      // is its own line under the header. Two copies, each gated by the
      // section's container width, so the header stays 32px at every width
      // and wide is untouched — only the hidden one is ever `display:none`,
      // which also keeps it out of the accessibility tree and the tab order.
      trailing={<GroupPicker group={group} onSelectGroup={onSelectGroup} className="@max-[34rem]:hidden" />}
      subheader={<GroupPicker group={group} onSelectGroup={onSelectGroup} className="hidden @max-[34rem]:flex" />}
    >
      <BreakdownTable groups={data.groups} group={data.group} onSelect={onSelectRow} />
    </Section>
  );
}

// Named, because the header band carries a second group of pressed buttons
// for the window. Two unlabelled groups of `aria-pressed` controls on one page
// are indistinguishable to anything that addresses them by state — a screen
// reader reading them out, or a test looking for the pressed one. Styled as
// the window control is: a --sel fill marks the pressed one, no accent border.
function GroupPicker({
  group,
  onSelectGroup,
  className
}: {
  group: ActivityGroupKey;
  onSelectGroup: (group: ActivityGroupKey) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Group by" className={cn("flex flex-wrap items-center gap-0.5", className)}>
      {GROUP_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === group}
          onClick={() => onSelectGroup(option.id)}
          className={cn(
            "inline-flex h-7 items-center rounded px-2 text-2xs transition-colors",
            option.id === group
              ? "bg-sel font-semibold text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
