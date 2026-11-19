import { useMemo } from "react";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useWorkerPlansStore } from "@/store/worker-plans";
import { useWakeActivityStore } from "@/store/wake-activity";
import { useMonitorActivityStore, type MonitorWait } from "@/store/monitor-activity";
import { workerStateFor, hasStepInProgress, isAsking, waitingOnYou, type WorkerState } from "@shared/worker-state";

export interface ThreadWorker {
  workerId: string;
  name: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  workerSlug: string;
  ownerThreadId: string | null;
  state: WorkerState;
  /** What it waits on the user for. A question is its manager's first, and is `asking`. */
  waiting: "failed" | "stopped" | null;
  /** Its plan holds a question. */
  asking: boolean;
  running: boolean;
  /** What it waits on when it sleeps on a monitor: the thread's watching. */
  watching: MonitorWait | null;
  /** A step of its plan is in progress: it says it is still at work. */
  stepInProgress: boolean;
}

/** Every active worker, in the user's project order, with its one state. */
export function useAllWorkers(): ThreadWorker[] {
  const projects = useProjectsStore((s) => s.projects);
  const items = useWorkItemsStore((s) => s.items);
  const plans = useWorkerPlansStore((s) => s.plans);
  const activeByWorkerId = useWakeActivityStore((s) => s.activeByWorkerId);
  const waitingByThread = useMonitorActivityStore((s) => s.waitingByThread);
  return useMemo(() => {
    const byWorker = new Map([...items.values()].map((it) => [it.workerId, it]));
    // A worker has one live thread, so one entry says what it waits on.
    const watchingByWorker = new Map<string, MonitorWait>();
    for (const waiting of waitingByThread.values()) {
      if (waiting.scope === "worker" && waiting.scopeId && waiting.waitsOn) watchingByWorker.set(waiting.scopeId, waiting.waitsOn);
    }
    return projects.flatMap((p) => p.workers.map((worker) => {
      const item = byWorker.get(worker.id);
      const plan = plans.get(worker.id);
      const running = activeByWorkerId.has(worker.id);
      return {
        workerId: worker.id,
        name: worker.name,
        projectId: p.id,
        projectName: p.name,
        projectSlug: p.tmuxSessionName,
        workerSlug: worker.tmuxWindowName,
        ownerThreadId: worker.ownerThreadId ?? null,
        state: workerStateFor(plan, item?.failedAt ?? null, item?.failedKind ?? null, running),
        waiting: waitingOnYou(item?.failedAt ?? null, item?.failedKind ?? null),
        asking: isAsking(plan),
        running,
        watching: watchingByWorker.get(worker.id) ?? null,
        stepInProgress: hasStepInProgress(plan)
      };
    }));
  }, [projects, items, plans, activeByWorkerId, waitingByThread]);
}

export function useThreadWorkers(threadId: string): ThreadWorker[] {
  const all = useAllWorkers();
  return useMemo(() => all.filter((w) => w.ownerThreadId === threadId), [all, threadId]);
}
