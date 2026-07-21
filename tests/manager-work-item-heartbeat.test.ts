import { expect, test } from "bun:test";
import {
  DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS,
  ManagerWorkItemHeartbeat
} from "../src/server/runtime/manager-work-item-heartbeat.js";
import type { AgentWakeReason } from "../src/server/modules/agent/agent-store.js";

test("manager work-item heartbeat schedules one delayed wake while manager is idle", () => {
  const timers = new FakeTimers();
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    agentStore: managerStore(),
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

  expect(wakes).toEqual([{ threadId: "thr-manager", reason: "work-item-heartbeat" }]);
});

test("manager work-item heartbeat does not schedule while manager is busy", () => {
  const timers = new FakeTimers();
  let busy = true;
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    agentStore: managerStore(),
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
  expect(wakes).toHaveLength(0);
});

test("manager work-item heartbeat flushes after release when timer fires while busy", () => {
  const timers = new FakeTimers();
  let busy = false;
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    agentStore: managerStore(),
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
  busy = true;
  timers.fire(0);

  expect(wakes).toHaveLength(0);

  busy = false;
  heartbeat.flushDueAfterOverviewRelease();

  expect(wakes).toEqual([{ threadId: "thr-manager", reason: "work-item-heartbeat" }]);
});

test("manager work-item heartbeat is canceled by any manager wake before it fires", () => {
  const timers = new FakeTimers();
  const wakes: Array<{ threadId: string; reason: AgentWakeReason }> = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    agentStore: managerStore(),
    wakeScheduler: {
      wake(threadId, reason) {
        wakes.push({ threadId, reason });
        return "wake-1";
      },
      isThreadBusy: () => false,
      getRunningWakeForThread: () => null
    },
    delayMs: 100,
    timers
  });

  heartbeat.notifyWorkItemChanged();
  heartbeat.noteManagerWakeStarted();
  timers.fire(0);

  expect(timers.handles[0]!.cleared).toBe(true);
  expect(wakes).toHaveLength(0);
});

test("a sweep recovered outside the heartbeat scheduler re-arms after release", () => {
  const timers = new FakeTimers();
  const wakes: AgentWakeReason[] = [];
  const heartbeat = new ManagerWorkItemHeartbeat({
    agentStore: managerStore(), timers,
    wakeScheduler: {
      wake(_threadId, reason) { wakes.push(reason); return "next-sweep"; },
      isThreadBusy: () => false, getRunningWakeForThread: () => null
    }
  });
  try {
    heartbeat.noteManagerWakeStarted(true);
    expect(timers.handles).toHaveLength(0);
    heartbeat.flushDueAfterOverviewRelease();
    expect(timers.handles.map((timer) => timer.ms)).toEqual([DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS]);
    timers.fire(0);
    expect(wakes).toEqual(["work-item-heartbeat"]);
  } finally { heartbeat.dispose(); }
});

test("a recovered sweep can still end sweeping explicitly", () => {
  const timers = new FakeTimers();
  const heartbeat = new ManagerWorkItemHeartbeat({
    agentStore: managerStore(), timers,
    wakeScheduler: { wake: () => "unexpected", isThreadBusy: () => false, getRunningWakeForThread: () => null }
  });
  heartbeat.noteManagerWakeStarted(true);
  heartbeat.endSweep();
  heartbeat.flushDueAfterOverviewRelease();
  expect(timers.handles).toHaveLength(0);
  heartbeat.dispose();
});

function managerStore() {
  return {
    getOrCreateThread() {
      return { id: "thr-manager" };
    }
  };
}

interface FakeTimerHandle {
  ms: number;
  callback: () => void;
  cleared: boolean;
  unref: () => void;
}

class FakeTimers {
  readonly handles: FakeTimerHandle[] = [];

  setTimeout(callback: () => void, ms: number): FakeTimerHandle {
    const handle = {
      ms,
      callback,
      cleared: false,
      unref() {}
    };
    this.handles.push(handle);
    return handle;
  }

  clearTimeout(handle: FakeTimerHandle): void {
    handle.cleared = true;
  }

  fire(index: number): void {
    const handle = this.handles[index]!;
    if (!handle.cleared) handle.callback();
  }
}
