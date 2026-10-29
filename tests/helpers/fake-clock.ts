import { jest } from "bun:test";
import { onCleanup } from "./cleanup.js";

/**
 * jest's fake clock for the rest of the test, moved on with
 * jest.advanceTimersByTime. Call it before the mount: cleanups run newest
 * first, so what was mounted is unmounted under the clock that started its
 * timers, and only then does the real clock come back.
 */
export function fakeClock(): void {
  jest.useFakeTimers();
  onCleanup(realClock);
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
