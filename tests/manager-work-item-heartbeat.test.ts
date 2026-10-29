import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS,
  ManagerWorkItemHeartbeat,
  SWEEP_RETRY_MS
} from "../src/server/runtime/manager-work-item-heartbeat.js";
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

function build(opts: { busy?: () => boolean; stalled?: () => boolean } = {}) {
  const timers = new FakeTimers();
  const wakes: AgentWakeReason[] = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    threadId: "thr-manager",
    hasStalled: opts.stalled ?? (() => true),
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

test("the sweep comes 25 minutes after the manager's turn, inside a 30-minute prompt cache", () => {
  // Several providers keep a prompt cache for 30 minutes after its last read,
  // and the clock starts when the turn ends, a little after its last request:
  // a 30-minute sweep lands seconds past the cache and rewrites the prompt.
  expect(DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS).toBe(25 * 60 * 1000);
});

describe("the sweep continues by default", () => {
  test("re-arms after the sweep wake it asked for is released", () => {
    const h = build();
    h.heartbeat.notifyWorkItemChanged();
    expect(h.timers.live).toHaveLength(1);

    runSweep(h, 0);

    // The agent did not call end_sweep, so it gets woken again. Nothing else
    // re-arms: a stalled feature produces no work-item change by definition.
    expect(h.timers.live).toHaveLength(1);
    expect(h.wakes).toStrictEqual(["work-item-heartbeat"]);

    runSweep(h, h.timers.handles.length - 1);
    expect(h.wakes).toStrictEqual(["work-item-heartbeat", "work-item-heartbeat"]);
  });

  test("an unrelated manager wake puts the pending sweep back on the clock", () => {
    const h = build();
    h.heartbeat.notifyWorkItemChanged();

    // A user message wakes the manager before the timer fires. That wake does
    // not carry the sweep section, so it cannot stand in for the sweep — but
    // the sweep was not due either. Firing it here is what turned every
    // manager wake into a sweep: each started the moment the previous wake
    // ended, whatever the interval said.
    h.heartbeat.noteManagerWakeStarted();
    expect(h.timers.live).toHaveLength(0);

    h.heartbeat.flushDueAfterOverviewRelease();
    expect(h.wakes).toHaveLength(0);
    expect(h.timers.live).toHaveLength(1);
    expect(h.timers.live[0]!.ms).toBe(100);

    h.timers.fire(h.timers.handles.length - 1);
    expect(h.wakes).toStrictEqual(["work-item-heartbeat"]);
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
    expect(h.wakes).toStrictEqual(["work-item-heartbeat"]);
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
    expect(h.wakes).toStrictEqual(["work-item-heartbeat"]);
    expect(h.heartbeat.isEnded()).toBe(true);
  });

  test("ending also drops a sweep that was already due", () => {
    let busy = false;
    const h = build({ busy: () => busy });
    h.heartbeat.notifyWorkItemChanged();
    // It elapses while the thread is busy, so it is recorded as due rather than woken.
    busy = true;
    h.timers.fire(0);
    expect(h.wakes).toHaveLength(0);

    h.heartbeat.endSweep();
    busy = false;
    h.heartbeat.flushDueAfterOverviewRelease();
    expect(h.wakes).toHaveLength(0);
    expect(h.timers.live).toHaveLength(0);
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

// Scheduling, a sweep recovered from the mailbox, and wakes the database refused.

test("manager work-item heartbeat schedules one delayed wake while manager is idle", () => {
  const timers = new FakeTimers();
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    hasStalled: () => true,
    threadId: "thr-manager",
    wakeScheduler: {
      wake(threadId, reason) {
        wakes.push({ threadId, reason });
        return "wake-1";
      },
      isThreadBusy: () => false,
      getRunningWakeForThread: () => null
    },
    timers
  });

  heartbeat.notifyWorkItemChanged();
  heartbeat.notifyWorkItemChanged();

  expect(timers.handles).toHaveLength(1);
  expect(timers.handles[0]!.ms).toBe(DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS);

  timers.fire(0);

  expect(wakes).toStrictEqual([{ threadId: "thr-manager", reason: "work-item-heartbeat" }]);
});

test("a sweep recovered outside the heartbeat scheduler re-arms after release", () => {
  const timers = new FakeTimers();
  const wakes: AgentWakeReason[] = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    hasStalled: () => true,
    threadId: "thr-manager", timers,
    wakeScheduler: {
      wake(_threadId, reason) { wakes.push(reason); return "next-sweep"; },
      isThreadBusy: () => false, getRunningWakeForThread: () => null
    }
  });
  try {
    heartbeat.noteManagerWakeStarted(true);
    expect(timers.handles).toHaveLength(0);
    heartbeat.flushDueAfterOverviewRelease();
    expect(timers.handles.map((timer) => timer.ms)).toStrictEqual([DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS]);
    timers.fire(0);
    expect(wakes).toStrictEqual(["work-item-heartbeat"]);
  } finally { heartbeat.dispose(); }
});

test("a change while the thread is busy is kept: the sweep arms once the thread releases", () => {
  // A thread creating or restoring its first worker does it during its own wake.
  const timers = new FakeTimers();
  let busy = true;
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    hasStalled: () => true,
    threadId: "thr-manager",
    wakeScheduler: {
      wake(threadId, reason) {
        wakes.push({ threadId, reason });
        return "wake-1";
      },
      isThreadBusy: () => busy,
      getRunningWakeForThread: () => null
    },
    delayMs: 100,
    timers
  });

  heartbeat.notifyWorkItemChanged();
  expect(timers.handles).toHaveLength(0);
  busy = false;
  heartbeat.flushDueAfterOverviewRelease();
  // A fresh window, not a wake now.
  expect(timers.handles.map((h) => h.ms)).toStrictEqual([100]);
  expect(wakes).toHaveLength(0);
  timers.fire(0);
  expect(wakes).toStrictEqual([{ threadId: "thr-manager", reason: "work-item-heartbeat" }]);
});

