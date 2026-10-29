import { useMemo } from "react";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useWakeActivityStore } from "@/store/wake-activity";
import { useMonitorActivityStore, type MonitorWait } from "@/store/monitor-activity";
import { featureStateFor, hasStepInProgress, isAsking, waitingOnYou, type FeatureState } from "@shared/feature-state";

export interface ThreadWorker {
  featureId: string;
  name: string;
  projectId: string;
  projectName: string;
  projectSlug: string;
  featureSlug: string;
  ownerThreadId: string | null;
  state: FeatureState;
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

/** What a switched-off hook reads: the same empty values every time, so no
 *  store change redraws its caller. */
const NO_PROJECTS: readonly never[] = [];
const NO_ENTRIES: ReadonlyMap<string, never> = new Map<string, never>();

/** Every active worker, in the user's project order, with its one state.
 *  Switched off (`enabled` false), none, and no store change redraws it. */
export function useAllWorkers(enabled = true): ThreadWorker[] {
  const projects = useProjectsStore((s) => (enabled ? s.projects : NO_PROJECTS));
  const items = useWorkItemsStore((s) => (enabled ? s.items : NO_ENTRIES));
  const plans = useFeaturePlansStore((s) => (enabled ? s.plans : NO_ENTRIES));
  const activeByFeatureId = useWakeActivityStore((s) => (enabled ? s.activeByFeatureId : NO_ENTRIES));
  const waitingByThread = useMonitorActivityStore((s) => (enabled ? s.waitingByThread : NO_ENTRIES));
  return useMemo(() => {
    const byFeature = new Map([...items.values()].map((it) => [it.featureId, it]));
    // A worker has one live thread, so one entry says what it waits on.
    const watchingByFeature = new Map<string, MonitorWait>();
    for (const waiting of waitingByThread.values()) {
      if (waiting.scope === "worker" && waiting.scopeId && waiting.waitsOn) watchingByFeature.set(waiting.scopeId, waiting.waitsOn);
    }
    return projects.flatMap((p) => p.features.map((f) => {
      const item = byFeature.get(f.id);
      const plan = plans.get(f.id);
      const running = activeByFeatureId.has(f.id);
      return {
        featureId: f.id,
        name: f.name,
        projectId: p.id,
        projectName: p.name,
        projectSlug: p.tmuxSessionName,
        featureSlug: f.tmuxWindowName,
        ownerThreadId: f.ownerThreadId ?? null,
        state: featureStateFor(plan, item?.failedAt ?? null, item?.failedKind ?? null, running),
        waiting: waitingOnYou(item?.failedAt ?? null, item?.failedKind ?? null),
        asking: isAsking(plan),
        running,
        watching: watchingByFeature.get(f.id) ?? null,
        stepInProgress: hasStepInProgress(plan)
      };
    }));
  }, [projects, items, plans, activeByFeatureId, waitingByThread]);
}

export function useThreadWorkers(threadId: string): ThreadWorker[] {
  const all = useAllWorkers();
  return useMemo(() => all.filter((w) => w.ownerThreadId === threadId), [all, threadId]);
}
