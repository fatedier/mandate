import type { Feature } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";

interface CategorizedBucket<T extends WorkItemDto | null> {
  feature: Feature;
  item: T;
}

interface CategorizedFeatures {
  /** pinned regardless of state; sorted by pinned_at desc (newest first) */
  pinned: CategorizedBucket<WorkItemDto | null>[];
  /** not pinned, state in {for_review, blocked}; sorted blocked-first, then lastActivity desc */
  attention: CategorizedBucket<WorkItemDto>[];
  /** not pinned and not asking for attention; sorted createdAt asc (stable) */
  working: CategorizedBucket<WorkItemDto>[];
  /** no work_item; sorted createdAt asc (stable) */
  untracked: CategorizedBucket<null>[];
}

export function categorizeFeatures(
  features: Feature[],
  workItemsByFeatureId: Map<string, WorkItemDto>
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
    } else if (item.needsUser !== null) {
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
  const needsUserOrder: Record<string, number> = { input: 0, review: 1 };
  attention.sort((a, b) => {
    const u = (needsUserOrder[a.item.needsUser ?? ""] ?? 99) - (needsUserOrder[b.item.needsUser ?? ""] ?? 99);
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
        // dot: attention is the needsUser rail's job, and unknown means the
        // analyzer hasn't classified yet.
        if (s === "working" || s === "running_service") return "running";
        if (s === "idle_shell" || s === "done") return "idle";
        return null;
      }
    }
  }
  return null;
}
