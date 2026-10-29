import { useCallback, useMemo, useState } from "react";
import type { AgentPendingMonitorDto, BackgroundTaskDto } from "@shared/api-contracts";
import { useThreadWorkers, type ThreadWorker } from "@/hooks/useThreadWorkers";
import { taskStrip, workerStrip, type WorkerStripRow } from "@/routes/window/chat/worker-strip";
import { useBackgroundTasks } from "@/store/background-tasks";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useMonitorActivityStore } from "@/store/monitor-activity";
import { useWakeActivityStore } from "@/store/wake-activity";

const NONE: WorkerStripRow[] = [];
const NO_TASKS: BackgroundTaskDto[] = [];

/** What the strip above a conversation's composer lists. */
export interface StripContent {
  /** A manager thread's workers at work (workerStrip); none elsewhere. */
  workers: WorkerStripRow[];
  /** The conversation's background tasks at work (taskStrip). */
  tasks: BackgroundTaskDto[];
  /** The task whose steps are open on its own row: it keeps that row, the
   *  strip folding nothing under it, until they close. */
  pinned: string | null;
  /** A task row's steps opened or closed: the strip keeps that task while
   *  they are open, ended or not. */
  holdTask: (taskId: string, open: boolean) => void;
  /** The folded row's list opened (with the tasks it listed) or closed: the
   *  strip keeps those tasks while it is open, ended or not, so the row and
   *  its list stay. */
  holdList: (taskIds: readonly string[], open: boolean) => void;
}

const NO_WORKERS: ThreadWorker[] = [];

/** Of these workers, those at work as the strip lists them (workerStrip):
 *  running a turn, or asleep on a monitor, with since when. The strip and the
 *  Workers tab's cards read the same rows. */
export function useWorkerStripRows(workers: readonly ThreadWorker[]): WorkerStripRow[] {
  const plans = useFeaturePlansStore((s) => s.plans);
  const active = useWakeActivityStore((s) => s.activeByFeatureId);
  const waitingByThread = useMonitorActivityStore((s) => s.waitingByThread);
  return useMemo(() => {
    if (workers.length === 0) return NONE;
    // A worker has one live thread, so one entry says what it waits on.
    const waitsByFeature = new Map<string, readonly AgentPendingMonitorDto[]>();
    for (const waiting of waitingByThread.values()) {
      if (waiting.scope === "worker" && waiting.scopeId) waitsByFeature.set(waiting.scopeId, waiting.monitors);
    }
    const listed = workerStrip(workers, {
      runningSince: (featureId) => active.get(featureId)?.startedAt ?? null,
      stepOf: (featureId) => plans.get(featureId)?.steps.find((step) => step.status === "in_progress")?.title ?? null,
      waitsOf: (featureId) => waitsByFeature.get(featureId) ?? []
    });
    return listed.length === 0 ? NONE : listed;
  }, [workers, plans, active, waitingByThread]);
}

/** What is open on the strip, for the conversation it was opened in. */
type Opened =
  | { thread: string; kind: "task"; id: string }
  | { thread: string; kind: "list"; ids: readonly string[] };

/** The strip above a conversation's composer: a manager thread's workers at
 *  work (`workersOf`), and any conversation's background tasks (`tasksOf`: a
 *  manager thread, a worker's, Your agent's). Null: none of that kind. */
export function useWorkerStrip({ workersOf, tasksOf }: { workersOf: string | null; tasksOf: string | null }): StripContent {
  const threadWorkers = useThreadWorkers(workersOf ?? "");
  const rows = useWorkerStripRows(workersOf === null ? NO_WORKERS : threadWorkers);
  const all = useBackgroundTasks(tasksOf);
  // Another conversation's opening never stands here.
  const [opened, setOpened] = useState<Opened | null>(null);
  const current = opened !== null && opened.thread === tasksOf ? opened : null;
  const tasks = useMemo(() => {
    if (tasksOf === null) return NO_TASKS;
    const shown = taskStrip(all, current === null ? null : current.kind === "task" ? current.id : current.ids);
    return shown.length === 0 ? NO_TASKS : shown;
  }, [tasksOf, all, current]);
  const holdTask = useCallback((taskId: string, open: boolean) => {
    if (tasksOf === null) return;
    setOpened((was) => (open ? { thread: tasksOf, kind: "task", id: taskId } : was?.kind === "task" && was.id === taskId ? null : was));
  }, [tasksOf]);
  const holdList = useCallback((taskIds: readonly string[], open: boolean) => {
    if (tasksOf === null) return;
    setOpened((was) => (open ? { thread: tasksOf, kind: "list", ids: taskIds } : was?.kind === "list" ? null : was));
  }, [tasksOf]);
  const pinned = current?.kind === "task" ? current.id : null;
  return { workers: rows, tasks, pinned, holdTask, holdList };
}
