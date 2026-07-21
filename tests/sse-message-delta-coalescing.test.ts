import { describe, expect, test } from "bun:test";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { SseEvent } from "../src/shared/api-contracts.js";

/**
 * Every delta carries `totalText` — the whole reply so far — which is what lets
 * a client that joined mid-stream catch up, and what made one event per
 * fragment quadratic in the length of the reply. Measured over 30 days on a
 * real store: 28.9 MB of text went out as 1,090 MB of events, one 29 KB reply
 * pushing 45 MB by itself.
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
  test("the first fragment goes out at once", async () => {
    // Text must still appear to arrive as it is written; the window may not
    // delay the moment a reply starts.
    const h = harness();
    h.delta("H");
    expect(h.texts()).toEqual(["H"]);
  });

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

  test("no trailing event when the burst added nothing new", async () => {
    const h = harness();
    h.delta("only");
    await tick(THROTTLE * 2);
    expect(h.texts()).toEqual(["only"]);
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

  test("flushing a wake with nothing pending emits nothing", async () => {
    const h = harness();
    h.delta("a");
    await tick(THROTTLE * 2);
    const before = h.texts().length;

    h.emitter.flushMessageDelta("thr-1", "wake-1");
    expect(h.texts()).toHaveLength(before);
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
  test("every event still carries the whole reply so far", async () => {
    // A client joining mid-stream reads `totalText` alone; coalescing may drop
    // events but never turn them into fragments.
    const h = harness();
    for (const t of ["H", "He", "Hello"]) h.delta(t);
    await tick(THROTTLE * 2);
    for (const text of h.texts()) expect("Hello".startsWith(text)).toBe(true);
    expect(h.texts().at(-1)).toBe("Hello");
  });

  test("other events are never coalesced", () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      h.emitter.emit("agentWakeStarted", {
        threadId: "thr-1",
        wakeId: `w${i}`,
        reason: "user"
      } as never);
    }
    expect(h.seen.filter((e) => e.event === "agentWakeStarted")).toHaveLength(3);
  });
});
