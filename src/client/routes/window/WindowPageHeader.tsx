import type { SnapshotWindow } from "@/lib/snapshot-types";
import type { WorkItemDto } from "@shared/api/work-items";
import { formatWindowTitle } from "@/lib/window-format";
import { featureStatePill } from "@/lib/feature-status";
import { useFeaturePlan } from "@/store/feature-plans";
import { useFeatureWakeActive } from "@/store/wake-activity";
import { cn } from "@/lib/utils";

interface FeatureTitleProps {
  featureId: string;
  /** Null when the worker's tmux window is gone: its chat, plan and reports
   *  still work, and the line under the name says the window is missing. */
  window: SnapshotWindow | null;
  /** The name when there is neither a human title nor a window to name it. */
  featureName?: string;
  /** What the worker is still waiting on, when nothing runs: the wait its
   *  chat's waiting line leads with, as that line names it. */
  waitingOn?: { lead: "Watching" | "Monitoring" | "Wakes at"; label: string } | null;
  workItem: WorkItemDto | null;
  /** The worker agent has a wake running. Shown under the name, apart from
   *  the feature's state, which the plan decides. */
  workerRunning?: boolean;
  /** Live activity (agent wake running or pane output still moving). Motion
   *  means real activity and nothing else, so it only ever lands on a dot
   *  inside the pill — never on the text. */
  active?: boolean;
}

/** Title row content for the left pane header: the human title the agent wrote
 *  (the tmux window name only when there is none), the worker's activity under
 *  it, and the one state pill. Without a window the name keeps its line and
 *  the one under it says the window is missing. */
export function FeatureTitle({ featureId, window, featureName = "", workItem, active, workerRunning, waitingOn = null }: FeatureTitleProps) {
  const humanTitle = workItem?.title?.trim();
  const title = humanTitle || (window ? formatWindowTitle(window) : featureName);
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <h1 data-slot="feature-title" className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {title}
        </h1>
        <span data-slot="worker-activity" className="truncate text-2xs text-faint">
          {workerRunning ? "worker running" : waitingOn ? `worker ${waitingOn.lead.toLowerCase()} ${waitingOn.label}` : "worker idle"}
          {!window && " · window missing"}
        </span>
      </span>
      <FeatureStatusPill featureId={featureId} workItem={workItem} active={active} />
    </>
  );
}

/** The worker's one state pill in its page's header, with or without its
 *  window: the page's Plan section leaves the state to it. */
export function FeatureStatusPill({ featureId, workItem, active }: { featureId: string; workItem: WorkItemDto | null; active?: boolean }) {
  // A worker still in its turn is at work, whatever it has asked meanwhile.
  const running = useFeatureWakeActive(featureId);
  const pill = featureStatePill(useFeaturePlan(featureId), workItem?.failedAt ?? null, workItem?.failedKind ?? null, running);
  return (
    <span data-slot="feature-status" className={cn("pill", `pill-${pill.tone}`)}>
      {active && (
        <span aria-hidden data-slot="feature-live" className="size-1.5 shrink-0 rounded-full bg-current animate-live" />
      )}
      {pill.label}
    </span>
  );
}
