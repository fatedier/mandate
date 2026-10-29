import { expect, test } from "bun:test";
import { ManagerSweeps } from "../src/server/runtime/manager-sweeps.js";
import type { FeatureRow } from "../src/server/modules/features/features-store.js";
import type { WorkItem } from "../src/server/modules/agent/work-item-store.js";
import { stub } from "./helpers/typed.js";

function fakeTimers() {
  const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    api: {
      setTimeout: (cb: () => void, ms: number) => { const t = { cb, ms, cleared: false }; timers.push(t); return t; },
      clearTimeout: (t: { cleared: boolean }) => { t.cleared = true; }
    },
    live: () => timers.filter((t) => !t.cleared)
  };
}

function setup({ busy = new Set<string>(), closed = new Set<string>() }: { busy?: Set<string>; closed?: Set<string> } = {}) {
  const clock = fakeTimers();
  const owners: Record<string, string> = { feat_a: "thr_a", feat_b: "thr_b", feat_a2: "thr_a" };
  const wakes: string[] = [];
  const sweeps = new ManagerSweeps({
    featuresStore: { getById: (id: string) => (owners[id] ? stub<FeatureRow>({ id, ownerThreadId: owners[id]!, archivedAt: null }) : null) },
    isOpenThread: (threadId: string) => !closed.has(threadId),
    workStore: { listStalled: () => [stub<WorkItem>({ id: "wi_stuck" })] },
    wakeScheduler: {
      wake: (threadId: string) => { wakes.push(threadId); return "wk"; },
      isThreadBusy: (threadId: string) => busy.has(threadId),
      getRunningWakeForThread: () => null
    },
    delayMs: 1800_000,
    timers: clock.api as never
  });
  return { clock, sweeps, wakes };
}

test("a worker change arms its owner's sweep only, one delay out", () => {
  const { clock, sweeps, wakes } = setup();
  sweeps.notifyWorkerChanged("feat_a");
  expect(clock.live().map((t) => t.ms)).toEqual([1800_000]);
  clock.live()[0]!.cb();
  expect(wakes).toStrictEqual(["thr_a"]);
});

test("end_sweep in thread A leaves thread B armed", () => {
  const { clock, sweeps, wakes } = setup();
  sweeps.notifyWorkerChanged("feat_a");
  sweeps.notifyWorkerChanged("feat_b");
  sweeps.endSweep("thr_a");
  expect(sweeps.isEnded("thr_a")).toBe(true);
  expect(sweeps.isEnded("thr_b")).toBe(false);
  for (const t of clock.live()) t.cb();
  expect(wakes).toStrictEqual(["thr_b"]);
});

test("a change to one of A's workers revives A's ended sweep; a change in B does not", () => {
  const { clock, sweeps } = setup();
  sweeps.notifyWorkerChanged("feat_a");
  sweeps.endSweep("thr_a");
  sweeps.notifyWorkerChanged("feat_b");
  expect(sweeps.isEnded("thr_a")).toBe(true);
  sweeps.notifyWorkerChanged("feat_a2");
  expect(sweeps.isEnded("thr_a")).toBe(false);
  expect(clock.live().length).toBe(2);
});

test("an unowned feature arms nothing; disposeThread stops that thread's timer", () => {
  const { clock, sweeps } = setup();
  sweeps.notifyWorkerChanged("feat_nobody");
  expect(clock.live()).toEqual([]);
  sweeps.notifyWorkerChanged("feat_a");
  sweeps.disposeThread("thr_a");
  expect(clock.live()).toEqual([]);
});

test("a wake of thread A defers A's pending sweep to a fresh window, not B's", () => {
  const { clock, sweeps } = setup();
  sweeps.notifyWorkerChanged("feat_a");
  sweeps.notifyWorkerChanged("feat_b");
  sweeps.noteWakeStarted("thr_a", false);
  expect(clock.live().length).toBe(1);
  sweeps.flushAfterRelease("thr_a");
  expect(clock.live().map((t) => t.ms)).toEqual([1800_000, 1800_000]);
});

test("a worker whose owner is no longer an open thread arms no sweep (a restore announces before the new owner is set)", () => {
  const clock = fakeTimers();
  const wakes: string[] = [];
  const sweeps = new ManagerSweeps({
    featuresStore: { getById: (id: string) => stub<FeatureRow>({ id, ownerThreadId: "thr_archived", archivedAt: null }) },
    isOpenThread: (threadId: string) => threadId !== "thr_archived",
    workStore: { listStalled: () => [stub<WorkItem>({ id: "wi_stuck" })] },
    wakeScheduler: {
      wake: (threadId: string) => { wakes.push(threadId); return "wk"; },
      isThreadBusy: () => false,
      getRunningWakeForThread: () => null
    },
    delayMs: 1800_000,
    timers: clock.api as never
  });
  sweeps.notifyWorkerChanged("feat_a");
  expect(clock.live()).toEqual([]);
});

test("a due sweep asks the work store whether its manager has a stuck worker, and wakes it only then", () => {
  const clock = fakeTimers();
  const wakes: string[] = [];
  const asked: unknown[] = [];
  let stuck = false;
  const sweeps = new ManagerSweeps({
    featuresStore: { getById: (id: string) => stub<FeatureRow>({ id, ownerThreadId: "thr_a", archivedAt: null }) },
    isOpenThread: () => true,
    workStore: { listStalled: (opts) => { asked.push(opts); return stuck ? [stub<WorkItem>({ id: "wi_1" })] : []; } },
    wakeScheduler: {
      wake: (threadId: string) => { wakes.push(threadId); return "wk"; },
      isThreadBusy: () => false,
      getRunningWakeForThread: () => null
    },
    delayMs: 1800_000,
    timers: clock.api as never
  });
  sweeps.notifyWorkerChanged("feat_a");
  clock.timers.at(-1)!.cb();
  expect([wakes, asked, sweeps.isEnded("thr_a")]).toEqual([[], [{ ownerThreadId: "thr_a", limit: 1 }], true]);
  stuck = true;
  sweeps.notifyWorkerChanged("feat_a");
  clock.timers.at(-1)!.cb();
  expect(wakes).toStrictEqual(["thr_a"]);
});

