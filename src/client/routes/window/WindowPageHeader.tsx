import type { SnapshotWindow } from "@/lib/snapshot-types";
import type { WorkItemDto } from "@shared/api/work-items";
import { formatWindowTitle } from "@/lib/window-format";
import { RelativeTime } from "@/components/RelativeTime";
import { PhaseDot } from "@/components/PhaseDot";
import { cn } from "@/lib/utils";

interface WindowPageHeaderProps {
  window: SnapshotWindow;
  workItem: WorkItemDto | null;
  /** Live activity (wake running or pane output still moving) — drives the
   *  phase dot's breathing, the same signal pair the project cards use. */
  active?: boolean;
}

// Attention is the only thing here that asks the user to act, so it is the only
// thing that gets a filled pill. Phase is ambient state and renders as a dot +
// label on the metadata row — previously both were pills of equal weight, which
// left no way to tell a status from a call to action at a glance.
const NEEDS_BADGE: Record<"input" | "review", string> = {
  input: "bg-status-input/15 text-status-input ring-1 ring-inset ring-status-input/30",
  review: "bg-status-review/15 text-status-review ring-1 ring-inset ring-status-review/30"
};

const NEEDS_LABEL: Record<"input" | "review", string> = {
  input: "needs input",
  review: "needs review"
};

export function WindowPageHeader({ window, workItem, active }: WindowPageHeaderProps) {
  const needsUser = workItem?.needsUser ?? null;
  const phase = workItem?.phase ?? null;
  const phaseDetail = workItem?.phaseDetail ?? null;
  const lastActivityAt = workItem?.lastActivityAt ?? null;

  // The agent writes a human title onto the work item; the tmux window name is a
  // machine identifier. Leading with the identifier made the largest text on the
  // page the least readable thing on it, so the human title wins when present
  // and the identifier only stands in when there is no human title.
  //
  // It used to also ride along as a chip in the metadata row. That cost ~360px
  // of a row that had ~700px for ~960px of content, which is why everything in
  // it was truncating at once — and it bought nothing: the breadcrumb above
  // already carries the feature name, and the window name is a sanitised
  // derivation of it. The only thing it added was the tmux window index, which
  // is terminal-era furniture on a page whose subject is the work.
  const slug = formatWindowTitle(window);
  const humanTitle = workItem?.title?.trim();
  const title = humanTitle || slug;

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2.5">
        <h2 className="min-w-0 truncate text-xl font-semibold">{title}</h2>
        {needsUser && (
          <span className={cn("shrink-0 rounded-md px-2 py-1 label-micro", NEEDS_BADGE[needsUser])}>
            {NEEDS_LABEL[needsUser]}
          </span>
        )}
      </div>

      {/* One run, left to right — nothing is pushed to the far edge. The phase
          group shrinks (min-w-0, default flex-shrink) so a long detail truncates,
          but it must not *grow*: as flex-1 it became a strut that shoved the rest
          of the row to the right margin whenever there was no detail to fill it.
          The timestamp isn't a column in a table, just one more piece of
          metadata, so it sits with the others rather than across a gap. */}
      <div className="mt-1.5 flex min-w-0 items-center gap-2.5 text-chrome">
        {phase && (
          <span className="min-w-0">
            <PhaseDot phase={phase} active={active} detail={phaseDetail ?? undefined} />
          </span>
        )}
        {lastActivityAt && (
          <span className="num shrink-0 font-mono text-2xs">
            <RelativeTime value={lastActivityAt} />
          </span>
        )}
      </div>
    </div>
  );
}
