import { useMemo } from "react";
import { useNavigate } from "react-router";
import type { Project } from "@/store/projects";
import { ProjectWorkerCard } from "@/routes/projects/ProjectWorkerCard";
import { useWorkItemsStore } from "@/store/work-items";
import { useWorkerPlansStore } from "@/store/worker-plans";
import { useWakeActivityStore } from "@/store/wake-activity";
import { isAsking } from "@shared/worker-state";
import { workerInThreadHref } from "@/lib/worker-href";
import { useProjectsStore } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";
import { categorizeWorkers } from "./worker-card-data";

/** A project's workers as cards in one container: pinned first, then what
 *  asks for attention, then what works, then the untracked. Nothing when it
 *  has none. */
export function ProjectWorkers({ project }: { project: Project }) {
  const items = useWorkItemsStore((s) => s.items);
  const plans = useWorkerPlansStore((s) => s.plans);
  const activeByWorkerId = useWakeActivityStore((s) => s.activeByWorkerId);
  const acknowledge = useWorkItemsStore((s) => s.acknowledge);
  const togglePin = useProjectsStore((s) => s.togglePin);
  const navigate = useNavigate();
  /** A row's Open: the thread that owns the worker, with its tab open. An
   *  active worker always has one; without it there is nowhere to open. */
  const openWorker = (worker: Project["workers"][number]) => {
    navigate(worker.ownerThreadId ? workerInThreadHref(worker.ownerThreadId, worker.id) : "/projects");
  };

  const buckets = useMemo(() => {
    const map = new Map<string, WorkItemDto>();
    for (const item of items.values()) map.set(item.workerId, item);
    const asking = new Set(project.workers
      .filter((w) => isAsking(plans.get(w.id)) && !activeByWorkerId.has(w.id))
      .map((w) => w.id));
    return categorizeWorkers(project.workers, map, asking);
  }, [project.workers, items, plans, activeByWorkerId]);

  if (project.workers.length === 0) return null;
  const ordered = [
    ...buckets.pinned.map(({ worker, item }) => ({ worker, item, variant: item ? ("top" as const) : ("untracked" as const) })),
    ...buckets.attention.map(({ worker, item }) => ({ worker, item, variant: "top" as const })),
    ...buckets.working.map(({ worker, item }) => ({ worker, item, variant: "passive" as const })),
    ...buckets.untracked.map(({ worker }) => ({ worker, item: null, variant: "untracked" as const }))
  ];

  return (
    <ul data-slot="worker-list" className="overflow-hidden rounded-lg border border-border-soft bg-panel">
      {/* Flagged workers stay inside their project, most urgent first by
          categorizeWorkers; the sidebar Home badge carries the cross-project count. */}
      {ordered.map(({ worker, item, variant }) => (
        <li key={worker.id} className="border-t border-border-soft first:border-t-0">
          {variant === "untracked" || !item ? (
            <ProjectWorkerCard variant="untracked" projectSlug={project.tmuxSessionName} worker={worker} item={null} />
          ) : (
            <ProjectWorkerCard
              variant={variant}
              projectSlug={project.tmuxSessionName} worker={worker} item={item}
              onTogglePin={() => togglePin(worker.id)}
              onAck={variant === "top" ? () => void acknowledge(item.id) : undefined}
              onPromote={() => openWorker(worker)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
