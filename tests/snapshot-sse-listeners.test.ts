import { afterEach, describe, expect, test } from "bun:test";
import { toast } from "sonner";
import { SSE_EVENTS, SSE_HEARTBEAT_EVENT } from "../src/shared/api-contracts.js";
import { attachSnapshotSseListeners } from "../src/client/lib/snapshot-sse-listeners.js";
import { useSnapshotStore } from "../src/client/store/snapshot.js";
import { useMonitorActivityStore } from "../src/client/store/monitor-activity.js";
import { useManagerThreadsStore } from "../src/client/store/manager-threads.js";
import { useAgentChatStore } from "../src/client/store/agent-chat.js";
import { useReasoningHeadingStore } from "../src/client/store/reasoning-heading.js";
import { useReplyActivityStore } from "../src/client/store/reply-activity.js";
import { useAgentPageStore } from "../src/client/store/agent-page.js";
import { onCleanup } from "./helpers/cleanup.js";
import { mockFetch } from "./helpers/fetch.js";

test("cleanup failure events do not become global banners", () => {
  const source = new EventTarget() as EventSource;
  useSnapshotStore.setState({ banner: "" });

  attachSnapshotSseListeners(source, {
    cancelled: () => false,
    setConnection: () => {},
    onReconnect: () => {}
  });

  dispatchJson(source, SSE_EVENTS.featureWorktreeCleanupFailed, {
    id: "feat_1",
    worktreePath: "/tmp/worktree",
    error: "remove failed"
  });
  dispatchJson(source, SSE_EVENTS.featureBranchCleanupFailed, {
    id: "feat_1",
    branch: "feature/demo",
    error: "delete failed"
  });
  dispatchJson(source, SSE_EVENTS.featureTerminalCleanupFailed, {
    id: "feat_1",
    windowName: "demo",
    error: "kill failed"
  });

  expect(useSnapshotStore.getState().banner).toBe("");
});

function dispatchJson(source: EventTarget, type: string, data: unknown): void {
  source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
}

test("Every successful SSE open notifies retained views even when connection stays open", () => {
  const source = new EventTarget() as EventSource;
  let cancelled = false;
  let opens = 0;
  const listener = () => { opens++; };
  window.addEventListener("mandate:sse-open", listener);
  useSnapshotStore.getState().setConnection("open");
  try {
    attachSnapshotSseListeners(source, {
      cancelled: () => cancelled,
      setConnection: useSnapshotStore.getState().setConnection,
      onReconnect() {}
    });
    source.dispatchEvent(new Event("open"));
    source.dispatchEvent(new Event("open"));
    expect(opens).toBe(2);
    cancelled = true;
    source.dispatchEvent(new Event("open"));
    expect(opens).toBe(2);
  } finally {
    window.removeEventListener("mandate:sse-open", listener);
    useSnapshotStore.getState().setConnection("idle");
  }
});

test("polling errors show a banner without marking the SSE transport disconnected", () => {
  const source = new EventTarget() as EventSource;
  const connections: string[] = [];
  attachSnapshotSseListeners(source, {
    cancelled: () => false, setConnection: (status) => connections.push(status), onReconnect() {}
  });
  dispatchJson(source, SSE_EVENTS.error, { message: "tmux unavailable" });
  expect(useSnapshotStore.getState().banner).toBe("tmux unavailable");
  expect(connections).toStrictEqual([]);
  // BannerToaster consumes the banner immediately. Repeated errors must not
  // repopulate it until a snapshot signals recovery.
  useSnapshotStore.getState().clearBanner();
  dispatchJson(source, SSE_EVENTS.error, { message: "tmux unavailable", at: "later" });
  expect(useSnapshotStore.getState().banner).toBe("");
  dispatchJson(source, SSE_EVENTS.snapshot, { sessions: [], counts: {} });
  expect(useSnapshotStore.getState().banner).toBe("");
  dispatchJson(source, SSE_EVENTS.error, { message: "tmux unavailable" });
  expect(useSnapshotStore.getState().banner).toBe("tmux unavailable");
  source.dispatchEvent(new Event("error"));
  expect(connections).toStrictEqual(["error"]);
  useSnapshotStore.setState({ snapshot: null, banner: "" });
});

