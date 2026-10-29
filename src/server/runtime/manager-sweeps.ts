import type { FeaturesStore } from "../modules/features/features-store.js";
import type { WorkItemStore } from "../modules/agent/work-item-store.js";
import {
  ManagerWorkItemHeartbeat,
  type ManagerWorkItemHeartbeatDeps,
  type ManagerWorkItemHeartbeatTimers
} from "./manager-work-item-heartbeat.js";

/**
 * One stall sweep per manager thread. Each thread
 * sweeps only the workers it owns: its sweep wake lists its own stalled
 * workers, its `end_sweep` ends only its loop, a change to one of its workers
 * re-arms only it, and only its own wakes defer it. The design rules of the
 * single sweep hold per thread — see manager-work-item-heartbeat.ts.
 */
export class ManagerSweeps {
  private readonly byThread = new Map<string, ManagerWorkItemHeartbeat>();
  private disposed = false;

  constructor(private readonly deps: {
    featuresStore: Pick<FeaturesStore, "getById">;
    /** An open manager thread: only one can be swept. */
    isOpenThread: (threadId: string) => boolean;
    /** Where a due sweep looks for its manager's stuck workers first. */
    workStore: Pick<WorkItemStore, "listStalled">;
    wakeScheduler: ManagerWorkItemHeartbeatDeps["wakeScheduler"];
    delayMs?: number;
    timers?: ManagerWorkItemHeartbeatTimers;
  }) {}

  notifyWorkerChanged(featureId: string): void {
    if (this.disposed) return;
    const owner = this.deps.featuresStore.getById(featureId)?.ownerThreadId;
    // An owner already archived (a restore announces its change before the
    // new owner is set) would keep a sweep that can never wake it.
    if (!owner || !this.deps.isOpenThread(owner)) return;
    this.forThread(owner).notifyWorkItemChanged();
  }

  noteWakeStarted(threadId: string, isSweep: boolean): void {
    // A recovered sweep wake must still re-arm after it releases, so it
    // creates the thread's heartbeat if the process has not seen one yet.
    const hb = isSweep ? this.forThread(threadId) : this.byThread.get(threadId);
    hb?.noteManagerWakeStarted(isSweep);
  }

  flushAfterRelease(threadId: string): void {
    this.byThread.get(threadId)?.flushDueAfterOverviewRelease();
  }

  endSweep(threadId: string): void {
    this.forThread(threadId).endSweep();
  }

  isEnded(threadId: string): boolean {
    return this.byThread.get(threadId)?.isEnded() ?? false;
  }

  disposeThread(threadId: string): void {
    this.byThread.get(threadId)?.dispose();
    this.byThread.delete(threadId);
  }

  dispose(): void {
    this.disposed = true;
    for (const hb of this.byThread.values()) hb.dispose();
    this.byThread.clear();
  }

  private forThread(threadId: string): ManagerWorkItemHeartbeat {
    let hb = this.byThread.get(threadId);
    if (!hb) {
      hb = new ManagerWorkItemHeartbeat({
        threadId,
        // The same list the sweep wake shows, owned by this thread.
        hasStalled: () => this.deps.workStore.listStalled({ ownerThreadId: threadId, limit: 1 }).length > 0,
        wakeScheduler: this.deps.wakeScheduler,
        delayMs: this.deps.delayMs,
        timers: this.deps.timers
      });
      this.byThread.set(threadId, hb);
    }
    return hb;
  }
}
