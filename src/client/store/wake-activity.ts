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
  | { workerId: string; wakeId: string; active: true; startedAt: string }
  | { workerId: string; wakeId: string; active: false };

function applyWakeChange(active: Map<string, ActiveWorkerWake>, change: WakeChange): void {
  if (change.active) active.set(change.workerId, { wakeId: change.wakeId, startedAt: change.startedAt });
  // A finish from an old thread must not clear the new thread's wake.
  else if (active.get(change.workerId)?.wakeId === change.wakeId) active.delete(change.workerId);
}

function activityFromSnapshot(wakes: ActiveWakeDto[], changes: WakeChange[] = []): Map<string, ActiveWorkerWake> {
  // Different threads can have running wakes for the same worker. Reconcile
  // each wake before reducing to workers, so starting and finishing one wake
  // cannot erase another wake that is still running in the snapshot.
  const workersByWakeId = new Map<string, { workerId: string; startedAt: string }>();
  for (const wake of wakes) {
    if (wake.scope === "worker" && wake.scopeId) workersByWakeId.set(wake.wakeId, { workerId: wake.scopeId, startedAt: wake.startedAt });
  }
  for (const change of changes) {
    if (change.active) workersByWakeId.set(change.wakeId, { workerId: change.workerId, startedAt: change.startedAt });
    else if (workersByWakeId.get(change.wakeId)?.workerId === change.workerId) workersByWakeId.delete(change.wakeId);
  }
  const active = new Map<string, ActiveWorkerWake>();
  for (const [wakeId, { workerId, startedAt }] of workersByWakeId) {
    active.set(workerId, { wakeId, startedAt });
  }
  return active;
}

interface WakeActivityState {
  /** workerId → the worker's currently running wake.
   *  Presence alone means "this worker's agent is thinking/working" —
   *  cards only read `.has(workerId)`. */
  activeByWorkerId: Map<string, ActiveWorkerWake>;

  wakeStarted: (evt: WakeStartEvent) => void;
  wakeFinished: (evt: WakeScopeEvent) => void;
  /** Fetch the running-wake list, then replay SSE changes received during the
   *  request. Only the latest refresh may apply. It REPLACES the whole map
   *  (worker-scope entries only): a wakeFinished event missed during an SSE
   *  dead window must not leave a card breathing forever. Called at boot and
   *  reconnect; the caller handles failures and the next reconnect retries. */
  refetch: () => Promise<void>;
}

export const useWakeActivityStore = create<WakeActivityState>((set) => {
  let pendingRefresh: { changes: WakeChange[] } | undefined;

  const update = (change: WakeChange) => {
    // Record finishes even when the wake is not currently known: the pending
    // snapshot may still contain it. Keep events only during this refresh.
    pendingRefresh?.changes.push(change);
    set((s) => {
      const held = s.activeByWorkerId.get(change.workerId)?.wakeId;
      if (change.active ? held === change.wakeId : held !== change.wakeId) return s;
      const activeByWorkerId = new Map(s.activeByWorkerId);
      applyWakeChange(activeByWorkerId, change);
      return { activeByWorkerId };
    });
  };

  return {
    activeByWorkerId: new Map(),

    wakeStarted: (evt) => {
      if (evt.scope === "worker" && evt.scopeId) update({ workerId: evt.scopeId, wakeId: evt.wakeId, active: true, startedAt: evt.startedAt });
    },
    wakeFinished: (evt) => {
      if (evt.scope === "worker" && evt.scopeId) update({ workerId: evt.scopeId, wakeId: evt.wakeId, active: false });
    },

    refetch: async () => {
      const refresh = { changes: [] as WakeChange[] };
      pendingRefresh = refresh;
      try {
        const res = await fetch(api.agentActiveWakes);
        if (!res.ok) return;
        const body = (await res.json()) as ActiveWakesResponse;
        if (pendingRefresh !== refresh) return;
        const activeByWorkerId = activityFromSnapshot(Array.isArray(body.wakes) ? body.wakes : [], refresh.changes);
        set({ activeByWorkerId });
      } finally {
        if (pendingRefresh === refresh) pendingRefresh = undefined;
      }
    }
  };
});

/** True while the worker's agent has a wake in flight (thinking or running
 *  server-side tools). Narrow selector — re-renders only when this worker's
 *  presence in the map flips. */
export function useWorkerWakeActive(workerId: string): boolean {
  return useWakeActivityStore((s) => s.activeByWorkerId.has(workerId));
}
