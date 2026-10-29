import { create } from "zustand";
import type { ActiveWakeDto, ActiveWakesResponse, SseEventPayloadMap } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";

type WakeScopeEvent = Pick<
  SseEventPayloadMap["agentWakeStarted"],
  "threadId" | "wakeId" | "scope" | "scopeId"
>;
type WakeStartEvent = WakeScopeEvent & Pick<SseEventPayloadMap["agentWakeStarted"], "startedAt">;

/** A worker's running wake, and when it began: the clock on its row of its
 *  manager's strip. */
export interface ActiveWorkerWake {
  wakeId: string;
  startedAt: string;
}

type WakeChange =
  | { featureId: string; wakeId: string; active: true; startedAt: string }
  | { featureId: string; wakeId: string; active: false };

function applyWakeChange(active: Map<string, ActiveWorkerWake>, change: WakeChange): void {
  if (change.active) active.set(change.featureId, { wakeId: change.wakeId, startedAt: change.startedAt });
  // A finish from an old thread must not clear the new thread's wake.
  else if (active.get(change.featureId)?.wakeId === change.wakeId) active.delete(change.featureId);
}

function activityFromSnapshot(wakes: ActiveWakeDto[], changes: WakeChange[] = []): Map<string, ActiveWorkerWake> {
  // Different threads can have running wakes for the same feature. Reconcile
  // each wake before reducing to features, so starting and finishing one wake
  // cannot erase another wake that is still running in the snapshot.
  const featuresByWakeId = new Map<string, { featureId: string; startedAt: string }>();
  for (const wake of wakes) {
    if (wake.scope === "worker" && wake.scopeId) featuresByWakeId.set(wake.wakeId, { featureId: wake.scopeId, startedAt: wake.startedAt });
  }
  for (const change of changes) {
    if (change.active) featuresByWakeId.set(change.wakeId, { featureId: change.featureId, startedAt: change.startedAt });
    else if (featuresByWakeId.get(change.wakeId)?.featureId === change.featureId) featuresByWakeId.delete(change.wakeId);
  }
  const active = new Map<string, ActiveWorkerWake>();
  for (const [wakeId, { featureId, startedAt }] of featuresByWakeId) {
    active.set(featureId, { wakeId, startedAt });
  }
  return active;
}

interface WakeActivityState {
  /** featureId → the worker's currently running wake.
   *  Presence alone means "this feature's agent is thinking/working" —
   *  cards only read `.has(featureId)`. */
  activeByFeatureId: Map<string, ActiveWorkerWake>;

  /** REPLACE the whole map from the authoritative GET /api/agents/active-wakes
   *  payload (feature-scope entries only). Replace-not-merge is load-bearing:
   *  a wakeFinished event missed during an SSE dead window must not leave a
   *  card breathing forever. */
  applySnapshot: (wakes: ActiveWakeDto[]) => void;
  wakeStarted: (evt: WakeStartEvent) => void;
  wakeFinished: (evt: WakeScopeEvent) => void;
  /** Fetch the running-wake list, then replay SSE changes received during the
   *  request. Only the latest refresh may apply. Called at boot and reconnect;
   *  the caller handles failures and the next reconnect retries. */
  refetch: () => Promise<void>;
}

export const useWakeActivityStore = create<WakeActivityState>((set) => {
  let pendingRefresh: { changes: WakeChange[] } | undefined;

  const update = (change: WakeChange) => {
    // Record finishes even when the wake is not currently known: the pending
    // snapshot may still contain it. Keep events only during this refresh.
    pendingRefresh?.changes.push(change);
    set((s) => {
      const held = s.activeByFeatureId.get(change.featureId)?.wakeId;
      if (change.active ? held === change.wakeId : held !== change.wakeId) return s;
      const activeByFeatureId = new Map(s.activeByFeatureId);
      applyWakeChange(activeByFeatureId, change);
      return { activeByFeatureId };
    });
  };

  return {
    activeByFeatureId: new Map(),

    applySnapshot: (wakes) => {
      pendingRefresh = undefined;
      set({ activeByFeatureId: activityFromSnapshot(wakes) });
    },

    wakeStarted: (evt) => {
      if (evt.scope === "worker" && evt.scopeId) update({ featureId: evt.scopeId, wakeId: evt.wakeId, active: true, startedAt: evt.startedAt });
    },
    wakeFinished: (evt) => {
      if (evt.scope === "worker" && evt.scopeId) update({ featureId: evt.scopeId, wakeId: evt.wakeId, active: false });
    },

    refetch: async () => {
      const refresh = { changes: [] as WakeChange[] };
      pendingRefresh = refresh;
      try {
        const res = await fetch(api.agentActiveWakes);
        if (!res.ok) return;
        const body = (await res.json()) as ActiveWakesResponse;
        if (pendingRefresh !== refresh) return;
        const activeByFeatureId = activityFromSnapshot(Array.isArray(body.wakes) ? body.wakes : [], refresh.changes);
        set({ activeByFeatureId });
      } finally {
        if (pendingRefresh === refresh) pendingRefresh = undefined;
      }
    }
  };
});

/** True while the feature's agent has a wake in flight (thinking or running
 *  server-side tools). Narrow selector — re-renders only when this feature's
 *  presence in the map flips. */
export function useFeatureWakeActive(featureId: string): boolean {
  return useWakeActivityStore((s) => s.activeByFeatureId.has(featureId));
}
