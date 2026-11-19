import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MANAGER_SWEEP_MS,
  ManagerSweep,
  SWEEP_RETRY_MS
} from "../src/server/runtime/manager-sweep.js";
import type { AgentWakeReason } from "../src/server/modules/agent/agent-store.js";

/**
 * The sweep loop: the timer keeps waking the manager agent until the agent
 * says to stop. Continuing is the default and ending is the deliberate act,
 * because forgetting to end costs one wake while forgetting to continue loses a
 * stalled worker with nothing left to notice it.
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
  const sweep = new ManagerSweep({
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
  return { timers, wakes, sweep };
}

/** One full cycle: arm, fire, and release the wake that fired. */
function runSweep(h: ReturnType<typeof build>, timerIndex: number): void {
  h.timers.fire(timerIndex);
  h.sweep.noteManagerWakeStarted();
  h.sweep.flushDueAfterManagerRelease();
}

test("the sweep comes 25 minutes after the manager's turn, inside a 30-minute prompt cache", () => {
  // Several providers keep a prompt cache for 30 minutes after its last read,
  // and the clock starts when the turn ends, a little after its last request:
  // a 30-minute sweep lands seconds past the cache and rewrites the prompt.
  expect(DEFAULT_MANAGER_SWEEP_MS).toBe(25 * 60 * 1000);
});

describe("the sweep continues by default", () => {
  test("re-arms after the sweep wake it asked for is released", () => {
    const h = build();
    h.sweep.notifyWorkItemChanged();
    expect(h.timers.live).toHaveLength(1);

    runSweep(h, 0);

    // The agent did not call end_sweep, so it gets woken again. Nothing else
    // re-arms: a stalled worker produces no work-item change by definition.
    expect(h.timers.live).toHaveLength(1);
    expect(h.wakes).toStrictEqual(["sweep"]);

    runSweep(h, h.timers.handles.length - 1);
    expect(h.wakes).toStrictEqual(["sweep", "sweep"]);
  });

  test("an unrelated manager wake puts the pending sweep back on the clock", () => {
    const h = build();
    h.sweep.notifyWorkItemChanged();

    // A user message wakes the manager before the timer fires. That wake does
    // not carry the sweep section, so it cannot stand in for the sweep — but
    // the sweep was not due either. Firing it here is what turned every
    // manager wake into a sweep: each started the moment the previous wake
    // ended, whatever the interval said.
    h.sweep.noteManagerWakeStarted();
    expect(h.timers.live).toHaveLength(0);

    h.sweep.flushDueAfterManagerRelease();
    expect(h.wakes).toHaveLength(0);
    expect(h.timers.live).toHaveLength(1);
    expect(h.timers.live[0]!.ms).toBe(100);

    h.timers.fire(h.timers.handles.length - 1);
    expect(h.wakes).toStrictEqual(["sweep"]);
  });

  test("a sweep that came due while the thread was busy still fires at once", () => {
    // The other half of the distinction. This timer elapsed — it did not get
    // interrupted — and found the thread occupied, so it is owed a wake the
    // moment the thread frees up, not another full window.
    let busy = false;
    const h = build({ busy: () => busy });
    h.sweep.notifyWorkItemChanged();
    expect(h.timers.live).toHaveLength(1);

    busy = true;
    h.timers.fire(0);
    expect(h.wakes).toHaveLength(0);

    busy = false;
    h.sweep.flushDueAfterManagerRelease();
    expect(h.wakes).toStrictEqual(["sweep"]);
  });

  test("a wake with no sweep pending neither fires nor arms one", () => {
    const h = build();
    h.sweep.noteManagerWakeStarted();
    h.sweep.flushDueAfterManagerRelease();
    expect(h.wakes).toHaveLength(0);
    expect(h.timers.live).toHaveLength(0);
  });
});

describe("only end_sweep stops it", () => {
  test("no further sweep is armed once the agent ends it", () => {
    const h = build();
    h.sweep.notifyWorkItemChanged();
    h.timers.fire(0);
    h.sweep.noteManagerWakeStarted();

    h.sweep.endSweep();
    h.sweep.flushDueAfterManagerRelease();

    expect(h.timers.live).toHaveLength(0);
    expect(h.wakes).toStrictEqual(["sweep"]);
    expect(h.sweep.isEnded()).toBe(true);
  });

  test("ending also drops a sweep that was already due", () => {
    let busy = false;
    const h = build({ busy: () => busy });
    h.sweep.notifyWorkItemChanged();
    // It elapses while the thread is busy, so it is recorded as due rather than woken.
    busy = true;
    h.timers.fire(0);
    expect(h.wakes).toHaveLength(0);

    h.sweep.endSweep();
    busy = false;
    h.sweep.flushDueAfterManagerRelease();
    expect(h.wakes).toHaveLength(0);
    expect(h.timers.live).toHaveLength(0);
  });

  test("new work reopens the question the agent closed", () => {
    const h = build();
    h.sweep.endSweep();
    expect(h.sweep.isEnded()).toBe(true);

    h.sweep.notifyWorkItemChanged();

    // This is the only path back. Nothing has to remember to restart the sweep:
    // starting work is what restarts it.
    expect(h.sweep.isEnded()).toBe(false);
    expect(h.timers.live).toHaveLength(1);
  });

  test("dispose stops the loop without marking it ended", () => {
    const h = build();
    h.sweep.notifyWorkItemChanged();
    h.sweep.dispose();
    expect(h.timers.live).toHaveLength(0);

    // Shutdown is not the agent's conclusion — a restart must sweep again.
    expect(h.sweep.isEnded()).toBe(false);
    h.sweep.notifyWorkItemChanged();
    expect(h.timers.live).toHaveLength(0);
  });
});

