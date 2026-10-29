import { useEffect, useState, type ReactNode } from "react";
import { Fold } from "@/components/Fold";
import { Check, ChevronRight, FileText, LayoutGrid } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import type { FeaturePlanDto } from "@shared/api/plans";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useWorkerStripRows } from "@/hooks/useWorkerStrip";
import { useSecondClock } from "@/hooks/useSecondClock";
import { useThreadCanvases } from "./use-thread-canvases";
import { WorkerCard } from "./WorkerCard";
import { API_PATHS } from "@shared/api-contracts";
import type { ThreadWorkerRefDto, ThreadWorkersResponse } from "@shared/api/agents";
import { apiPath } from "@/lib/api-base";
import { groupWorkers, WORKER_GROUP_LABEL } from "@/lib/worker-groups";
import type { ThreadWorker } from "@/hooks/useThreadWorkers";
import { cn } from "@/lib/utils";

/** Done workers and canvases shown before the rest fold under "N more". */
const FOLD_AFTER = 3;

/**
 * The thread's Workers tab: a card for each worker not done yet, under why
 * it waits or what it does; one line for each done worker, newest first;
 * the thread's reports and canvases, newest first; then the archived ones.
 */
export function WorkersOverview({ threadId, workers, onOpen, onOpenArchived, onOpenCanvas, threadArchived = false }: {
  threadId: string;
  workers: ThreadWorker[];
  onOpen: (featureId: string) => void;
  onOpenArchived: (worker: ThreadWorkerRefDto) => void;
  /** A report or canvas opens beside the chat (the page's panel). */
  onOpenCanvas: (canvasId: string) => void;
  /** The thread is archived: its workers all are, and are listed at once. */
  threadArchived?: boolean;
}) {
  // null: not fetched (or a failure the next opening retries); "error": failed.
  const [archived, setArchived] = useState<ThreadWorkerRefDto[] | null | "error">(null);
  const [showArchived, setShowArchived] = useState(threadArchived);
  useEffect(() => {
    if (!showArchived || archived !== null) return;
    void fetch(`${apiPath(API_PATHS.agentManagerThreadWorkers(threadId))}?archived=1`)
      .then(async (r) => {
        const b = await r.json() as ThreadWorkersResponse;
        setArchived(r.ok && "workers" in b ? b.workers : "error");
      })
      .catch(() => setArchived("error"));
  }, [archived, showArchived, threadId]);

  // Reopening after a failure tries again.
  const toggleArchived = () => {
    if (!showArchived && archived === "error") setArchived(null);
    setShowArchived((v) => !v);
  };

  const plans = useFeaturePlansStore((s) => s.plans);
  const strip = useWorkerStripRows(workers);
  const now = useSecondClock();
  const { canvases } = useThreadCanvases(threadId, workers.map((w) => w.featureId).sort().join(","));
  const atWork = workers.filter((w) => w.state !== "done");
  const done = workers
    .filter((w) => w.state === "done")
    .map((w) => ({ worker: w, plan: plans.get(w.featureId) ?? null }))
    .map((d) => ({ ...d, finished: finishedAt(d.plan) }))
    .sort((a, b) => b.finished.localeCompare(a.finished));

  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-3">
      {workers.length === 0 && !showArchived && (
        <p className="px-2 text-sm text-faint">No active workers. The manager starts one when this thread needs work done.</p>
      )}
      {groupWorkers(atWork).map((group) => (
        <section key={group.key} aria-label={WORKER_GROUP_LABEL[group.key]} className="flex flex-col gap-1">
          <h3 className="label-group px-2">{WORKER_GROUP_LABEL[group.key]}</h3>
          <div className="flex flex-col gap-1.5">
            {group.workers.map((w) => (
              <WorkerCard
                key={w.featureId}
                worker={w}
                groupLabel={WORKER_GROUP_LABEL[group.key]}
                plan={plans.get(w.featureId) ?? null}
                row={strip.find((r) => r.featureId === w.featureId) ?? null}
                now={now}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}
      {done.length > 0 && (
        <Folded label="Done" count={done.length} more={(n) => `${n} more done`}>
          {done.map(({ worker, plan, finished }) => (
            <button key={worker.featureId} type="button" data-slot="done-worker" onClick={() => onOpen(worker.featureId)} className={LINE}>
              <Check aria-hidden className="size-3.5 shrink-0 text-phase-done" />
              {/* A long name gives way, up to half the row; the time stays. */}
              <span data-slot="done-name" className="max-w-[50%] shrink-0 truncate font-medium text-foreground">{worker.name}</span>
              {plan?.conclusion && <span className="min-w-0 flex-1 truncate text-muted-foreground">{firstSentence(plan.conclusion)}</span>}
              {finished && <span data-slot="done-time" className="ml-auto shrink-0 text-faint"><RelativeTime value={finished} /></span>}
            </button>
          ))}
        </Folded>
      )}
      {canvases && canvases.length > 0 && (
        <Folded label="Reports and canvases" count={canvases.length} more={(n) => `${n} more`}>
          {canvases.map((canvas) => {
            const Icon = canvas.kind === "design" ? LayoutGrid : FileText;
            return (
              <button key={canvas.id} type="button" data-slot="thread-canvas" onClick={() => onOpenCanvas(canvas.id)} className={LINE}>
                <Icon aria-hidden className="size-3.5 shrink-0 text-chrome" />
                <span data-slot="thread-canvas-title" className="min-w-0 flex-1 truncate font-medium text-foreground">{canvas.title}</span>
                {/* Who wrote it gives way, up to half the row; the time stays. */}
                <span className="ml-auto flex min-w-0 max-w-[50%] items-baseline text-faint">
                  <span data-slot="thread-canvas-by" className="min-w-0 truncate">{canvas.featureName ?? "Manager"}</span>
                  <span data-slot="thread-canvas-time" className="shrink-0 whitespace-pre"> · <RelativeTime value={canvas.updatedAt} /></span>
                </span>
              </button>
            );
          })}
        </Folded>
      )}
      <ArchivedToggle open={showArchived} onToggle={toggleArchived} />
      <Fold open={showArchived}>
        <section aria-label="Archived" className="flex flex-col gap-1">
          {(Array.isArray(archived) ? archived : []).map((w) => (
            <button key={w.featureId} type="button" onClick={() => onOpenArchived(w)} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-sel pointer-coarse:min-h-11">
              <span className="min-w-0 truncate text-xs">{w.name}</span>
              <span className="shrink-0 text-2xs text-faint">{w.projectName}</span>
            </button>
          ))}
          {Array.isArray(archived) && archived.length === 0 && <p className="px-2 text-2xs text-faint">None.</p>}
          {archived === "error" && <p className="px-2 text-2xs text-faint">Could not load archived workers.</p>}
        </section>
      </Fold>
    </div>
  );
}

const LINE = "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-sel pointer-coarse:min-h-11";

/** A list under its heading and count: the first few, the rest behind "N more". */
function Folded({ label, count, more, children }: { label: string; count: number; more: (n: number) => string; children: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  const rest = children.length - FOLD_AFTER;
  return (
    <section aria-label={label} className="flex flex-col gap-1">
      <h3 className="label-group px-2">{label}<span className="num whitespace-pre text-faint"> · {count}</span></h3>
      {open || rest <= 0 ? children : children.slice(0, FOLD_AFTER)}
      {!open && rest > 0 && (
        <button type="button" aria-expanded={false} onClick={() => setOpen(true)} className="flex items-center gap-1 px-1 text-2xs text-chrome hover:text-foreground pointer-coarse:min-h-11">
          <ChevronRight className="h-3 w-3" />
          {more(rest)}
        </button>
      )}
    </section>
  );
}

/** When a done worker finished: its latest finished step, else its plan's last write. */
function finishedAt(plan: FeaturePlanDto | null): string {
  if (!plan) return "";
  const latest = plan.steps.reduce((at, step) => (step.completedAt && step.completedAt > at ? step.completedAt : at), "");
  return latest || plan.updatedAt || "";
}

/** A conclusion's first sentence: up to its first full stop, or its first line. */
function firstSentence(text: string): string {
  const line = text.trim().split("\n")[0]!.trim();
  return /^.*?(?:[.!?](?=\s|$)|[。！？])/.exec(line)?.[0] ?? line;
}

function ArchivedToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex items-center gap-1 px-1 text-2xs text-chrome hover:text-foreground pointer-coarse:min-h-11">
      <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
      Archived
    </button>
  );
}
