import { describe, expect, test } from "bun:test";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { SseEvent } from "../src/shared/api-contracts.js";
import type { WorkItemDto } from "../src/shared/api/work-items.js";

/**
 * Every delta carries `totalText` — the whole reply so far — which is what lets
 * a client that joined mid-stream catch up, and what made one event per
 * fragment quadratic in the length of the reply: the events sent come to
 * many times the text they carry, and a long reply is the worst of it.
 */

const THROTTLE = 20;

function harness() {
  const seen: SseEvent[] = [];
  const emitter = new AgentSseEmitter({ messageDeltaThrottleMs: THROTTLE });
  emitter.addSink((e) => seen.push(e));
  const delta = (totalText: string, wakeId = "wake-1") =>
    emitter.emit("agentMessageDelta", {
      threadId: "thr-1",
      wakeId,
      deltaText: totalText.slice(-1),
      totalText
    });
  const texts = () =>
    seen
      .filter((e) => e.event === "agentMessageDelta")
      .map((e) => (e.data as { totalText: string }).totalText);
  return { emitter, seen, delta, texts };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("agentMessageDelta coalescing", () => {

  test("a burst collapses to the first and the latest", async () => {
    const h = harness();
    for (const t of ["H", "He", "Hel", "Hell", "Hello"]) h.delta(t);
    expect(h.texts()).toEqual(["H"]);

    await tick(THROTTLE * 2);
    expect(h.texts()).toEqual(["H", "Hello"]);
  });

  test("a slow stream is never delayed by the window", async () => {
    // When nothing coalesced, the entry is dropped and the next fragment fires
    // immediately — one event per fragment, exactly as before.
    const h = harness();
    h.delta("a");
    await tick(THROTTLE * 2);
    h.delta("ab");
    await tick(THROTTLE * 2);
    h.delta("abc");
    expect(h.texts()).toEqual(["a", "ab", "abc"]);
  });

  test("two wakes on one thread do not share a bucket", async () => {
    // The key is (thread, wake): a side thread's stream must not swallow the
    // main one's fragments.
    const h = harness();
    h.delta("a", "wake-1");
    h.delta("b", "wake-2");
    expect(h.texts()).toEqual(["a", "b"]);
  });
});

describe("flushMessageDelta", () => {
  test("sends what is still coalesced, immediately", () => {
    const h = harness();
    h.delta("Hel");
    h.delta("Hello");
    expect(h.texts()).toEqual(["Hel"]);

    h.emitter.flushMessageDelta("thr-1", "wake-1");
    expect(h.texts()).toEqual(["Hel", "Hello"]);
  });

  test("nothing arrives after the flush", async () => {
    // The reason the flush exists: the client clears its streaming bubble when
    // the finished message lands, and a late delta would set it again — showing
    // the finished reply twice, once as a message and once as a stream with no
    // end.
    const h = harness();
    h.delta("Hel");
    h.delta("Hello");
    h.emitter.flushMessageDelta("thr-1", "wake-1");
    const after = h.texts().length;

    await tick(THROTTLE * 3);
    expect(h.texts()).toHaveLength(after);
  });

  test("flushing an unknown wake is a no-op", () => {
    const h = harness();
    h.delta("a", "wake-1");
    h.emitter.flushMessageDelta("thr-1", "wake-other");
    expect(h.texts()).toEqual(["a"]);
  });

  test("the flushed wake's timer cannot disturb the stream that follows", async () => {
    // Flushing removes the entry, so the old timer would find nothing — except
    // a retry reuses the same key. Left running, that stale timer fires inside
    // the NEW window, deletes the new entry and emits early, so the window
    // silently stops holding. It is the entry it destroys, not the event it
    // sends, that does the damage.
    //
    // The two timers have to be staggered for that to be visible at all: start
    // the second stream mid-way through the first timer's window, so the stale
    // one comes due while the new one is still counting.
    const SLOW = 120;
    const seen: SseEvent[] = [];
    const emitter = new AgentSseEmitter({ messageDeltaThrottleMs: SLOW });
    emitter.addSink((e) => seen.push(e));
    const delta = (totalText: string) =>
      emitter.emit("agentMessageDelta", {
        threadId: "thr-1",
        wakeId: "wake-1",
        deltaText: totalText.slice(-1),
        totalText
      });
    const texts = () =>
      seen
        .filter((e) => e.event === "agentMessageDelta")
        .map((e) => (e.data as { totalText: string }).totalText);

    delta("a");
    delta("ab");
    emitter.flushMessageDelta("thr-1", "wake-1");
    expect(texts()).toEqual(["a", "ab"]);

    // Half-way in: the stale timer now comes due at ~SLOW, the new one at
    // ~1.5 × SLOW.
    await tick(SLOW / 2);
    delta("abc");
    delta("abcd");
    delta("abcde");
    expect(texts()).toEqual(["a", "ab", "abc"]);

    // Past the stale timer, well short of the new window.
    await tick(SLOW * 0.75);
    expect(texts()).toEqual(["a", "ab", "abc"]);

    await tick(SLOW);
    expect(texts()).toEqual(["a", "ab", "abc", "abcde"]);
  });
});

describe("what coalescing must not change", () => {

  test("other events are never coalesced", () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.emitter.emit("agentWakeStarted", {
        threadId: "thr-1",
        wakeId: `w${i}`,
        reason: "user",
        startedAt: "2026-10-03T00:00:00.000Z"
      });
    }
    expect(h.seen.filter((e) => e.event === "agentWakeStarted")).toHaveLength(3);
  });
});