// Scheduling, a sweep recovered from the mailbox, and wakes the database refused.

test("a manager's sweep schedules one delayed wake while the manager is idle", () => {
  const timers = new FakeTimers();
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const sweep = new ManagerSweep({
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

  sweep.notifyWorkItemChanged();
  sweep.notifyWorkItemChanged();

  expect(timers.handles).toHaveLength(1);
  expect(timers.handles[0]!.ms).toBe(DEFAULT_MANAGER_SWEEP_MS);

  timers.fire(0);

  expect(wakes).toStrictEqual([{ threadId: "thr-manager", reason: "sweep" }]);
});

test("a sweep recovered outside the sweep timer re-arms after release", () => {
  const timers = new FakeTimers();
  const wakes: AgentWakeReason[] = [];
  const sweep = new ManagerSweep({
    hasStalled: () => true,
    threadId: "thr-manager", timers,
    wakeScheduler: {
      wake(_threadId, reason) { wakes.push(reason); return "next-sweep"; },
      isThreadBusy: () => false, getRunningWakeForThread: () => null
    }
  });
  try {
    sweep.noteManagerWakeStarted(true);
    expect(timers.handles).toHaveLength(0);
    sweep.flushDueAfterManagerRelease();
    expect(timers.handles.map((timer) => timer.ms)).toStrictEqual([DEFAULT_MANAGER_SWEEP_MS]);
    timers.fire(0);
    expect(wakes).toStrictEqual(["sweep"]);
  } finally { sweep.dispose(); }
});

test("a change while the thread is busy is kept: the sweep arms once the thread releases", () => {
  // A thread creating or restoring its first worker does it during its own wake.
  const timers = new FakeTimers();
  let busy = true;
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const sweep = new ManagerSweep({
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

  sweep.notifyWorkItemChanged();
  expect(timers.handles).toHaveLength(0);
  busy = false;
  sweep.flushDueAfterManagerRelease();
  // A fresh window, not a wake now.
  expect(timers.handles.map((h) => h.ms)).toStrictEqual([100]);
  expect(wakes).toHaveLength(0);
  timers.fire(0);
  expect(wakes).toStrictEqual([{ threadId: "thr-manager", reason: "sweep" }]);
});

// A sweep's wake whose row the database refused (another writer held it):
// the sweep stays due, and is asked for again.
test("a due sweep whose wake is refused at a release stays due: the next release asks again", () => {
  const timers = new FakeTimers();
  let busy = true;
  let refuse = true;
  const wakes: AgentWakeReason[] = [];
  const sweep = new ManagerSweep({
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
    sweep.notifyWorkItemChanged();
    busy = true;
    timers.fire(0);
    busy = false;
    expect(() => sweep.flushDueAfterManagerRelease()).toThrow("database is locked");
    expect(sweep.flushDueAfterManagerRelease()).toBe("sweep");
    expect(wakes).toStrictEqual(["sweep"]);
  } finally { sweep.dispose(); }
});

test("a sweep whose timer fires on an idle thread and whose wake is refused is tried again shortly, not lost", () => {
  const timers = new FakeTimers();
  let refuse = true;
  const wakes: AgentWakeReason[] = [];
  const originalError = console.error;
  console.error = () => {};
  const sweep = new ManagerSweep({
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
    sweep.notifyWorkItemChanged();
    expect(() => timers.fire(0)).not.toThrow();
    expect(timers.handles.map((h) => h.ms)).toStrictEqual([DEFAULT_MANAGER_SWEEP_MS, SWEEP_RETRY_MS]);
    timers.fire(1);
    expect(wakes).toStrictEqual(["sweep"]);
    // Asked for: its release opens a fresh window, not a second sweep at once.
    expect(sweep.flushDueAfterManagerRelease()).toBe(null);
    expect(timers.handles.map((h) => h.ms)).toStrictEqual([DEFAULT_MANAGER_SWEEP_MS, SWEEP_RETRY_MS, DEFAULT_MANAGER_SWEEP_MS]);
  } finally {
    console.error = originalError;
    sweep.dispose();
  }
});

describe("a due sweep wakes the manager only when one of its workers is stuck", () => {
  test("none stuck: no wake, and the sweep rests until a work item changes", () => {
    const h = build({ stalled: () => false });
    h.sweep.notifyWorkItemChanged();
    h.timers.fire(0);
    expect([h.wakes, h.sweep.isEnded(), h.timers.live.length]).toEqual([[], true, 0]);
    h.sweep.notifyWorkItemChanged();
    expect([h.sweep.isEnded(), h.timers.live.length]).toEqual([false, 1]);
  });

  test("a sweep that fell due while the thread was busy checks when the thread is released", () => {
    let busy = false;
    const h = build({ busy: () => busy, stalled: () => false });
    h.sweep.notifyWorkItemChanged();
    busy = true;
    h.timers.fire(0);
    busy = false;
    h.sweep.flushDueAfterManagerRelease();
    expect([h.wakes, h.sweep.isEnded()]).toEqual([[], true]);
  });

  test("a check that fails wakes the manager, as before", () => {
    const h = build({ stalled: () => { throw new Error("database is locked"); } });
    h.sweep.notifyWorkItemChanged();
    h.timers.fire(0);
    expect(h.wakes).toStrictEqual(["sweep"]);
  });
});
