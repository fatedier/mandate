import { expect, test } from "bun:test";
import { deliverWakeMessage, type WakeDeliveryDeps, eventField } from "../src/server/modules/agent/wake-delivery.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";

function deps(env: ReturnType<typeof freshStoresEnv>, over: Partial<WakeDeliveryDeps> = {}) {
  const wakes: Array<{ threadId: string; reason: string; messageId: string | null }> = [];
  const d: WakeDeliveryDeps = {
    agentStore: env.agentStore,
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (threadId, reason, messageId) => { wakes.push({ threadId, reason, messageId }); return "wake-1"; },
    isThreadBusy: () => false,
    ...over
  };
  return { d, wakes };
}

test("an idle thread gets the message and a wake with the given reason", async () => {
  const env = freshStoresEnv("md-deliver-idle-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const { d, wakes } = deps(env);
  const result = await deliverWakeMessage(d, { threadId: thread.id, reason: "monitor", source: "monitor", messageId: null, render: () => "[Mandate monitor event]" });
  expect(result.status).toBe("woken");
  const messageId = (result as { messageId: string }).messageId;
  expect(wakes).toStrictEqual([{ threadId: thread.id, reason: "monitor", messageId }]);
  const last = env.agentStore.getActiveMessages(thread.id).at(-1)!;
  expect(last.id).toBe(messageId);
  expect(last.source).toBe("monitor");
});

test("a busy thread gets nothing yet: busy, no message appended", async () => {
  const env = freshStoresEnv("md-deliver-busy-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const before = env.agentStore.getActiveMessages(thread.id).length;
  const { d, wakes } = deps(env, { isThreadBusy: () => true });
  expect(await deliverWakeMessage(d, { threadId: thread.id, reason: "monitor", source: "monitor", messageId: null, render: () => "x" }))
    .toEqual({ status: "busy", messageId: null });
  expect(wakes).toStrictEqual([]);
  expect(env.agentStore.getActiveMessages(thread.id).length).toBe(before);
});

test("a refused wake keeps the appended message's id for the retry, which does not append again", async () => {
  const env = freshStoresEnv("md-deliver-refused-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  let accept = false;
  const { d } = deps(env, { onWake: () => (accept ? "wake-2" : null) });
  const first = await deliverWakeMessage(d, { threadId: thread.id, reason: "monitor", source: "monitor", messageId: null, render: () => "x" });
  expect(first.status).toBe("busy");
  const messageId = (first as { messageId: string }).messageId;
  expect(typeof messageId).toBe("string");
  const count = env.agentStore.getActiveMessages(thread.id).length;
  accept = true;
  const second = await deliverWakeMessage(d, { threadId: thread.id, reason: "monitor", source: "monitor", messageId, render: () => { throw new Error("must not render again"); } });
  expect(second).toEqual({ status: "woken", wakeId: "wake-2", messageId });
  expect(env.agentStore.getActiveMessages(thread.id).length).toBe(count);
});

test("a retired thread is reported, a missing one is gone, and stillWanted false abandons", async () => {
  const env = freshStoresEnv("md-deliver-gone-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const retired = deps(env, { isThreadRetired: () => true }).d;
  expect(await deliverWakeMessage(retired, { threadId: thread.id, reason: "monitor", source: "monitor", messageId: null, render: () => "x" })).toEqual({ status: "retired" });
  const { d } = deps(env);
  expect(await deliverWakeMessage(d, { threadId: thread.id, reason: "monitor", source: "monitor", messageId: null, render: () => "x", stillWanted: () => false })).toEqual({ status: "abandoned" });
  expect(await deliverWakeMessage(d, { threadId: "thr_missing", reason: "monitor", source: "monitor", messageId: null, render: () => "x" })).toEqual({ status: "gone" });
});

// The caller acts in the same tick as the decision: a busy thread's trigger is
// queued before a wake ending in the gap could flush an empty queue (the race
// is reproduced in window-watch-manager.test.ts), and cleanup runs before a
// dispose in the gap could close the database it writes to.
test("settle runs right where busy is seen, nothing in between, before the call returns", async () => {
  const env = freshStoresEnv("md-deliver-settle-busy-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  let busy = false;
  const order: string[] = [];
  const { d, wakes } = deps(env, {
    isThreadBusy: () => {
      if (busy) { order.push("busy seen"); queueMicrotask(() => order.push("microtask")); }
      return busy;
    }
  });
  const result = await deliverWakeMessage(d, {
    threadId: thread.id, reason: "monitor", source: "monitor", messageId: null,
    render: async () => { busy = true; queueMicrotask(() => order.push("microtask")); return "x"; },
    settle: (r) => order.push(`settle ${r.status} ${"messageId" in r ? r.messageId : ""}`)
  });
  order.push("returned");
  expect(result).toEqual({ status: "busy", messageId: null });
  expect(wakes).toStrictEqual([]);
  const seen = order.indexOf("busy seen");
  expect(order.slice(seen, seen + 2)).toStrictEqual(["busy seen", "settle busy null"]);
  expect(order.at(-1)).toBe("returned");
});

test("settle gets every other result in the same tick it is decided, once", async () => {
  const env = freshStoresEnv("md-deliver-settle-all-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const cases: Array<[string, Parameters<typeof deps>[1], Partial<Parameters<typeof deliverWakeMessage>[1]>]> = [
    ["woken", { onWake: () => { queueMicrotask(() => order.push("microtask")); return "wake-1"; } }, {}],
    ["retired", { isThreadRetired: () => { queueMicrotask(() => order.push("microtask")); return true; } }, {}],
    ["abandoned", {}, { stillWanted: () => { queueMicrotask(() => order.push("microtask")); return false; } }]
  ];
  let order: string[] = [];
  for (const [status, over, extra] of cases) {
    order = [];
    const { d } = deps(env, over);
    const result = await deliverWakeMessage(d, {
      threadId: thread.id, reason: "monitor", source: "monitor", messageId: null,
      render: () => "x", ...extra,
      settle: (r) => order.push(`settle ${r.status}`)
    });
    expect([status, result.status]).toEqual([status, status]);
    expect([status, order]).toEqual([status, [`settle ${status}`, "microtask"]]);
  }
});

// Every line break any reader honours: JS regexes (LF, CR, U+2028, U+2029)
// and splitlines-style readers (VT, FF, FS/GS/RS, NEL).
const LINE_BREAKS = /[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/;

test("an event field is one line whatever its value holds, its breaks left visible", () => {
  const value = "a\nb\r\nc\rd\ve\ff\x1cg\x1dh\x1ei\x85j\u2028k\u2029l";
  const out = eventField(value);
  expect(LINE_BREAKS.test(out)).toBe(false);
  expect(out).toBe("a\\nb\\nc\\nd\\u000be\\u000cf\\u001cg\\u001dh\\u001ei\\u0085j\\u2028k\\u2029l");
  expect(eventField("plain value")).toBe("plain value");
});

// A wake the database refused after the message was appended: the message is
// kept (settled busy with its id) and the error goes on to whoever retries,
// so the retry wakes on that message instead of appending it again.
test("a wake that throws after its message was appended settles busy with that message, and the retry appends nothing more", async () => {
  const env = freshStoresEnv("md-deliver-refused-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  let refuse = true;
  const settled: Array<{ status: string; messageId?: string | null }> = [];
  const { d, wakes } = deps(env, {
    onWake: (threadId, reason, messageId) => {
      if (refuse) { refuse = false; throw new Error("database is locked"); }
      wakes.push({ threadId, reason, messageId });
      return "wake-2";
    }
  });
  const request = { threadId: thread.id, reason: "monitor" as const, source: "monitor" as const, render: () => "[Mandate monitor event]", settle: (r: { status: string; messageId?: string | null }) => { settled.push(r); } };
  await expect(deliverWakeMessage(d, { ...request, messageId: null })).rejects.toThrow("database is locked");
  const kept = settled[0]!;
  expect(kept.status).toBe("busy");
  const before = env.agentStore.getActiveMessages(thread.id).filter((m) => m.source === "monitor").length;
  expect(before).toBe(1);
  const again = await deliverWakeMessage(d, { ...request, messageId: kept.messageId ?? null });
  expect(again).toEqual({ status: "woken", wakeId: "wake-2", messageId: kept.messageId! });
  expect(env.agentStore.getActiveMessages(thread.id).filter((m) => m.source === "monitor").length).toBe(1);
});

test("a wake on a kept message that throws again settles busy with that message: the delivery is not lost", async () => {
  const env = freshStoresEnv("md-deliver-refused-again-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const settled: Array<{ status: string; messageId?: string | null }> = [];
  const { d } = deps(env, { onWake: () => { throw new Error("database is locked"); } });
  await expect(deliverWakeMessage(d, {
    threadId: thread.id, reason: "watch", source: "watch", messageId: "msg_kept", render: () => "unused",
    settle: (r: { status: string; messageId?: string | null }) => { settled.push(r); }
  })).rejects.toThrow("database is locked");
  expect(settled).toStrictEqual([{ status: "busy", messageId: "msg_kept" }]);
});

test("a message the database refuses to append settles busy with no message, so the caller keeps its trigger for the retry", async () => {
  const env = freshStoresEnv("md-deliver-append-refused-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const settled: Array<{ status: string; messageId?: string | null }> = [];
  const { d, wakes } = deps(env);
  const append = env.agentStore.appendMessage.bind(env.agentStore);
  env.agentStore.appendMessage = (() => { throw new Error("database is locked"); }) as typeof env.agentStore.appendMessage;
  try {
    await expect(deliverWakeMessage(d, {
      threadId: thread.id, reason: "watch", source: "watch", messageId: null, render: () => "[Mandate watch event]",
      settle: (r: { status: string; messageId?: string | null }) => { settled.push(r); }
    })).rejects.toThrow("database is locked");
  } finally {
    env.agentStore.appendMessage = append;
  }
  expect(settled).toStrictEqual([{ status: "busy", messageId: null }]);
  expect(wakes).toStrictEqual([]);
});
