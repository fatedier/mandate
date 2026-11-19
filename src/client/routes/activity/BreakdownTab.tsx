import { useId } from "react";
import { ChevronRight } from "lucide-react";
import type { ActivityGroupDto, ActivityGroupKey, ActivitySummaryResponse } from "@shared/api-contracts";
import { Fold } from "@/components/Fold";
import { Section } from "@/components/Section";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/store/ui";
import { ActivityListSkeleton } from "./ActivitySkeleton";
import { BreakdownTable } from "./BreakdownTable";
import { failRanking, GROUP_OPTIONS, shortGroupLabels, spendRanking } from "./breakdown-model";
import { formatCount } from "./activity-model";
import { DayTrends } from "./breakdown/DayTrends";
import { RankedList } from "./breakdown/RankedList";
import { SpeedMap } from "./breakdown/SpeedMap";
import { formatUsd } from "./money";

/**
 * The window's calls, cut by a dimension: a speed map and two ranked lists
 * (spend, fails) over the groups — by day, the busiest models' lines day by
 * day — then the table with every figure, folded.
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
  if (!data) return loading ? <ActivityListSkeleton /> : null;

  return (
    // The header names the picker, not the grouping: the pressed button and
    // the first column's head already say it (the title made three). The
    // column head is the table's, so it names `data.group`, the dimension the
    // response was built from — a request still in flight leaves the previous
    // answer under its own heading; the picker presses the one asked for.
    <Section
      title="Group by"
      // Five buttons do not fit beside the title on a phone; there the picker
      // is its own line under the header. Two copies, each gated by the
      // section's container width, so the header stays 32px at every width
      // and wide is untouched — only the hidden one is ever `display:none`,
      // which also keeps it out of the accessibility tree and the tab order.
      trailing={<GroupPicker group={group} onSelectGroup={onSelectGroup} className="@max-[34rem]:hidden" />}
      subheader={<GroupPicker group={group} onSelectGroup={onSelectGroup} className="hidden @max-[34rem]:flex" />}
      panel={false}
    >
      {data.groups.length === 0 ? (
        // Nothing to chart or fold: the table says there were no calls.
        <div className="overflow-hidden rounded-lg border border-border-soft bg-panel">
          <BreakdownTable groups={data.groups} group={data.group} onSelect={onSelectRow} />
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {data.group !== "day" && <GroupCharts groups={data.groups} group={data.group} onSelect={onSelectRow} />}
          {/* By day, the lines of the busiest models over the window instead:
              a day's own row would be one more bar among thirty. */}
          {data.group === "day" && data.trend && data.trend.series.length > 0 && (
            <DayTrends trend={data.trend} estimated={data.spend.estimated} onSelect={onSelectRow} />
          )}
          <TableFold groups={data.groups} group={data.group} onSelect={onSelectRow} />
        </div>
      )}
    </Section>
  );
}

const SPEED_KEY = "Dot size: calls · red: fails 10% or more";

/** The speed map, then where the money went and what fails, side by side
 *  (stacked on a phone). A list with nothing to rank is left out. */
function GroupCharts({ groups, group, onSelect }: {
  groups: ActivityGroupDto[];
  group: ActivityGroupKey;
  onSelect: (key: string) => void;
}) {
  const labels = shortGroupLabels(groups, group);
  const spend = spendRanking(groups, labels);
  const fails = failRanking(groups, labels);
  const spent = groups.reduce((sum, entry) => sum + entry.spendMicros, 0);
  const estimated = groups.some((entry) => entry.spendEstimated);
  return (
    <>
      <Section
        title="Speed"
        meta={SPEED_KEY}
        // The key says what red means; narrow, the meta goes, so it is a line
        // of its own there.
        subheader={<p className="hidden text-2xs text-faint @max-[34rem]:block">{SPEED_KEY}</p>}
      >
        <SpeedMap groups={groups} group={group} onSelect={onSelect} />
      </Section>
      {(spend.length > 0 || fails.length > 0) && (
        <div className="grid gap-6 @min-[34rem]:grid-cols-2">
          {spend.length > 0 && (
            <Section title="Spend" meta={`${formatUsd(spent, estimated)} in all`}>
              <RankedList rows={spend} tone="spend" onSelect={onSelect} />
            </Section>
          )}
          {fails.length > 0 && (
            <Section title="Fails" meta="of calls">
              <RankedList rows={fails} tone="fail" onSelect={onSelect} />
            </Section>
          )}
        </div>
      )}
    </>
  );
}

/** Every figure, by group, under the charts: folded until opened, and left
 *  as the reader last left it (on this device). */
function TableFold({ groups, group, onSelect }: {
  groups: ActivityGroupDto[];
  group: ActivityGroupKey;
  onSelect: (key: string) => void;
}) {
  const open = useUIStore((state) => state.breakdownTableOpen);
  const setOpen = useUIStore((state) => state.setBreakdownTableOpen);
  const id = useId();
  const noun = group === "model" ? "model" : "group";
  return (
    <Section
      panel={false}
      title={
        <button
          type="button"
          data-breakdown-fold
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="hit relative inline-flex h-7 items-center gap-1 rounded text-xs font-semibold text-foreground"
        >
          <ChevronRight aria-hidden className={cn("size-3.5 text-faint transition-transform", open && "rotate-90")} />
          The table
        </button>
      }
      meta={`${formatCount(groups.length)} ${noun}${groups.length === 1 ? "" : "s"}`}
    >
      <Fold open={open} id={id} className="overflow-hidden rounded-lg border border-border-soft bg-panel">
        <BreakdownTable groups={groups} group={group} onSelect={onSelect} />
      </Fold>
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
    <div
      role="group"
      aria-label="Group by"
      // 16px between wrapped rows on a touch screen: a 28px pill reaches 8px.
      className={cn("flex flex-wrap items-center gap-0.5 pointer-coarse:gap-y-4", className)}
    >
      {GROUP_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === group}
          onClick={() => onSelectGroup(option.id)}
          className={cn(
            "hit relative inline-flex h-7 items-center justify-center rounded px-2 text-2xs transition-colors pointer-coarse:min-w-11",
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
