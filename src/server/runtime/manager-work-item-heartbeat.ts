import type { AgentWakeReason } from "../modules/agent/agent-store.js";

export const DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS = 30 * 60 * 1000;

interface TimerHandle {
  unref?: () => void;
}

export interface ManagerWorkItemHeartbeatTimers<
  Timer extends TimerHandle = ReturnType<typeof setTimeout>
> {
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
}

interface OverviewWorkItemHeartbeatWakeScheduler {
  wake(threadId: string, reason: AgentWakeReason, triggerMessageId: string | null): string | null;
  isThreadBusy(threadId: string): boolean;
  getRunningWakeForThread(threadId: string): { id: string } | null;
}

export interface ManagerWorkItemHeartbeatDeps<
  Timer extends TimerHandle = ReturnType<typeof setTimeout>
> {
  agentStore: {
    getOrCreateThread(scope: "manager", scopeId: null): { id: string };
  };
  wakeScheduler: OverviewWorkItemHeartbeatWakeScheduler;
  delayMs?: number;
  timers?: ManagerWorkItemHeartbeatTimers<Timer>;
}

/**
 * The sweep the overview agent runs on this timer, and the flag it sets to stop
 * being woken by it.
 *
 * Ending is the deliberate act and continuing is the default, chosen for the
 * failure mode: forgetting to end costs one wake, forgetting to continue loses
 * a stalled feature with nothing left to notice. The inverse — the agent must
 * schedule each next sweep — is how the change brief rotted.
 */

const HEARTBEAT_REASON: AgentWakeReason = "work-item-heartbeat";

export class ManagerWorkItemHeartbeat<Timer extends TimerHandle = ReturnType<typeof setTimeout>> {
  private readonly delayMs: number;
  private readonly timers: ManagerWorkItemHeartbeatTimers<Timer>;
  private timer: Timer | null = null;
  private dueWhileBusy = false;
  private disposed = false;
  /** Set by `end_sweep`. While true nothing arms the timer. In memory like the
   *  timer itself: a restart resumes sweeping, which is right — nothing carried
   *  the agent's conclusion across the restart either. */
  private ended = false;
  /** True between issuing a sweep wake and that wake releasing. */
  private sweepInFlight = false;
  /**
   * A wake started while a sweep timer was still counting down.
   *
   * Kept apart from `dueWhileBusy`, which means the timer actually elapsed and
   * found the thread busy — that one is due and fires the moment the thread
   * frees up. This one was never due, so firing it on release turns every
   * overview wake into a sweep: measured on a real store, 17 of 17 sweeps
   * started 0.0s after the previous wake ended, against a 1800s interval.
   */
  private rearmAfterRelease = false;

  constructor(private readonly deps: ManagerWorkItemHeartbeatDeps<Timer>) {
    this.delayMs = Math.max(0, deps.delayMs ?? DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS);
    this.timers = deps.timers ?? defaultTimers<Timer>();
  }

  notifyWorkItemChanged(): void {
    if (this.disposed) return;
    // New work reopens the question the agent closed. Clearing `ended` here is
    // the only way the sweep comes back to life, and it needs no one to
    // remember to restart it.
    this.ended = false;
    this.arm();
  }

  /**
   * The agent has looked and found nothing outstanding. Stop waking it until
   * `notifyWorkItemChanged` says otherwise.
   */
  endSweep(): void {
    this.ended = true;
    this.clearTimer();
    this.dueWhileBusy = false;
    this.rearmAfterRelease = false;
    // `sweepInFlight` is deliberately untouched: it means "a sweep wake is out
    // there", which is still true, and the release path must stay free to ask
    // `arm()` for another one. `ended` is the single authority on the answer —
    // clearing the flag here too would make that check unreachable.
  }

  /** For the tool's return value, so the agent is told what it just did. */
  isEnded(): boolean {
    return this.ended;
  }

  noteManagerWakeStarted(isSweep = false): void {
    // A recovered sweep was started by the durable mailbox, not requestWake().
    // It must still re-arm the sweep timer after releasing the manager thread.
    if (isSweep) this.sweepInFlight = true;
    // Defer, do not drop, and do not promote. A pending sweep must survive the
    // overview waking for an unrelated reason — that wake does not carry the
    // sweep section, so it answers a different question and cannot stand in —
    // but it is not thereby due. It goes back on the clock.
    if (this.timer === null) return;
    this.clearTimer();
    this.rearmAfterRelease = true;
  }

  flushDueAfterOverviewRelease(): string | null {
    if (this.disposed) return null;
    const threadId = this.overviewThreadId();
    if (!this.isIdle(threadId)) return null;

    if (this.dueWhileBusy) {
      this.dueWhileBusy = false;
      this.rearmAfterRelease = false;
      return this.requestWake(threadId);
    }

    // Either the sweep we asked for has just released — default to another one,
    // since only `end_sweep` stops the loop — or an unrelated wake interrupted
    // a timer that had not elapsed. Both want a fresh window, not a wake now.
    if (this.sweepInFlight || this.rearmAfterRelease) {
      this.sweepInFlight = false;
      this.rearmAfterRelease = false;
      this.arm();
    }
    return null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.dueWhileBusy = false;
    this.sweepInFlight = false;
    this.rearmAfterRelease = false;
  }

  private arm(): void {
    if (this.disposed || this.ended) return;
    const threadId = this.overviewThreadId();
    if (!this.isIdle(threadId)) return;
    if (this.timer || this.dueWhileBusy) return;
    this.timer = this.timers.setTimeout(() => this.fire(), this.delayMs);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = null;
    if (this.disposed) return;
    const threadId = this.overviewThreadId();
    if (!this.isIdle(threadId)) {
      this.dueWhileBusy = true;
      return;
    }
    this.requestWake(threadId);
  }

  private requestWake(threadId: string): string | null {
    const wakeId = this.deps.wakeScheduler.wake(threadId, HEARTBEAT_REASON, null);
    if (!wakeId) this.dueWhileBusy = true;
    // Remembered so the release path can tell "the sweep I asked for just
    // finished" from "some other wake finished" without being handed a reason.
    else this.sweepInFlight = true;
    return wakeId;
  }

  private overviewThreadId(): string {
    return this.deps.agentStore.getOrCreateThread("manager", null).id;
  }

  private isIdle(threadId: string): boolean {
    return (
      !this.deps.wakeScheduler.isThreadBusy(threadId) &&
      !this.deps.wakeScheduler.getRunningWakeForThread(threadId)
    );
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

function defaultTimers<Timer extends TimerHandle>(): ManagerWorkItemHeartbeatTimers<Timer> {
  return {
    setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as Timer,
    clearTimeout: (timer) => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>)
  };
}
