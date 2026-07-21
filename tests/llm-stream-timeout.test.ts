import { expect, test } from "bun:test";
import {
  createFirstChunkTimeoutGuard,
  createStreamIdleTimeoutGuard
} from "../src/server/modules/llm/stream-timeout.js";

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

test("stream idle timeout guard resets on activity", async () => {
  const guard = createStreamIdleTimeoutGuard(undefined, 10);
  try {
    await sleep(5);
    guard.markActivity();
    await sleep(5);
    expect(guard.signal.aborted).toBe(false);
    await sleep(15);
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