test("a polling error sent as a bare string is the banner, verbatim", () => {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection() {}, onReconnect() {} });
  dispatchJson(source, SSE_EVENTS.error, "boom");
  expect(useSnapshotStore.getState().banner).toBe("boom");
  useSnapshotStore.setState({ snapshot: null, banner: "" });
});

test("transport activity includes heartbeats and unhandled events but excludes native errors and stale sources", () => {
  const source = new EventTarget() as EventSource;
  let cancelled = false;
  const activity: Array<number | undefined> = [];
  attachSnapshotSseListeners(source, {
    cancelled: () => cancelled, setConnection() {}, onReconnect() {},
    onActivity: (interval) => activity.push(interval)
  });
  source.dispatchEvent(new Event("open"));
  dispatchJson(source, SSE_HEARTBEAT_EVENT, { intervalMs: 60000 });
  dispatchJson(source, SSE_EVENTS.projectReordered, { ids: [] });
  dispatchJson(source, SSE_EVENTS.error, { message: "polling failed" });
  source.dispatchEvent(new Event("error"));
  expect(activity).toStrictEqual([undefined, 60000, undefined, undefined]);

  // A timestamp from an older server and invalid intervals still count as
  // activity, but cannot disable the watchdog or cause an immediate timeout.
  for (const data of [Date.now(), null, { intervalMs: -1 }, { intervalMs: "60000" }, { intervalMs: 0 }]) {
    dispatchJson(source, SSE_HEARTBEAT_EVENT, data);
    expect(activity.at(-1)).toBeUndefined();
  }
  const count = activity.length;
  cancelled = true;
  source.dispatchEvent(new Event("open"));
  dispatchJson(source, SSE_HEARTBEAT_EVENT, { intervalMs: 15000 });
  dispatchJson(source, SSE_EVENTS.projectReordered, { ids: [] });
  expect(activity).toHaveLength(count);
  useSnapshotStore.getState().clearBanner();
});

test("a canvas update over SSE reaches the page's canvas readers as mandate:canvas-updated", () => {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const seen: unknown[] = [];
  const listener = (event: Event) => { seen.push((event as CustomEvent).detail); };
  window.addEventListener("mandate:canvas-updated", listener);
  try {
    dispatchJson(source, SSE_EVENTS.canvasUpdated, { canvasId: "c-1", featureId: "f-1" });
    expect(seen).toStrictEqual([{ canvasId: "c-1", featureId: "f-1" }]);
  } finally {
    window.removeEventListener("mandate:canvas-updated", listener);
  }
});

test("a task record rewritten over SSE reaches the page's record rows as mandate:feature-record-updated", () => {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const seen: unknown[] = [];
  const listener = (event: Event) => { seen.push((event as CustomEvent).detail); };
  window.addEventListener("mandate:feature-record-updated", listener);
  try {
    dispatchJson(source, SSE_EVENTS.featureRecordUpdated, { featureId: "f-1" });
    expect(seen).toStrictEqual([{ featureId: "f-1" }]);
  } finally {
    window.removeEventListener("mandate:feature-record-updated", listener);
  }
});

// A worker restored, or moved to another thread, changes which canvases are a
// thread's: the Workers tabs that list them read them again.
test("a worker restored or moved over SSE reaches the page as mandate:thread-workers-changed", () => {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  let heard = 0;
  const listener = () => { heard += 1; };
  window.addEventListener("mandate:thread-workers-changed", listener);
  try {
    dispatchJson(source, SSE_EVENTS.featureOwnerChanged, { id: "f-1", ownerThreadId: "thr_b" });
    expect(heard).toBe(1);
    dispatchJson(source, SSE_EVENTS.featureRestored, { id: "f-2", projectId: "p-1", name: "rollback drill", ownerThreadId: "thr_b" });
    expect(heard).toBe(2);
  } finally {
    window.removeEventListener("mandate:thread-workers-changed", listener);
  }
});

