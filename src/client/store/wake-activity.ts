import { create } from "zustand";
import type { ActiveWakeDto, ActiveWakesResponse, SseEventPayloadMap } from "@shared/api-contracts";
import { api } from "@/lib/api-paths";

type WakeScopeEvent = Pick<
  SseEventPayloadMap["agentWakeStarted"],
  "threadId" | "wakeId" | "scope" | "scopeId"
>;

interface WakeChange {
  featureId: string;
  wakeId: string;
  active: boolean;
}

function applyWakeChange(active: Map<string, string>, change: WakeChange): void {
  if (change.active) active.set(change.featureId, change.wakeId);
  // A finish from an old thread must not clear the new thread's wake.
  else if (active.get(change.featureId) === change.wakeId) active.delete(change.featureId);
}

function activityFromSnapshot(wakes: ActiveWakeDto[], changes: WakeChange[] = []): Map<string, string> {
  // Different threads can have running wakes for the same feature. Reconcile
  // each wake before reducing to features, so starting and finishing one wake
  // cannot erase another wake that is still running in the snapshot.
  const featuresByWakeId = new Map<string, string>();
  for (const wake of wakes) {
    if (wake.scope === "worker" && wake.scopeId) featuresByWakeId.set(wake.wakeId, wake.scopeId);
  }
  for (const change of changes) {
    if (change.active) featuresByWakeId.set(change.wakeId, change.featureId);
    else if (featuresByWakeId.get(change.wakeId) === change.featureId) featuresByWakeId.delete(change.wakeId);
  }
  const active = new Map<string, string>();
  for (const [wakeId, featureId] of featuresByWakeId) {
    active.set(featureId, wakeId);
  }
  return active;
}

interface WakeActivityState {
  /** featureId → wakeId of the worker's currently running wake.
   *  Presence alone means "this feature's agent is thinking/working" —
   *  cards only read `.has(featureId)`. */
  activeByFeatureId: Map<string, string>;

  /** REPLACE the whole map from the authoritative GET /api/agents/active-wakes
   *  payload (feature-scope entries only). Replace-not-merge is load-bearing:
   *  a wakeFinished event missed during an SSE dead window must not leave a
   *  card breathing forever. */
  applySnapshot: (wakes: ActiveWakeDto[]) => void;
  wakeStarted: (evt: WakeScopeEvent) => void;
  wakeFinished: (evt: WakeScopeEvent) => void;
  /** Fetch the running-wake list, then replay SSE changes received during the
   *  request. Only the latest refresh may apply. Called at boot and reconnect;
   *  the caller handles failures and the next reconnect retries. */
  refetch: () => Promise<void>;
}

export const useWakeActivityStore = create<WakeActivityState>((set) => {
  let pendingRefresh: { changes: WakeChange[] } | undefined;

  const update = (evt: WakeScopeEvent, active: boolean) => {
    if (evt.scope !== "worker" || !evt.scopeId) return;
    const change = { featureId: evt.scopeId, wakeId: evt.wakeId, active };
    // Record finishes even when the wake is not currently known: the pending
    // snapshot may still contain it. Keep events only during this refresh.
    pendingRefresh?.changes.push(change);
    set((s) => {
      const held = s.activeByFeatureId.get(change.featureId);
      if (active ? held === change.wakeId : held !== change.wakeId) return s;
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

    wakeStarted: (evt) => update(evt, true),
    wakeFinished: (evt) => update(evt, false),

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
