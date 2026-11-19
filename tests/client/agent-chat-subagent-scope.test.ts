import { afterEach, expect, jest, test } from "bun:test";
import { newThreadState, RELEASE_AFTER_MS, scopeFromKey, scopeKey, useAgentChatStore, type AgentChatScope } from "@/store/agent-chat";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { agentMessage } from "../helpers/typed.js";
import { fakeClock, realClock } from "../helpers/fake-clock.js";

// A subagent's conversation is read on the page as a chat scope of its own,
// so its live events land in it (the store drops events for a thread it has
// not loaded), and nothing is ever sent to it.

afterEach(() => { useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() }); });
const state = () => useAgentChatStore.getState();
const step = (threadId: string, id: string, seq: number) => agentMessage({
  id, threadId, seq, role: "assistant", source: "self", wakeId: "w_child",
  content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `call-${id}`, toolName: "read", args: { path: "/repo/CHANGELOG.md" } }] }
});
const page = (threadId: string, messages = [step(threadId, "m1", 1)]) =>
  ({ thread: { id: threadId }, messages, hasMore: false, contextUsage: null, activeWake: null, readAt: null });

test("its page is read by its thread's id, and a live step lands in it; before it was loaded the same step was dropped", async () => {
  const scope: AgentChatScope = { type: "subagent", threadId: "thr_child_s1" };
  state().onMessageAppended("thr_child_s1", step("thr_child_s1", "early", 1));
  expect(state().threadsByScope.size).toBe(0);
  const calls = mockFetch(() => jsonResponse(page("thr_child_s1")));
  await state().ensureThreadLoaded(scope);
  expect(calls[0]!.url).toBe("/api/agents/threads/thr_child_s1?limit=50");
  state().onMessageAppended("thr_child_s1", step("thr_child_s1", "m2", 2));
  expect(state().threadsByScope.get(scopeKey(scope))!.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  // The read on from the page's top settles before the next test.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("its key reads back as its scope, so a reconnect reads it again from where it stood", async () => {
  expect(scopeFromKey("subagent:thr_child_s2")).toEqual({ type: "subagent", threadId: "thr_child_s2" });
  useAgentChatStore.setState({ threadsByScope: new Map([["subagent:thr_child_s2", {
    ...newThreadState(), threadId: "thr_child_s2", loaded: true, messages: [step("thr_child_s2", "m4", 4)]
  }]]) });
  const calls = mockFetch(() => jsonResponse(page("thr_child_s2", [])));
  await state().refetchIncrementalForOpenScopes();
  expect(calls.map((c) => c.url)).toStrictEqual(["/api/agents/threads/thr_child_s2?limit=50&since=4"]);
});

test("nothing is sent to it: a send fails at once, with no request and no pending message; nor is a question skipped there", async () => {
  const scope: AgentChatScope = { type: "subagent", threadId: "thr_child_s3" };
  const calls = mockFetch(() => jsonResponse({}));
  expect(await state().sendMessage(scope, "Hello")).toBe("failed");
  expect(await state().skipQuestion(scope, "q1")).toBe("A subagent's conversation is read only.");
  expect(calls).toHaveLength(0);
  expect(state().threadsByScope.get(scopeKey(scope))?.pendingUserMessages.size ?? 0).toBe(0);
});

test("no turn of it is retried or stopped from the page: its task's Stop is the one way to stop it", async () => {
  const scope: AgentChatScope = { type: "subagent", threadId: "thr_child_s4" };
  useAgentChatStore.setState({ threadsByScope: new Map([[scopeKey(scope), {
    ...newThreadState(), threadId: "thr_child_s4", loaded: true, messages: [step("thr_child_s4", "m1", 1)],
    wakePhase: { ...newThreadState().wakePhase, wakeId: "w_child", phase: "thinking" }
  }]]) });
  const calls = mockFetch(() => jsonResponse({}));
  await state().retryWake(scope, "w_child");
  await state().cancelWake(scope);
  expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual([]);
  expect(state().threadsByScope.get(scopeKey(scope))!.wakePhase.phase).toBe("thinking");
});

// Its steps are read whole (TaskSteps): a live step past the page's cap on a
// conversation's messages drops none of them, or the steps would be read
// again at every step it takes.
test("a live step past the cap on a conversation's messages keeps every step it had", () => {
  const steps = Array.from({ length: 500 }, (_, i) => step("thr_child_s5", `m${i + 1}`, i + 1));
  const scope: AgentChatScope = { type: "subagent", threadId: "thr_child_s5" };
  const other: AgentChatScope = { type: "manager", threadId: "thr_m_s5" };
  const manager = Array.from({ length: 500 }, (_, i) => step("thr_m_s5", `p${i + 1}`, i + 1));
  useAgentChatStore.setState({ threadsByScope: new Map([
    [scopeKey(scope), { ...newThreadState(), threadId: "thr_child_s5", loaded: true, messages: steps, oldestSeqLoaded: 1 }],
    [scopeKey(other), { ...newThreadState(), threadId: "thr_m_s5", loaded: true, messages: manager, oldestSeqLoaded: 1 }]
  ]) });
  state().onMessageAppended("thr_child_s5", step("thr_child_s5", "m501", 501));
  state().onMessageAppended("thr_m_s5", step("thr_m_s5", "p501", 501));
  const child = state().threadsByScope.get(scopeKey(scope))!;
  expect([child.messages.length, child.messages[0]!.id, child.hasMoreOlder]).toEqual([501, "m1", false]);
  // The control: another conversation keeps its window.
  const parent = state().threadsByScope.get(scopeKey(other))!;
  expect([parent.messages.length, parent.messages[0]!.id, parent.hasMoreOlder]).toEqual([500, "p2", true]);
});

// A subagent's conversation is held by the views that show it (its steps,
// its live line) and let go a while after none does: kept, every one opened
// in a session stayed in memory and was read again at each reconnect.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The timers faked from here on, put back after the test. */
function fakeTimers() {
  fakeClock();
}
const has = (scope: AgentChatScope) => state().threadsByScope.has(scopeKey(scope));

test("a subagent's conversation no view holds is let go a while after: its entry goes, and a reconnect does not read it again", async () => {
  const scope: AgentChatScope = { type: "subagent", threadId: "thr_child_s5" };
  mockFetch(() => jsonResponse(page("thr_child_s5")));
  const release = state().holdThread(scope);
  await state().ensureThreadLoaded(scope);
  await tick();
  fakeTimers();
  release();
  jest.advanceTimersByTime(RELEASE_AFTER_MS - 1);
  // Opened again before then, it would be drawn from what is kept.
  expect(has(scope)).toBe(true);
  jest.advanceTimersByTime(1);
  expect(has(scope)).toBe(false);
  const calls = mockFetch(() => jsonResponse(page("thr_child_s5", [])));
  await state().refetchIncrementalForOpenScopes();
  expect(calls).toStrictEqual([]);
});

test("held by two views it stays until both let go; held again meanwhile, it stays", async () => {
  const scope: AgentChatScope = { type: "subagent", threadId: "thr_child_s6" };
  mockFetch(() => jsonResponse(page("thr_child_s6")));
  const first = state().holdThread(scope);
  const second = state().holdThread(scope);
  await state().ensureThreadLoaded(scope);
  await tick();
  fakeTimers();
  // Let go twice by one view: once.
  first();
  first();
  jest.advanceTimersByTime(RELEASE_AFTER_MS);
  expect(has(scope)).toBe(true);
  second();
  jest.advanceTimersByTime(RELEASE_AFTER_MS / 2);
  const again = state().holdThread(scope);
  jest.advanceTimersByTime(RELEASE_AFTER_MS);
  expect(has(scope)).toBe(true);
  again();
  jest.advanceTimersByTime(RELEASE_AFTER_MS);
  expect(has(scope)).toBe(false);
});

test("closed, opened again and closed, it is kept a whole while from the last close", async () => {
  const scope: AgentChatScope = { type: "subagent", threadId: "thr_child_s8" };
  mockFetch(() => jsonResponse(page("thr_child_s8")));
  const first = state().holdThread(scope);
  await state().ensureThreadLoaded(scope);
  await tick();
  fakeTimers();
  first();
  jest.advanceTimersByTime(30_000);
  const second = state().holdThread(scope);
  jest.advanceTimersByTime(10_000);
  second();
  jest.advanceTimersByTime(RELEASE_AFTER_MS - 1);
  expect(has(scope)).toBe(true);
  jest.advanceTimersByTime(1);
  expect(has(scope)).toBe(false);
});

test("let go while its first page is on its way, it goes on time: the page landing later does not bring it back, and a view opening it again reads it anew", async () => {
  const scope: AgentChatScope = { type: "subagent", threadId: "thr_child_s7" };
  const answers: Array<(response: Response) => void> = [];
  const calls = mockFetch((call) => call.url.includes("since=")
    ? jsonResponse(page("thr_child_s7", []))
    : new Promise<Response>((resolve) => { answers.push(resolve); }));
  const release = state().holdThread(scope);
  const load = state().ensureThreadLoaded(scope);
  fakeTimers();
  release();
  jest.advanceTimersByTime(RELEASE_AFTER_MS);
  expect(has(scope)).toBe(false);
  // Opened again: a read of its own, not the one let go with it.
  const again = state().holdThread(scope);
  const reload = state().ensureThreadLoaded(scope);
  expect(calls.filter((c) => !c.url.includes("since="))).toHaveLength(2);
  answers[1]!(jsonResponse(page("thr_child_s7", [step("thr_child_s7", "m9", 9)])));
  await reload;
  const readsOn = calls.filter((c) => c.url.includes("since=")).length;
  // The first read lands last: nothing of it is written, and it reads nothing on.
  answers[0]!(jsonResponse(page("thr_child_s7")));
  await load;
  await Promise.resolve();
  expect(state().threadsByScope.get(scopeKey(scope))!.messages.map((m) => m.id)).toEqual(["m9"]);
  expect(calls.filter((c) => c.url.includes("since="))).toHaveLength(readsOn);
  again();
});

test("an older page on its way when it was let go is not written into it once it is read again", async () => {
  const id = "thr_child_s9";
  const scope: AgentChatScope = { type: "subagent", threadId: id };
  let older!: (response: Response) => void;
  mockFetch((call) => call.url.includes("before=")
    ? new Promise<Response>((resolve) => { older = resolve; })
    : call.url.includes("since=")
      ? jsonResponse(page(id, []))
      : jsonResponse({ ...page(id, [step(id, "m51", 51)]), hasMore: true }));
  const release = state().holdThread(scope);
  await state().ensureThreadLoaded(scope);
  await tick();
  const olderLoad = state().loadOlder(scope);
  fakeTimers();
  release();
  jest.advanceTimersByTime(RELEASE_AFTER_MS);
  realClock();
  // Read again, onto newer messages.
  mockFetch((call) => call.url.includes("since=") ? jsonResponse(page(id, [])) : jsonResponse({ ...page(id, [step(id, "m101", 101)]), hasMore: true }));
  const again = state().holdThread(scope);
  await state().ensureThreadLoaded(scope);
  older(jsonResponse({ ...page(id, [step(id, "m1", 1)]), hasMore: false }));
  await olderLoad.catch(() => {});
  await tick();
  expect(state().threadsByScope.get(scopeKey(scope))!).toMatchObject({ oldestSeqLoaded: 101, hasMoreOlder: true });
  expect(state().threadsByScope.get(scopeKey(scope))!.messages.map((m) => m.id)).toEqual(["m101"]);
  again();
});

test("a catch-up read still on its way does not hold it past its while", async () => {
  const id = "thr_child_s10";
  const scope: AgentChatScope = { type: "subagent", threadId: id };
  let since!: (response: Response) => void;
  mockFetch((call) => call.url.includes("since=")
    ? new Promise<Response>((resolve) => { since = resolve; })
    : jsonResponse(page(id)));
  const first = state().holdThread(scope);
  await state().ensureThreadLoaded(scope);
  // Shown again: a catch-up read goes out, and stalls.
  void state().ensureThreadLoaded(scope);
  fakeTimers();
  first();
  jest.advanceTimersByTime(RELEASE_AFTER_MS);
  expect(has(scope)).toBe(false);
  realClock();
  // Read again, onto newer messages, before the stalled read lands.
  mockFetch((call) => call.url.includes("since=") ? jsonResponse(page(id, [])) : jsonResponse({ ...page(id, [step(id, "m101", 101)]), hasMore: true }));
  const again = state().holdThread(scope);
  await state().ensureThreadLoaded(scope);
  since(jsonResponse(page(id, [step(id, "m2", 2)])));
  await tick();
  await tick();
  expect(state().threadsByScope.get(scopeKey(scope))!.messages.map((m) => m.id)).toEqual(["m101"]);
  again();
});
