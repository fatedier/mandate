import { expect, test } from "bun:test";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";

test("WakeLock.tryAcquire: returns release fn on first acquire, null on contention", () => {
  const lock = new WakeLock();
  const r1 = lock.tryAcquire("t1");
  expect(r1).toBeTruthy();
  const r2 = lock.tryAcquire("t1");
  expect(r2).toBe(null);
  r1!();
  const r3 = lock.tryAcquire("t1");
  expect(r3).toBeTruthy();
  r3!();
});

test("WakeLock: separate threads don't block each other", () => {
  const lock = new WakeLock();
  const a = lock.tryAcquire("a");
  const b = lock.tryAcquire("b");
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  a!(); b!();
});

test("WakeLock.isHeld: reflects current state", () => {
  const lock = new WakeLock();
  expect(lock.isHeld("t")).toBe(false);
  const r = lock.tryAcquire("t")!;
  expect(lock.isHeld("t")).toBe(true);
  r();
  expect(lock.isHeld("t")).toBe(false);
});