// A sweep's wake whose row the database refused (another writer held it):
// the sweep stays due, and is asked for again.
test("a due sweep whose wake is refused at a release stays due: the next release asks again", () => {
  const timers = new FakeTimers();
  let busy = true;
  let refuse = true;
  const wakes: AgentWakeReason[] = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    hasStalled: () => true,
    threadId: "thr-manager", timers,
    wakeScheduler: {
      wake(_threadId, reason) {
        if (refuse) { refuse = false; throw new Error("database is locked"); }
        wakes.push(reason);
        return "sweep";
      },
      isThreadBusy: () => busy, getRunningWakeForThread: () => null
    }
  });
  try {
    busy = false;
    heartbeat.notifyWorkItemChanged();
    busy = true;
    timers.fire(0);
    busy = false;
    expect(() => heartbeat.flushDueAfterOverviewRelease()).toThrow("database is locked");
    expect(heartbeat.flushDueAfterOverviewRelease()).toBe("sweep");
    expect(wakes).toStrictEqual(["work-item-heartbeat"]);
  } finally { heartbeat.dispose(); }
});

test("a sweep whose timer fires on an idle thread and whose wake is refused is tried again shortly, not lost", () => {
  const timers = new FakeTimers();
  let refuse = true;
  const wakes: AgentWakeReason[] = [];
  const originalError = console.error;
  console.error = () => {};
  const heartbeat = new ManagerWorkItemHeartbeat({
    hasStalled: () => true,
    threadId: "thr-manager", timers,
    wakeScheduler: {
      wake(_threadId, reason) {
        if (refuse) { refuse = false; throw new Error("database is locked"); }
        wakes.push(reason);
        return "sweep";
      },
      isThreadBusy: () => false, getRunningWakeForThread: () => null
    }
  });
  try {
    heartbeat.notifyWorkItemChanged();
    expect(() => timers.fire(0)).not.toThrow();
    expect(timers.handles.map((h) => h.ms)).toStrictEqual([DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS, SWEEP_RETRY_MS]);
    timers.fire(1);
    expect(wakes).toStrictEqual(["work-item-heartbeat"]);
    // Asked for: its release opens a fresh window, not a second sweep at once.
    expect(heartbeat.flushDueAfterOverviewRelease()).toBe(null);
    expect(timers.handles.map((h) => h.ms)).toStrictEqual([DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS, SWEEP_RETRY_MS, DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS]);
  } finally {
    console.error = originalError;
    heartbeat.dispose();
  }
});

describe("a due sweep wakes the manager only when one of its workers is stuck", () => {
  test("none stuck: no wake, and the sweep rests until a work item changes", () => {
    const h = build({ stalled: () => false });
    h.heartbeat.notifyWorkItemChanged();
    h.timers.fire(0);
    expect([h.wakes, h.heartbeat.isEnded(), h.timers.live.length]).toEqual([[], true, 0]);
    h.heartbeat.notifyWorkItemChanged();
    expect([h.heartbeat.isEnded(), h.timers.live.length]).toEqual([false, 1]);
  });

  test("a sweep that fell due while the thread was busy checks when the thread is released", () => {
    let busy = false;
    const h = build({ busy: () => busy, stalled: () => false });
    h.heartbeat.notifyWorkItemChanged();
    busy = true;
    h.timers.fire(0);
    busy = false;
    h.heartbeat.flushDueAfterOverviewRelease();
    expect([h.wakes, h.heartbeat.isEnded()]).toEqual([[], true]);
  });

  test("a check that fails wakes the manager, as before", () => {
    const h = build({ stalled: () => { throw new Error("database is locked"); } });
    h.heartbeat.notifyWorkItemChanged();
    h.timers.fire(0);
    expect(h.wakes).toStrictEqual(["work-item-heartbeat"]);
  });
});
