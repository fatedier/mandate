import { jest } from "bun:test";

/**
 * jest's fake clock for the rest of the test, moved on with
 * jest.advanceTimersByTime. Call it before the mount. The preload
 * (tests/setup.ts) gives the real clock back after every test, once the
 * test's cleanups have run, so what was mounted is unmounted under the clock
 * that started its timers.
 */
export function fakeClock(): void {
  jest.useFakeTimers();
}

/**
 * The real clock again. A window timer (happy-dom's window.setTimeout) still
 * waiting in the fake clock when the real one comes back stops every window
 * timer after it, in this test and in every later one in the process, and
 * jest.clearAllTimers does not undo that. So the timers still waiting run
 * first.
 */
export function realClock(): void {
  if (!jest.isFakeTimers()) return;
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
}
