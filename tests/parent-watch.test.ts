import { expect, test } from "bun:test";
import { PARENT_WATCH_INTERVAL_MS, parseParentPid, processExists, watchParent } from "../src/server/platform/process/parent-watch";

/** A hand-cranked interval so the test drives time. */
function fakeTimers() {
  let cb: (() => void) | null = null;
  let cleared = 0;
  return {
    setInterval: ((fn: () => void) => { cb = fn; return 1 as unknown as ReturnType<typeof setInterval>; }) as typeof setInterval,
    clearInterval: (() => { cleared += 1; cb = null; }) as typeof clearInterval,
    tick: () => cb?.(),
    get cleared() { return cleared; },
    get armed() { return cb !== null; }
  };
}

test("fires onGone once when the parent disappears, then stops polling", () => {
  let alive = true;
  let gone = 0;
  const t = fakeTimers();
  watchParent({ pid: 4242, isAlive: () => alive, onGone: () => { gone += 1; }, ...t });
  expect(gone).toBe(0);
  expect(t.armed).toBe(true);
  t.tick();
  expect(gone).toBe(0);
  alive = false;
  t.tick();
  expect(gone).toBe(1);
  expect(t.cleared).toBe(1);
  expect(t.armed).toBe(false);
});

test("a parent already gone at start fires immediately and never arms a timer", () => {
  let gone = 0;
  const t = fakeTimers();
  watchParent({ pid: 1, isAlive: () => false, onGone: () => { gone += 1; }, ...t });
  expect(gone).toBe(1);
  expect(t.armed).toBe(false);
});

test("stop() ends polling and suppresses a later onGone", () => {
  let alive = true;
  let gone = 0;
  const t = fakeTimers();
  const stop = watchParent({ pid: 7, isAlive: () => alive, onGone: () => { gone += 1; }, ...t });
  stop();
  expect(t.cleared).toBe(1);
  alive = false;
  t.tick(); // a stale tick after stop
  expect(gone).toBe(0);
});

test("the poll checks the pid it was given, at the documented cadence", () => {
  const seen: number[] = [];
  const intervals: number[] = [];
  const t = fakeTimers();
  watchParent({
    pid: 31337,
    isAlive: (pid) => { seen.push(pid); return true; },
    onGone: () => {},
    setInterval: ((fn: () => void, ms: number) => { intervals.push(ms); return t.setInterval(fn, ms); }) as typeof setInterval,
    clearInterval: t.clearInterval
  });
  t.tick();
  expect(seen).toEqual([31337, 31337]);
  expect(intervals).toEqual([PARENT_WATCH_INTERVAL_MS]);
});

test("processExists: our own pid yes, an impossible pid no", () => {
  expect(processExists(process.pid)).toBe(true);
  expect(processExists(2 ** 22 - 1)).toBe(false);
});

test("parseParentPid: absent → null, digits → pid, anything else → error", () => {
  expect(parseParentPid(undefined)).toBe(null);
  expect(parseParentPid("123")).toEqual({ pid: 123 });
  expect(parseParentPid("0")).toEqual({ error: '--parent-pid must be a positive integer, got "0"' });
  expect(parseParentPid("abc")).toEqual({ error: '--parent-pid must be a positive integer, got "abc"' });
  expect(parseParentPid("-5")).toEqual({ error: '--parent-pid must be a positive integer, got "-5"' });
});
