import { expect, test } from "bun:test";
import { act, useEffect } from "react";
import type { StoreApi } from "zustand";
import { useSnapshotSubscription } from "../src/client/hooks/useSnapshotSubscription.js";
import { useAgentChatStore } from "../src/client/store/agent-chat.js";
import { useManagerThreadsStore } from "../src/client/store/manager-threads.js";
import { useSnapshotStore } from "../src/client/store/snapshot.js";
import { useProjectsStore } from "../src/client/store/projects.js";
import { useWakeActivityStore } from "../src/client/store/wake-activity.js";
import { useWorkItemsStore } from "../src/client/store/work-items.js";
import { useBackgroundTasksStore } from "../src/client/store/background-tasks.js";
import { mockFetch } from "./helpers/fetch.js";
import { mountAsync, type Mounted } from "./helpers/mount.js";

const manager = { type: "manager" as const, threadId: "manager-thread" };
/** The subscription, and the thread loaded the way an open conversation
 *  (ChatConversation) loads it. */
function App() {
  useSnapshotSubscription();
  useEffect(() => { void useAgentChatStore.getState().ensureThreadLoaded(manager); }, []);
  return null;
}
/** Saves a store's state now; the returned function puts it back. */
function saveState<S>(store: StoreApi<S>): () => void {
  const saved = store.getState();
  return () => store.setState(saved, true);
}

test("SSE boot hydrates once and reconnect still pulls messages, work items and wakes", async () => {
  const originalSource = globalThis.EventSource;
  const restores = [
    saveState(useAgentChatStore), saveState(useSnapshotStore), saveState(useProjectsStore),
    saveState(useWakeActivityStore), saveState(useWorkItemsStore), saveState(useManagerThreadsStore), saveState(useBackgroundTasksStore)
  ];
  useAgentChatStore.setState({ threadsByScope: new Map() });
  useSnapshotStore.setState({ snapshot: null, banner: "", connection: "idle" });
  useProjectsStore.setState({ projects: [] });
  useWorkItemsStore.setState({ items: new Map() });
  // A conversation whose background tasks were read: every open reads them again.
  useBackgroundTasksStore.setState({ byThread: new Map([["manager-thread", []]]) });
  const requests: string[] = [];
  let source!: FakeSource;
  let finishThread!: (response: Response) => void;
  const message = (seq: number) => ({ id: `m-${seq}`, threadId: "manager-thread", seq, role: "assistant", source: "self", content: { type: "assistant", text: `reply ${seq}` }, createdAt: "2026-01-01" });
  class FakeSource extends EventTarget {
    static instances: FakeSource[] = [];
    closed = false;
    constructor() { super(); FakeSource.instances.push(this); }
    close() { this.closed = true; }
  }
  globalThis.EventSource = FakeSource as unknown as typeof EventSource;
  mockFetch(({ url }) => {
    requests.push(url);
    const threadRead = url.includes("/threads/manager-thread?");
    if (threadRead && !url.includes("since=")) return new Promise<Response>((resolve) => { finishThread = resolve; });
    if (threadRead) return Response.json({ thread: { id: "manager-thread" }, messages: [message(2)] });
    if (url.includes("/work-items")) return Response.json({ items: [], nextCursor: null });
    if (url.includes("/active-wakes")) return Response.json({ wakes: [] });
    if (url.includes("/pending-monitors")) return Response.json({ threads: [], revision: { boot: 1, seq: 0 } });
    if (url.endsWith("/api/agents/threads/manager-thread/tasks")) return Response.json({ tasks: [], olderDone: null, seq: 4 });
    if (url.endsWith("/api/agents/threads/manager-thread/tasks?since=4")) return Response.json({ tasks: [], seq: 4 });
    throw new Error(`Unexpected request: ${url}`);
  });
  let view: Mounted | null = null;
  try {
    view = await mountAsync(<App />);
    source = FakeSource.instances.at(-1)!;
    expect(requests.filter((url) => url.includes("/threads/manager-thread?") && !url.includes("since="))).toHaveLength(1);
    await act(async () => {
      source.dispatchEvent(new Event("open"));
      source.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ sessions: [], counts: {} }) }));
      source.dispatchEvent(new MessageEvent("projectsState", { data: "[]" }));
      source.dispatchEvent(new MessageEvent("managerThreads", { data: JSON.stringify({ threads: [{
        id: "manager-thread", title: "Release", named: true, createdAt: "2026-01-01", lastActivityAt: "2026-01-01",
        lastVisibleSeq: 1, seenSeq: 0, running: false, archivedAt: null
      }] }) }));
      finishThread(Response.json({ thread: { id: "manager-thread" }, messages: [message(1)], hasMore: false }));
    });
    expect(requests.some((url) => url === "/api/state")).toBe(false);
    expect(requests.filter((url) => url.includes("/active-wakes"))).toHaveLength(1);
    // What every thread waits on, for the sidebar's watching state.
    expect(requests.filter((url) => url.includes("/pending-monitors"))).toHaveLength(1);
    expect(requests.filter((url) => url.includes("/work-items"))).toHaveLength(1);
    expect(requests.filter((url) => url.endsWith("/manager-thread/tasks"))).toHaveLength(1);
    expect(useSnapshotStore.getState().snapshot?.sessions).toEqual([]);
    // The open burst's thread list fills the thread store.
    expect([...useManagerThreadsStore.getState().threads.keys()]).toEqual(["manager-thread"]);

    await act(async () => { source.dispatchEvent(new Event("error")); });
    expect(useSnapshotStore.getState().connection).toBe("error");
    await act(async () => { source.dispatchEvent(new Event("open")); });
    expect(requests.some((url) => url.includes("/threads/manager-thread?") && url.includes("since=1"))).toBe(true);
    expect(requests.filter((url) => url.includes("/active-wakes"))).toHaveLength(2);
    expect(requests.filter((url) => url.includes("/pending-monitors"))).toHaveLength(2);
    expect(requests.filter((url) => url.includes("/work-items"))).toHaveLength(2);
    // Its tasks: what changed after the number the first read reflected.
    expect(requests.filter((url) => url.includes("/manager-thread/tasks"))).toStrictEqual(["/api/agents/threads/manager-thread/tasks", "/api/agents/threads/manager-thread/tasks?since=4"]);
    expect(useAgentChatStore.getState().threadsByScope.get("manager:manager-thread")?.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  } finally {
    view?.unmount();
    globalThis.EventSource = originalSource;
    restores.forEach((restore) => restore());
  }
  expect(source.closed).toBe(true);
});
