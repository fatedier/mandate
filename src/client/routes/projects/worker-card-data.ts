import type { ProjectWorker } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";

interface CategorizedBucket<T extends WorkItemDto | null> {
  worker: ProjectWorker;
  item: T;
}

interface CategorizedWorkers {
  /** pinned regardless of state; sorted by pinned_at desc (newest first) */
  pinned: CategorizedBucket<WorkItemDto | null>[];
  /** not pinned, and its last wake failed or stopped, or it waits for an
   *  answer; what went wrong first, then by lastActivity desc */
  attention: CategorizedBucket<WorkItemDto>[];
  /** not pinned and not asking for attention; sorted createdAt asc (stable) */
  working: CategorizedBucket<WorkItemDto>[];
  /** no work_item; sorted createdAt asc (stable) */
  untracked: CategorizedBucket<null>[];
}

export function categorizeWorkers(
  workers: ProjectWorker[],
  workItemsByWorkerId: Map<string, WorkItemDto>,
  /** The workers that wait for an answer: a question in the plan, at rest. */
  asking: ReadonlySet<string> = new Set()
): CategorizedWorkers {
  const pinned: CategorizedBucket<WorkItemDto | null>[] = [];
  const attention: CategorizedBucket<WorkItemDto>[] = [];
  const working: CategorizedBucket<WorkItemDto>[] = [];
  const untracked: CategorizedBucket<null>[] = [];

  for (const worker of workers) {
    const item = workItemsByWorkerId.get(worker.id) ?? null;
    if (worker.pinnedAt) {
      pinned.push({ worker, item });
    } else if (!item) {
      untracked.push({ worker, item: null });
    } else if (item.failedAt !== null || asking.has(worker.id)) {
      attention.push({ worker, item });
    } else {
      working.push({ worker, item });
    }
  }

  pinned.sort((a, b) => {
    const ap = a.worker.pinnedAt ?? "";
    const bp = b.worker.pinnedAt ?? "";
    return ap < bp ? 1 : -1;
  });
  // What went wrong before a worker that waits for an answer, as Home orders them.
  const rank = (bucket: CategorizedBucket<WorkItemDto>) => (bucket.item.failedAt !== null ? 0 : 1);
  attention.sort((a, b) => {
    const u = rank(a) - rank(b);
    if (u !== 0) return u;
    return a.item.lastActivityAt < b.item.lastActivityAt ? 1 : -1;
  });
  working.sort((a, b) => (a.worker.createdAt < b.worker.createdAt ? -1 : 1));
  untracked.sort((a, b) => (a.worker.createdAt < b.worker.createdAt ? -1 : 1));

  return { pinned, attention, working, untracked };
}

/** A worker's pane state for its dot, from its window's status. */
export type PaneDisplayStatus = "running" | "idle" | null;

interface SnapshotShape {
  sessions?: Array<{
    sessionName?: string;
    windows?: Array<{
      windowName?: string;
      aggregate?: { status?: string };
    }>;
  }>;
}

export function paneStatusForWorker(
  sessionName: string,
  windowName: string,
  snapshot: SnapshotShape | null
): PaneDisplayStatus {
  if (!snapshot?.sessions) return null;
  for (const session of snapshot.sessions) {
    if (session.sessionName !== sessionName) continue;
    for (const w of session.windows ?? []) {
      if (w.windowName === windowName) {
        const s = w.aggregate?.status;
        // The window aggregate carries the analyzer status enum
        // (working | waiting_user | running_service | done | idle_shell |
        // unknown), not a pane-level running/idle pair — map it to
        // the display statuses. waiting_user/unknown intentionally show no
        // dot: attention is the failure's and the question's job, and
        // unknown means the analyzer hasn't classified yet.
        if (s === "working" || s === "running_service") return "running";
        if (s === "idle_shell" || s === "done") return "idle";
        return null;
      }
    }
  }
  return null;
}
