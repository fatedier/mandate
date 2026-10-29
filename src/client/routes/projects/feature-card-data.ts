import type { Feature } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";

interface CategorizedBucket<T extends WorkItemDto | null> {
  feature: Feature;
  item: T;
}

interface CategorizedFeatures {
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

export function categorizeFeatures(
  features: Feature[],
  workItemsByFeatureId: Map<string, WorkItemDto>,
  /** The workers that wait for an answer: a question in the plan, at rest. */
  asking: ReadonlySet<string> = new Set()
): CategorizedFeatures {
  const pinned: CategorizedBucket<WorkItemDto | null>[] = [];
  const attention: CategorizedBucket<WorkItemDto>[] = [];
  const working: CategorizedBucket<WorkItemDto>[] = [];
  const untracked: CategorizedBucket<null>[] = [];

  for (const f of features) {
    const item = workItemsByFeatureId.get(f.id) ?? null;
    if (f.pinnedAt) {
      pinned.push({ feature: f, item });
    } else if (!item) {
      untracked.push({ feature: f, item: null });
    } else if (item.failedAt !== null || asking.has(f.id)) {
      attention.push({ feature: f, item });
    } else {
      working.push({ feature: f, item });
    }
  }

  pinned.sort((a, b) => {
    const ap = a.feature.pinnedAt ?? "";
    const bp = b.feature.pinnedAt ?? "";
    return ap < bp ? 1 : -1;
  });
  // What went wrong before a worker that waits for an answer, as Home orders them.
  const rank = (bucket: CategorizedBucket<WorkItemDto>) => (bucket.item.failedAt !== null ? 0 : 1);
  attention.sort((a, b) => {
    const u = rank(a) - rank(b);
    if (u !== 0) return u;
    return a.item.lastActivityAt < b.item.lastActivityAt ? 1 : -1;
  });
  working.sort((a, b) => (a.feature.createdAt < b.feature.createdAt ? -1 : 1));
  untracked.sort((a, b) => (a.feature.createdAt < b.feature.createdAt ? -1 : 1));

  return { pinned, attention, working, untracked };
}

/** Pane status derived from tmux aggregate (NOT analyzer LLM interpretation). */
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

export function paneStatusForFeature(
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
