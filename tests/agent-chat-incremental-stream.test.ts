import { afterEach, beforeEach, expect, test } from "bun:test";
import { useAgentChatStore, newThreadState, type AgentMessage } from "../src/client/store/agent-chat.js";
import { attachSnapshotSseListeners } from "../src/client/lib/snapshot-sse-listeners.js";

const original = useAgentChatStore.getState();
const originalFetch = globalThis.fetch;
beforeEach(() => useAgentChatStore.setState({
  ...original, threadsByScope: new Map(), messageStreams: new Map(), sideThread: null
}, true));
afterEach(() => { useAgentChatStore.setState(original, true); globalThis.fetch = originalFetch; });
const state = () => useAgentChatStore.getState();
const patch = (deltaText: string, offset = 0, threadId = "t1", wakeId = "w1") => state().onMessagePatch({ threadId, wakeId, offset, deltaText });
const thread = () => state().threadsByScope.get("manager")!;
const message: AgentMessage = { id: "m1", threadId: "t1", wakeId: "w1", seq: 1, role: "assistant", source: "self", sourceThreadId: null, content: { type: "assistant", text: "step one" }, createdAt: "2026-09-13" };
function load() {
  useAgentChatStore.setState({ threadsByScope: new Map([["manager", { ...newThreadState(), threadId: "t1" }]]) });
}

test("patches received before/during initial history load are present as soon as the conversation opens", async () => {
  let respond!: (response: Response) => void;
  globalThis.fetch = (async () => new Promise<Response>((resolve) => { respond = resolve; })) as unknown as typeof fetch;
  patch("Hello");
  const loading = state().ensureThreadLoaded({ type: "manager" });
  patch(" world", 5);
  respond(Response.json({ thread: { id: "t1" }, messages: [], hasMore: false }));
  await loading;
  expect(thread().streamingAssistant?.totalText).toBe("Hello world");
  state().onMessageAppended("t1", message);
  expect(thread().streamingAssistant).toBeNull();
  expect(state().messageStreams.size).toBe(0);
  // The next model step can share a wake and a prefix with its predecessor.
  patch("Hello world, next step");
  expect(thread().streamingAssistant?.totalText).toBe("Hello world, next step");
});

test("reconnect history from an earlier step cannot erase the restored active step", async () => {
  load();
  state().onMessageStreams([{ threadId: "t1", wakeId: "w1", totalText: "step two" }]);
  globalThis.fetch = (async () => Response.json({ thread: { id: "t1" }, messages: [message] })) as unknown as typeof fetch;
  await state().refetchIncrementalForOpenScopes();
  expect(thread().messages).toHaveLength(1);
  expect(thread().streamingAssistant?.totalText).toBe("step two");
  patch(" continues", 8);
  expect(thread().streamingAssistant?.totalText).toBe("step two continues");
  state().onMessageStreams([]);
  expect(thread().streamingAssistant).toBeNull();
  expect(state().messageStreams.size).toBe(0);
});

test("a live completion clears a duplicate bubble when history arrived first, for main and side", () => {
  load();
  useAgentChatStore.setState({ sideThread: { ...newThreadState(), threadId: "side" } });
  for (const threadId of ["t1", "side"]) {
    const completed = { ...message, threadId };
    patch("step one", 0, threadId);
    state().onMessageAppended(threadId, completed, true);
    const current = () => threadId === "t1" ? thread() : state().sideThread!;
    expect(current().messages).toHaveLength(1);
    expect(current().streamingAssistant?.totalText).toBe("step one");
    state().onMessageAppended(threadId, completed);
    expect(current().messages).toHaveLength(1);
    expect(current().streamingAssistant).toBeNull();
    expect(state().messageStreams.has(threadId)).toBe(false);
  }
});

test("side streams assemble separately, survive catch-up, and clear on cancel", async () => {
  load();
  useAgentChatStore.setState({ sideThread: { ...newThreadState(), threadId: "side" } });
  patch("main");
  patch("side", 0, "side", "side-wake");
  const requests: string[] = [];
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    return Response.json({ thread: { id: "side" }, messages: String(url).includes("/threads/side") ? [{ ...message, threadId: "side", wakeId: "side-wake" }] : [] });
  }) as unknown as typeof fetch;
  await state().refetchIncrementalForOpenScopes();
  expect(requests).toContain("/api/agents/threads/side?limit=50&since=0");
  expect(state().sideThread?.messages).toHaveLength(1);
  expect(state().sideThread?.streamingAssistant?.totalText).toBe("side");
  state().onWakeFinished("side", "side-wake", "canceled");
  expect(state().sideThread?.streamingAssistant).toBeNull();
  expect(state().messageStreams.has("side")).toBe(false);
  expect(thread().streamingAssistant?.totalText).toBe("main");
});

test("fallback reset, duplicate patch, and missing baseline do not corrupt text", () => {
  load();
  patch("wrong");
  patch("");
  expect(thread().streamingAssistant?.totalText).toBe("");
  patch("right");
  patch(" answer", 5);
  patch(" answer", 5);
  expect(thread().streamingAssistant?.totalText).toBe("right answer");
  expect(patch("lost", 99)).toBe(false);
  expect(patch("lost", 12, "t1", "other-wake")).toBe(false);
  expect(thread().streamingAssistant?.totalText).toBe("right answer");
});

test("EventSource decoding requests resynchronization for a gap and restores from the next snapshot", () => {
  load();
  const source = new EventTarget() as EventSource;
  let reconnects = 0;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection() {}, onReconnect() {}, onStreamDesync: () => { reconnects++; } });
  const emit = (event: string, data: unknown) => source.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  emit("agentMessagePatch", { threadId: "t1", wakeId: "w1", offset: 8, deltaText: "tail" });
  expect(reconnects).toBe(1);
  emit("agentMessageStreams", { streams: [{ threadId: "t1", wakeId: "w1", totalText: "restored" }] });
  emit("agentMessagePatch", { threadId: "t1", wakeId: "w1", offset: 8, deltaText: " tail" });
  expect(thread().streamingAssistant?.totalText).toBe("restored tail");
  source.dispatchEvent(new Event("open"));
  expect(thread().streamingAssistant).toBeNull();
  // A new client still understands an older server's cumulative events.
  emit("agentMessageDelta", { threadId: "t1", wakeId: "w1", deltaText: "legacy", totalText: "legacy" });
  expect(thread().streamingAssistant?.totalText).toBe("legacy");
});