// Every thread's waits reach the sidebar's store, not only those of the
// threads a page opened.
test("a monitors event reaches the store of what every thread waits on", () => {
  const source = new EventTarget() as EventSource;
  useMonitorActivityStore.setState({ waitingByThread: new Map(), listRevision: null });
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  dispatchJson(source, SSE_EVENTS.agentMonitorsChanged, {
    threadId: "thr_w", scope: "worker", scopeId: "feat_dispatcher", revision: { boot: 1, seq: 1 },
    monitors: [{ kind: "pane", id: "ww_dev", windowKey: "md-project-1:dispatcher", paneId: "%112", paneName: null, stableMs: 30_000, timeoutAt: "2026-10-09T10:21:00.000Z", note: "" }]
  });
  expect(useMonitorActivityStore.getState().waitingByThread.get("thr_w")).toMatchObject({ scope: "worker", scopeId: "feat_dispatcher", waitsOn: "pane" });
  useMonitorActivityStore.setState({ waitingByThread: new Map(), listRevision: null });
});

// A compaction asked for by hand fails about a minute after the command, when
// its reader may be typing or on another tab: it is told as a toast. One at a
// turn's gate surfaces through the failed turn and says nothing here.
test("a failed compaction is told when a person asked for it, and only then", () => {
  const shown: string[] = [];
  const original = toast.error;
  toast.error = ((message: unknown) => { shown.push(String(message)); return 0; }) as typeof toast.error;
  onCleanup(() => { toast.error = original; });
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });

  dispatchJson(source, SSE_EVENTS.agentCompressionFailed, { threadId: "thr_a", compressionId: "c1", status: "error", errorMessage: "upstream overloaded", reason: "before_model_call" });
  dispatchJson(source, SSE_EVENTS.agentCompressionFailed, { threadId: "thr_a", compressionId: "c2", status: "error", errorMessage: "upstream overloaded", reason: "manual" });
  dispatchJson(source, SSE_EVENTS.agentCompressionFailed, { threadId: "thr_a", compressionId: "c3", status: "error", reason: "manual" });
  expect(shown).toStrictEqual(["Couldn't compact: upstream overloaded", "Couldn't compact: unknown error"]);
});

test("each open's thread list reads the archived list too, and a deleted thread leaves it", async () => {
  const source = new EventTarget() as EventSource;
  const calls = mockFetch(() => Response.json({ archived: [
    { id: "thr_old", title: "project-1 cache expiry", archivedAt: "2026-10-13T09:00:00.000Z", workers: 1, canvases: 0 },
    { id: "thr_older", title: "project-2 flaky upload", archivedAt: "2026-10-12T09:00:00.000Z", workers: 0, canvases: 0 }
  ] }));
  onCleanup(() => useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false }));
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  dispatchJson(source, SSE_EVENTS.managerThreads, { threads: [] });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual(["GET /api/agents/manager/threads?archived=1"]);
  expect(useManagerThreadsStore.getState().archived.map((t) => t.id)).toEqual(["thr_old", "thr_older"]);
  dispatchJson(source, SSE_EVENTS.managerThreadDeleted, { threadId: "thr_old" });
  expect(useManagerThreadsStore.getState().archived.map((t) => t.id)).toEqual(["thr_older"]);
});

