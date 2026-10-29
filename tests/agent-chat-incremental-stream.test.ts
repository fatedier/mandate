import { afterEach, beforeEach, expect, test } from "bun:test";
import { useAgentChatStore, newThreadState, type AgentMessage } from "../src/client/store/agent-chat.js";
import { attachSnapshotSseListeners } from "../src/client/lib/snapshot-sse-listeners.js";
import { mockFetch } from "./helpers/fetch.js";

const original = useAgentChatStore.getState();
beforeEach(() => useAgentChatStore.setState({
  ...original, threadsByScope: new Map(), messageStreams: new Map()
}, true));
afterEach(() => { useAgentChatStore.setState(original, true); });
const state = () => useAgentChatStore.getState();
const patch = (deltaText: string, offset = 0, threadId = "t1", wakeId = "w1") => state().onMessagePatch({ threadId, wakeId, offset, deltaText });
const thread = () => state().threadsByScope.get("manager:t1")!;
const message: AgentMessage = { id: "m1", threadId: "t1", wakeId: "w1", seq: 1, role: "assistant", source: "self", sourceThreadId: null, content: { type: "assistant", text: "step one" }, createdAt: "2026-09-13" };
function load() {
  useAgentChatStore.setState({ threadsByScope: new Map([["manager:t1", { ...newThreadState(), threadId: "t1" }]]) });
}
function openWorker() {
  useAgentChatStore.setState((s) => ({
    threadsByScope: new Map(s.threadsByScope).set("worker:f1", { ...newThreadState(), threadId: "t2" })
  }));
}

test("patches received before/during initial history load are present as soon as the conversation opens", async () => {
  let respond!: (response: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => { respond = resolve; }));
  patch("Hello");
  const loading = state().ensureThreadLoaded({ type: "manager", threadId: "t1" });
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
  mockFetch(() => Response.json({ thread: { id: "t1" }, messages: [message] }));
  await state().refetchIncrementalForOpenScopes();
  expect(thread().messages).toHaveLength(1);
  expect(thread().streamingAssistant?.totalText).toBe("step two");
  patch(" continues", 8);
  expect(thread().streamingAssistant?.totalText).toBe("step two continues");
  state().onMessageStreams([]);
  expect(thread().streamingAssistant).toBeNull();
  expect(state().messageStreams.size).toBe(0);
});

test("a live completion clears a duplicate bubble when history arrived first, for manager and worker", () => {
  load();
  openWorker();
  for (const threadId of ["t1", "t2"]) {
    const completed = { ...message, threadId };
    patch("step one", 0, threadId);
    state().onMessageAppended(threadId, completed, true);
    const current = () => state().threadsByScope.get(threadId === "t1" ? "manager:t1" : "worker:f1")!;
    expect(current().messages).toHaveLength(1);
    expect(current().streamingAssistant?.totalText).toBe("step one");
    state().onMessageAppended(threadId, completed);
    expect(current().messages).toHaveLength(1);
    expect(current().streamingAssistant).toBeNull();
    expect(state().messageStreams.has(threadId)).toBe(false);
  }
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
});
