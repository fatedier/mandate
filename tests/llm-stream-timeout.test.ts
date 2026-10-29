import { expect, jest, test } from "bun:test";
import {
  createFirstChunkTimeoutGuard,
  createStreamIdleTimeoutGuard,
  isIdleActivityChunk
} from "../src/server/modules/llm/stream-timeout.js";
import { fakeClock } from "./helpers/fake-clock.js";

test("first chunk timeout guard aborts before any chunk arrives", async () => {
  const guard = createFirstChunkTimeoutGuard(undefined, 5);
  try {
    await sleep(20);
    expect(guard.signal.aborted).toBe(true);
    expect(String(guard.signal.reason)).toContain("first chunk");
  } finally {
    guard.cleanup();
  }
});

test("first chunk timeout guard stops after first chunk", async () => {
  const guard = createFirstChunkTimeoutGuard(undefined, 5);
  try {
    guard.markChunk();
    await sleep(20);
    expect(guard.signal.aborted).toBe(false);
  } finally {
    guard.cleanup();
  }
});

// On the fake clock: real sleeps of 5 + 5 ms against a 10 ms timer raced
// under a loaded suite (the first sleep could wake after the timer).
test("stream idle timeout guard resets on activity", () => {
  fakeClock();
  const guard = createStreamIdleTimeoutGuard(undefined, 10);
  try {
    jest.advanceTimersByTime(5);
    guard.markActivity();
    // 14 ms since the start: alive only because the activity restarted it.
    jest.advanceTimersByTime(9);
    expect(guard.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(guard.signal.aborted).toBe(true);
    expect(String(guard.signal.reason)).toContain("activity");
  } finally {
    guard.cleanup();
  }
});

test("stream idle timeout guard follows parent abort", async () => {
  const parent = new AbortController();
  const guard = createStreamIdleTimeoutGuard(parent.signal, 50);
  try {
    parent.abort(new Error("parent stopped"));
    expect(guard.signal.aborted).toBe(true);
    expect(String(guard.signal.reason)).toContain("parent stopped");
  } finally {
    guard.cleanup();
  }
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A part that arrives after the call ended (the SDK's
// `abort` part comes after its promises reject) must not start the clock again.
test("a cleaned-up idle guard stays stopped: activity after cleanup starts no timer", () => {
  fakeClock();
  const guard = createStreamIdleTimeoutGuard(undefined, 10);
  guard.cleanup();
  guard.markActivity();
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(20);
  expect(guard.signal.aborted).toBe(false);
});

// The one rule every model call's idle guard counts by (idleGuardedStreamOptions).
test("what keeps a stream alive: any part but the ones that end it; of the provider's raw chunks, a delta only", () => {
  expect([
    isIdleActivityChunk({ type: "text-delta" }),
    isIdleActivityChunk({ type: "reasoning-delta" }),
    isIdleActivityChunk({ type: "tool-input-delta" }),
    isIdleActivityChunk({ type: "raw", rawValue: { type: "response.function_call_arguments.delta", delta: "x" } }),
    isIdleActivityChunk({ type: "raw", rawValue: { type: "ping" } }),
    isIdleActivityChunk({ type: "raw", rawValue: "event: ping" }),
    isIdleActivityChunk({ type: "abort" }),
    isIdleActivityChunk({ type: "error" }),
    isIdleActivityChunk({ type: "finish" })
  ]).toEqual([true, true, true, true, false, false, false, false, false]);
});