// What the working line reads per wake: the heading its reasoning reached and
// when its reply last moved.
describe("per-wake marks", () => {
  afterEach(() => {
    useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
    useReasoningHeadingStore.setState({ byWake: new Map() });
    useReplyActivityStore.setState({ byWake: new Map() });
  });

  const at = "2026-10-01T09:00:00.000Z";

  /** A source with the listeners on it, and a way to send it an event. */
  function listening() {
    const source = new EventTarget() as EventSource;
    attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
    return { source, send: (event: string, data: unknown) => dispatchJson(source, event, data) };
  }

  test("over SSE: a heading comes in, a finished wake's goes, and a reconnect drops them all", () => {
    const { source, send } = listening();
    send("agentReasoningHeading", { threadId: "t1", wakeId: "w1", heading: "Gathering merged changes" });
    expect(useReasoningHeadingStore.getState().byWake.get("w1")).toBe("Gathering merged changes");
    send("agentWakeFinished", { threadId: "t1", wakeId: "w1", status: "finished", errorMessage: null, contextUsage: null });
    expect(useReasoningHeadingStore.getState().byWake.has("w1")).toBe(false);
    // A wake that finished while the stream was down never says so: a reconnect drops what is left.
    send("agentReasoningHeading", { threadId: "t1", wakeId: "w2", heading: "Checking the changelog format" });
    source.dispatchEvent(new Event("open"));
    expect(useReasoningHeadingStore.getState().byWake.size).toBe(0);
  });

  test("over SSE: a step's own message ends its heading, so the gap before the next step says Working", () => {
    const { send } = listening();
    const message = (id: string, role: string, wakeId: string | null) =>
      ({ id, threadId: "t1", seq: 2, role, source: role === "assistant" ? "agent" : "user", sourceThreadId: null, wakeId, createdAt: at, content: { type: "text", text: "x" } });
    send("agentReasoningHeading", { threadId: "t1", wakeId: "w1", heading: "Checking the changelog format" });
    send("agentReasoningHeading", { threadId: "t1", wakeId: "w2", heading: "Gathering merged changes" });
    // Not this step's end: a person's message, another wake's step.
    send("agentMessageAppended", { threadId: "t1", message: message("m2", "user", null) });
    send("agentMessageAppended", { threadId: "t1", message: message("m3", "assistant", "w2") });
    expect([useReasoningHeadingStore.getState().byWake.get("w1"), useReasoningHeadingStore.getState().byWake.has("w2")]).toEqual(["Checking the changelog format", false]);
    // This wake's step ends.
    send("agentMessageAppended", { threadId: "t1", message: message("m4", "assistant", "w1") });
    expect(useReasoningHeadingStore.getState().byWake.has("w1")).toBe(false);
  });

  test("over SSE: a reply's text marks when it last moved; a finished wake's mark goes, and a reconnect drops them all", () => {
    const { source, send } = listening();
    const before = Date.now();
    send("agentMessagePatch", { threadId: "t1", wakeId: "w1", offset: 0, deltaText: "I'll run" });
    send("agentMessagePatch", { threadId: "t1", wakeId: "w2", offset: 0, deltaText: "Look" });
    // A patch that adds nothing is not movement.
    send("agentMessagePatch", { threadId: "t1", wakeId: "w3", offset: 0, deltaText: "" });
    const moved = useReplyActivityStore.getState().byWake;
    expect([moved.get("w1")! >= before, moved.get("w2")! >= before, moved.has("w3")]).toEqual([true, true, false]);
    send("agentWakeFinished", { threadId: "t1", wakeId: "w1", status: "finished", errorMessage: null, contextUsage: null });
    expect(useReplyActivityStore.getState().byWake.has("w1")).toBe(false);
    source.dispatchEvent(new Event("open"));
    expect(useReplyActivityStore.getState().byWake.size).toBe(0);
  });
});

// Your agent's page: its own events, and the events that change its built-in data.
test("the page's events reach its store; the events that change its built-ins ask for them again", () => {
  const source = new EventTarget() as EventSource;
  const store = useAgentPageStore.getState();
  const applied: unknown[] = [];
  const kinds: string[] = [];
  useAgentPageStore.setState({
    applyState: (state) => { applied.push(["state", state]); },
    applySource: (event) => { applied.push(["source", event]); },
    onEvent: (kind) => { kinds.push(kind); }
  });
  try {
    attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
    const state = { latest: null, write: null };
    dispatchJson(source, SSE_EVENTS.agentPageUpdated, { state });
    dispatchJson(source, SSE_EVENTS.agentPageSourceChanged, { name: "prom", source: null, data: null });
    dispatchJson(source, SSE_EVENTS.agentPageAnswer, { answer: { id: "pga_1", value: 1, at: "x", read: false } });
    expect(applied).toStrictEqual([["state", state], ["source", { name: "prom", source: null, data: null }]]);
    dispatchJson(source, SSE_EVENTS.globalAgentUpdated, { agent: { threadId: "thr_g", name: "", named: false, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } });
    dispatchJson(source, SSE_EVENTS.canvasUpdated, { canvasId: "c-1", featureId: null });
    dispatchJson(source, SSE_EVENTS.managerThreadDeleted, { threadId: "thr_x" });
    // A worker archived with no work item event: the worker lists change too.
    dispatchJson(source, SSE_EVENTS.featureArchived, { id: "feat_x", projectId: "proj_x" });
    // A project archived takes its workers: no event of theirs.
    dispatchJson(source, SSE_EVENTS.projectArchived, { id: "proj_x" });
    expect(kinds).toStrictEqual(["answers", "questions", "canvases", "work", "work", "work"]);
  } finally {
    useAgentPageStore.setState({ applyState: store.applyState, applySource: store.applySource, onEvent: store.onEvent });
  }
});
