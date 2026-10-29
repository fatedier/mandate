import type { FeaturePlanDto } from "@shared/api/plans";
import { planRounds } from "@shared/plan-rounds";
import type { ThreadWorker } from "@/hooks/useThreadWorkers";
import type { WorkerStripRow } from "@/routes/window/chat/worker-strip";
import { MONITOR_WAIT_LABEL, waitingStateLabel } from "@/lib/feature-status";
import { formatElapsedClock } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A worker not done yet, in the Workers tab: its name and project; its
 *  state and for how long, as the strip above the composer says them; the
 *  step it is on, or how far its steps have come; its goal. */
export function WorkerCard({ worker: w, groupLabel, plan, row, now, onOpen }: {
  worker: ThreadWorker;
  /** Its group's heading: a state the heading says is not said again. */
  groupLabel: string;
  plan: FeaturePlanDto | null;
  /** Its row on the strip, when it is at work there. */
  row: WorkerStripRow | null;
  now: number;
  onOpen: (featureId: string) => void;
}) {
  // Asleep on a monitor reads Watching or Monitoring, so the thread's
  // watching ring names its worker; a turn running, or a wait on the user,
  // still says its own state.
  const waits = !w.running && !w.waiting && w.state !== "asking" ? w.watching : null;
  const word = waits ? MONITOR_WAIT_LABEL[waits] : waitingStateLabel(w);
  // A turn running reads Running; the strip says what a monitor waits on by name.
  const says = row?.kind === "running" ? "Running" : row?.kind === "waiting" ? `${row.wait.lead} ${row.wait.label}` : word;
  const since = row?.since ? Date.parse(row.since) : Number.NaN;
  const clock = Number.isFinite(since) ? formatElapsedClock(Math.max(0, now - since)) : null;
  // The group already says it, unless the word adds something (Planning
  // under In progress) or is the live signal of a running worker.
  const shown = w.running || waits !== null || row?.kind === "waiting" || word !== groupLabel;
  const steps = plan ? planRounds(plan).current : [];
  const done = steps.filter((s) => s.status === "done").length;
  const at = steps.findIndex((s) => s.status === "in_progress");
  return (
    <button
      type="button"
      data-worker={w.name}
      onClick={() => onOpen(w.featureId)}
      className="flex min-w-0 flex-col justify-center gap-1 rounded-md border border-border-soft bg-panel px-2 py-1.5 text-left transition-colors hover:bg-sel pointer-coarse:min-h-11"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span data-slot="worker-name" className="min-w-0 truncate text-xs font-medium text-foreground">{w.name}</span>
        {/* The project takes what the name and the state leave, cut short. */}
        <span data-slot="worker-project" title={w.projectName} className="min-w-0 flex-1 basis-0 truncate text-2xs text-faint">{w.projectName}</span>
        {shown && (
          // A long label (a pane's name) gives way, up to most of the row; the clock stays.
          <span data-slot="worker-state" className={cn("ml-auto flex min-w-0 max-w-[60%] items-baseline text-2xs", w.running ? "text-live" : "text-faint")}>
            <span data-slot="worker-state-label" className="min-w-0 truncate">{says}</span>
            {clock && <span data-slot="worker-clock" className="shrink-0 whitespace-pre">{` · ${clock}`}</span>}
          </span>
        )}
      </span>
      {steps.length > 0 && (
        <span className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
          <span aria-hidden className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-sel">
            <span className="block h-full rounded-full bg-phase-working" style={{ width: `${Math.round((done / steps.length) * 100)}%` }} />
          </span>
          <span data-slot="worker-progress" className="min-w-0 truncate">
            {at >= 0 ? `Step ${at + 1} of ${steps.length} · ${steps[at]!.title}` : `${done} of ${steps.length} steps`}
          </span>
        </span>
      )}
      {plan?.goal && (
        <span data-slot="worker-goal" title={plan.goal} className="min-w-0 truncate text-2xs text-faint">{`Goal: ${plan.goal}`}</span>
      )}
    </button>
  );
}
