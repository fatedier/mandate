import type { SnapshotWindow } from "@/lib/snapshot-types";
import type { WorkItemDto } from "@shared/api/work-items";
import { formatWindowTitle } from "@/lib/window-format";
import { statusPillFor } from "@/lib/feature-status";
import { cn } from "@/lib/utils";

interface FeatureTitleProps {
  window: SnapshotWindow;
  workItem: WorkItemDto | null;
  /** Live activity (agent wake running or pane output still moving). Motion
   *  means real activity and nothing else, so it only ever lands on a dot
   *  inside the pill — never on the text. */
  active?: boolean;
}

/** Title row content for the left pane header: the human title the agent wrote
 *  (the tmux window name only when there is none) and the one status pill. */
export function FeatureTitle({ window, workItem, active }: FeatureTitleProps) {
  const humanTitle = workItem?.title?.trim();
  const title = humanTitle || formatWindowTitle(window);
  const pill = statusPillFor(workItem);
  return (
    <>
      <h1 data-slot="feature-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
        {title}
      </h1>
      {pill && (
        <span data-slot="feature-status" className={cn("pill", `pill-${pill.tone}`)}>
          {active && (
            <span aria-hidden data-slot="feature-live" className="size-1.5 shrink-0 rounded-full bg-current animate-live" />
          )}
          {pill.label}
        </span>
      )}
    </>
  );
}