const TEST_THROTTLE_MS = 1;

function makeItem(id: string, lastActivityAt: string): WorkItemDto {
  return {
    id, featureId: "f", projectId: "p", title: "t",
    lastActivityAt, createdAt: lastActivityAt, updatedAt: lastActivityAt,
    failedAt: null, failedMessage: null, failedKind: null
  };
}

function makeEmitter() {
  return new AgentSseEmitter({ workItemUpdateThrottleMs: TEST_THROTTLE_MS });
}

function waitForThrottleWindow() {
  return new Promise((r) => setTimeout(r, TEST_THROTTLE_MS + 5));
}

describe("workItemUpdated throttling", () => {
  test("workItemUpdated: first emit fires immediately, burst coalesces into one trailing emit", async () => {
    const emitter = makeEmitter();
    const received: WorkItemDto[] = [];
    emitter.addSink((e) => {
      if (e.event === "workItemUpdated") received.push(e.data.item);
    });

    for (let i = 0; i < 5; i++) {
      emitter.emit("workItemUpdated", { item: makeItem("wi-1", String(i)) });
    }
    // immediate emit is the first one (lastActivityAt='0')
    expect(received.length).toBe(1);
    expect(received[0].lastActivityAt).toBe("0");

    // wait past throttle window
    await waitForThrottleWindow();
    // trailing emit should now have arrived with the latest data ('4')
    expect(received.length).toBe(2);
    expect(received[1].lastActivityAt).toBe("4");
  });

  test("workItemUpdated: throttle is per-item", async () => {
    const emitter = makeEmitter();
    const received: WorkItemDto[] = [];
    emitter.addSink((e) => {
      if (e.event === "workItemUpdated") received.push(e.data.item);
    });
    emitter.emit("workItemUpdated", { item: makeItem("wi-1", "a") });
    emitter.emit("workItemUpdated", { item: makeItem("wi-2", "b") });
    expect(received.length).toBe(2);
    expect(received[0].id).toBe("wi-1");
    expect(received[1].id).toBe("wi-2");
    await waitForThrottleWindow();
    // No trailing emits expected (no coalesced updates).
    expect(received.length).toBe(2);
  });

  test("other event kinds pass through unchanged", async () => {
    const emitter = makeEmitter();
    const received: any[] = [];
    emitter.addSink((e) => received.push(e));
    // some other event — pick one that exists. workItemCreated is a safe bet.
    emitter.emit("workItemCreated", { item: makeItem("wi-1", "a") });
    emitter.emit("workItemCreated", { item: makeItem("wi-1", "b") });
    expect(received.length).toBe(2);
  });

  test("workItemUpdated: trailing emit after window with another burst restarts", async () => {
    const emitter = makeEmitter();
    const received: WorkItemDto[] = [];
    emitter.addSink((e) => {
      if (e.event === "workItemUpdated") received.push(e.data.item);
    });
    emitter.emit("workItemUpdated", { item: makeItem("wi-1", "a") });
    emitter.emit("workItemUpdated", { item: makeItem("wi-1", "b") });
    await waitForThrottleWindow();
    expect(received.length).toBe(2);
    // After window, a new emit fires immediately again.
    emitter.emit("workItemUpdated", { item: makeItem("wi-1", "c") });
    expect(received.length).toBe(3);
  });
});
