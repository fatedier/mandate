import { afterEach, expect, setSystemTime, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "../helpers/fixtures.js";
import { saidAfterNotices, startSpokenUpdateSource } from "../../src/server/modules/voice/spoken-updates.js";
import { AgentSseEmitter } from "../../src/server/modules/sse/sse-events.js";
import { SSE_EVENTS } from "../../src/shared/api-contracts.js";

let env: StoresEnv | null = null;
afterEach(() => { setSystemTime(); env?.cleanup(); env = null; });

const LONG_AGO = "2000-01-01T00:00:00.000Z";

// With voice on, the user hears what the agent itself said after it was woken
// by a notice or by a look it set, not the thread's
// raw reply; an answer to something they just asked is spoken by voice already.
test("only turns a notice or an alarm started count, each by the last thing it said; long words are not cut here", () => {
  env = freshStoresEnv("md-spoken-said-");
  const store = env.agentStore;
  const g = store.getOrCreateGlobalThread().id;
  const turn = (reason: "thread-notice" | "user" | "alarm", texts: string[]) => {
    const wake = store.createWake({ threadId: g, reason, triggerMessageId: null });
    for (const text of texts) store.appendMessage({ threadId: g, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text, toolCalls: [] } });
    store.finishWake(wake.id, "finished", null);
    return wake.id;
  };
  const noticed = turn("thread-notice", ["I will take a look.", "The search timeout is fixed."]);
  turn("user", ["This one answers you."]);
  const silent = turn("alarm", ["   "]);
  const looked = turn("alarm", ["It is still running; I will look again later."]);
  // Longer than a spoken update may be (300): cutting is the source's, once.
  const wordy = "Changed three places.".repeat(80);
  const reported = turn("thread-notice", [wordy]);
  expect(saidAfterNotices(store, g, { since: LONG_AGO })).toEqual([
    { key: `said:${noticed}`, text: "The search timeout is fixed." },
    { key: `said:${looked}`, text: "It is still running; I will look again later." },
    { key: `said:${reported}`, text: wordy }
  ]);
  expect(saidAfterNotices(store, g, { wakeId: noticed })).toEqual([{ key: `said:${noticed}`, text: "The search timeout is fixed." }]);
  expect(saidAfterNotices(store, g, { wakeId: silent })).toEqual([]);
  expect(saidAfterNotices(store, g, { since: "2999-01-01T00:00:00.000Z" })).toEqual([]);
});

// A result that woke the agent is news nobody asked for in that moment: what
// the agent said about it is spoken, as after a notice.
test("a turn a subagent's result started counts, by the last thing it said", () => {
  env = freshStoresEnv("md-spoken-said-");
  const store = env.agentStore;
  const g = store.getOrCreateGlobalThread().id;
  const wake = store.createWake({ threadId: g, reason: "subagent-result", triggerMessageId: null });
  store.appendMessage({ threadId: g, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Both call sites are in the wake path.", toolCalls: [] } });
  store.finishWake(wake.id, "finished", null);
  expect(saidAfterNotices(store, g, { wakeId: wake.id })).toEqual([{ key: `said:${wake.id}`, text: "Both call sites are in the wake path." }]);
});

// What a turn said is its last words once it has ended. Read while it runs,
// "I'll take a look" would stand for the result, and the result would then
// count as told.
test("a turn still running has said nothing yet; once it ends, its last words", () => {
  env = freshStoresEnv("md-spoken-said-");
  const store = env.agentStore;
  const g = store.getOrCreateGlobalThread().id;
  const wake = store.createWake({ threadId: g, reason: "thread-notice", triggerMessageId: null });
  const say = (text: string) => store.appendMessage({ threadId: g, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text, toolCalls: [] } });
  say("I will take a look.");
  expect(saidAfterNotices(store, g, { since: LONG_AGO })).toEqual([]);
  say("The search timeout is fixed.");
  store.finishWake(wake.id, "finished", null);
  expect(saidAfterNotices(store, g, { since: LONG_AGO })).toEqual([{ key: `said:${wake.id}`, text: "The search timeout is fixed." }]);
});

// A session's provider takes a moment to open. A turn that ends in that
// moment sends its event to nobody, and its last words may be older than the
// moment voice was turned on (a tool call came after them).
test("a turn counts from when it ended, not from when its last words were written", () => {
  env = freshStoresEnv("md-spoken-said-");
  const store = env.agentStore;
  const g = store.getOrCreateGlobalThread().id;
  setSystemTime(new Date("2026-10-11T10:00:00.000Z"));
  const wake = store.createWake({ threadId: g, reason: "alarm", triggerMessageId: null });
  store.appendMessage({ threadId: g, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "It is still running; I will look again later.", toolCalls: [] } });
  setSystemTime(new Date("2026-10-11T10:00:10.000Z"));
  store.finishWake(wake.id, "finished", null);
  expect(saidAfterNotices(store, g, { since: "2026-10-11T10:00:05.000Z" })).toEqual([{ key: `said:${wake.id}`, text: "It is still running; I will look again later." }]);
  expect(saidAfterNotices(store, g, { since: "2026-10-11T10:00:10.000Z" })).toEqual([{ key: `said:${wake.id}`, text: "It is still running; I will look again later." }]);
  expect(saidAfterNotices(store, g, { since: "2026-10-11T10:00:10.001Z" })).toEqual([]);
});

test("a session that opens while a notice's turn runs hears that turn's last words, once, when it ends", () => {
  env = freshStoresEnv("md-spoken-said-");
  const store = env.agentStore;
  const g = store.getOrCreateGlobalThread().id;
  const sse = new AgentSseEmitter();
  const subscribe = startSpokenUpdateSource({
    sse,
    waiting: () => [],
    globalThreadId: () => g,
    saidAfter: (query) => saidAfterNotices(store, g, query)
  });
  const wake = store.createWake({ threadId: g, reason: "thread-notice", triggerMessageId: null });
  const say = (text: string) => store.appendMessage({ threadId: g, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text, toolCalls: [] } });
  say("I will take a look.");
  const heard: string[] = [];
  const stop = subscribe((text) => heard.push(text), { since: LONG_AGO, heard: new Set() });
  expect(heard).toStrictEqual([]);
  say("The search timeout is fixed.");
  store.finishWake(wake.id, "finished", null);
  sse.emit(SSE_EVENTS.agentWakeFinished, { threadId: g, wakeId: wake.id, status: "finished" });
  sse.emit(SSE_EVENTS.agentWakeFinished, { threadId: g, wakeId: wake.id, status: "finished" });
  expect(heard).toStrictEqual(["The search timeout is fixed."]);
  stop();
});
