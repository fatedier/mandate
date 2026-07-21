import { describe, expect, test } from "bun:test";
import { ManagerWorkItemHeartbeat } from "../src/server/runtime/manager-work-item-heartbeat.js";
import type { AgentWakeReason } from "../src/server/modules/agent/agent-store.js";

/**
 * The sweep loop: the timer keeps waking the manager agent until the agent
 * says to stop. Continuing is the default and ending is the deliberate act,
 * because forgetting to end costs one wake while forgetting to continue loses a
 * stalled feature with nothing left to notice it.
 */

interface FakeTimerHandle {
  ms: number;
  callback: () => void;
  cleared: boolean;
  /** A real timer is spent once it fires. Without this a fired handle still
   *  counts as pending and `live` reports a sweep that is not scheduled. */
  fired: boolean;
  unref(): void;
}

class FakeTimers {
  readonly handles: FakeTimerHandle[] = [];

  setTimeout(callback: () => void, ms: number): FakeTimerHandle {
    const handle = { ms, callback, cleared: false, fired: false, unref() {} };
    this.handles.push(handle);
    return handle;
  }

  clearTimeout(handle: FakeTimerHandle): void {
    handle.cleared = true;
  }

  fire(index: number): void {
    const handle = this.handles[index]!;
    if (handle.cleared || handle.fired) return;
    handle.fired = true;
    handle.callback();
  }

  /** Timers still able to fire — what "is a sweep scheduled?" means. */
  get live(): FakeTimerHandle[] {
    return this.handles.filter((h) => !h.cleared && !h.fired);
  }
}

function build(opts: { busy?: () => boolean } = {}) {
  const timers = new FakeTimers();
  const wakes: AgentWakeReason[] = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    agentStore: { getOrCreateThread: () => ({ id: "thr-manager" }) },
    wakeScheduler: {
      wake(_threadId, reason) {
        wakes.push(reason);
        return `wake-${wakes.length}`;
      },
      isThreadBusy: () => opts.busy?.() ?? false,
      getRunningWakeForThread: () => null
    },
    delayMs: 100,
    timers
  });
  return { timers, wakes, heartbeat };
}

/** One full cycle: arm, fire, and release the wake that fired. */
function runSweep(h: ReturnType<typeof build>, timerIndex: number): void {
  h.timers.fire(timerIndex);
  h.heartbeat.noteManagerWakeStarted();
  h.heartbeat.flushDueAfterOverviewRelease();
}

describe("the sweep continues by default", () => {
  test("re-arms after the sweep wake it asked for is released", () => {
    const h = build();
    h.heartbeat.notifyWorkItemChanged();
    expect(h.timers.live).toHaveLength(1);

    runSweep(h, 0);

    // The agent did not call end_sweep, so it gets woken again. Nothing else
    // re-arms: a stalled feature produces no work-item change by definition.
    expect(h.timers.live).toHaveLength(1);
    expect(h.wakes).toEqual(["work-item-heartbeat"]);

    runSweep(h, h.timers.handles.length - 1);
    expect(h.wakes).toEqual(["work-item-heartbeat", "work-item-heartbeat"]);
  });

  test("an unrelated manager wake puts the pending sweep back on the clock", () => {
    const h = build();
    h.heartbeat.notifyWorkItemChanged();

    // A user message wakes the manager before the timer fires. That wake does
    // not carry the sweep section, so it cannot stand in for the sweep — but
    // the sweep was not due either. Firing it here is what turned every
    // manager wake into a sweep on the real store: 17 of 17 started 0.0s after
    // the previous wake ended, against a 1800s interval.
    h.heartbeat.noteManagerWakeStarted();
    expect(h.timers.live).toHaveLength(0);

    h.heartbeat.flushDueAfterOverviewRelease();
    expect(h.wakes).toHaveLength(0);
    expect(h.timers.live).toHaveLength(1);
    expect(h.timers.live[0]!.ms).toBe(100);

    h.timers.fire(h.timers.handles.length - 1);
    expect(h.wakes).toEqual(["work-item-heartbeat"]);
  });

  test("a sweep that came due while the thread was busy still fires at once", () => {
    // The other half of the distinction. This timer elapsed — it did not get
    // interrupted — and found the thread occupied, so it is owed a wake the
    // moment the thread frees up, not another full window.
    let busy = false;
    const h = build({ busy: () => busy });
    h.heartbeat.notifyWorkItemChanged();
    expect(h.timers.live).toHaveLength(1);

    busy = true;
    h.timers.fire(0);
    expect(h.wakes).toHaveLength(0);

    busy = false;
    h.heartbeat.flushDueAfterOverviewRelease();
    expect(h.wakes).toEqual(["work-item-heartbeat"]);
  });

  test("a wake with no sweep pending neither fires nor arms one", () => {
    const h = build();
    h.heartbeat.noteManagerWakeStarted();
    h.heartbeat.flushDueAfterOverviewRelease();
    expect(h.wakes).toHaveLength(0);
    expect(h.timers.live).toHaveLength(0);
  });
});

describe("only end_sweep stops it", () => {
  test("no further sweep is armed once the agent ends it", () => {
    const h = build();
    h.heartbeat.notifyWorkItemChanged();
    h.timers.fire(0);
    h.heartbeat.noteManagerWakeStarted();

    h.heartbeat.endSweep();
    h.heartbeat.flushDueAfterOverviewRelease();

    expect(h.timers.live).toHaveLength(0);
    expect(h.wakes).toEqual(["work-item-heartbeat"]);
    expect(h.heartbeat.isEnded()).toBe(true);
  });

  test("ending also drops a sweep that was already due", () => {
    const h = build({ busy: () => true });
    // Fires while busy, so it is recorded as due rather than woken.
    h.heartbeat.notifyWorkItemChanged();
    expect(h.timers.live).toHaveLength(0);

    h.heartbeat.endSweep();
    h.heartbeat.flushDueAfterOverviewRelease();
    expect(h.wakes).toHaveLength(0);
  });

  test("new work reopens the question the agent closed", () => {
    const h = build();
    h.heartbeat.endSweep();
    expect(h.heartbeat.isEnded()).toBe(true);

    h.heartbeat.notifyWorkItemChanged();

    // This is the only path back. Nothing has to remember to restart the sweep:
    // starting work is what restarts it.
    expect(h.heartbeat.isEnded()).toBe(false);
    expect(h.timers.live).toHaveLength(1);
  });

  test("dispose stops the loop without marking it ended", () => {
    const h = build();
    h.heartbeat.notifyWorkItemChanged();
    h.heartbeat.dispose();
    expect(h.timers.live).toHaveLength(0);

    // Shutdown is not the agent's conclusion — a restart must sweep again.
    expect(h.heartbeat.isEnded()).toBe(false);
    h.heartbeat.notifyWorkItemChanged();
    expect(h.timers.live).toHaveLength(0);
  });
});
