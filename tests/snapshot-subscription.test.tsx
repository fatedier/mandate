import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useSnapshotSubscription } from "../src/client/hooks/useSnapshotSubscription.js";
import { useAgentChat } from "../src/client/hooks/useAgentChat.js";
import { useAgentChatStore } from "../src/client/store/agent-chat.js";
import { useSnapshotStore } from "../src/client/store/snapshot.js";
import { useProjectsStore } from "../src/client/store/projects.js";
import { useWakeActivityStore } from "../src/client/store/wake-activity.js";
import { useWorkItemsStore } from "../src/client/store/work-items.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const manager = { type: "manager" as const };
function App() { useSnapshotSubscription(); useAgentChat(manager); return null; }

test("SSE boot hydrates once and reconnect still pulls messages, work items and wakes", async () => {
  const originalFetch = globalThis.fetch;
  const originalSource = globalThis.EventSource;
  const stores = [useAgentChatStore, useSnapshotStore, useProjectsStore, useWakeActivityStore, useWorkItemsStore] as const;
  const saved = stores.map((store) => store.getState());
  useAgentChatStore.setState({ threadsByScope: new Map(), sideThread: null });
  useSnapshotStore.setState({ snapshot: null, banner: "", connection: "idle" });
  useProjectsStore.setState({ projects: [] });
  useWorkItemsStore.setState({ items: new Map(), paginationByStatus: new Map() });
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
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/thread?limit=")) return new Promise<Response>((resolve) => { finishThread = resolve; });
    if (url.includes("/thread?since=")) return Response.json({ thread: { id: "manager-thread" }, messages: [message(2)] });
    if (url.includes("/work-items")) return Response.json({ items: [], nextCursor: null });
    if (url.includes("/active-wakes")) return Response.json({ wakes: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<App />); });
    source = FakeSource.instances.at(-1)!;
    expect(requests.filter((url) => url.includes("/thread?limit="))).toHaveLength(1);
    await act(async () => {
      source.dispatchEvent(new Event("open"));
      source.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify({ sessions: [], counts: {} }) }));
      source.dispatchEvent(new MessageEvent("projectsState", { data: "[]" }));
      finishThread(Response.json({ thread: { id: "manager-thread" }, messages: [message(1)], hasMore: false }));
    });
    expect(requests.some((url) => url === "/api/state")).toBe(false);
    expect(requests.filter((url) => url.includes("/active-wakes"))).toHaveLength(1);
    expect(requests.filter((url) => url.includes("/work-items"))).toHaveLength(1);
    expect(useSnapshotStore.getState().snapshot?.sessions).toEqual([]);

    await act(async () => { source.dispatchEvent(new Event("error")); });
    expect(useSnapshotStore.getState().connection).toBe("error");
    await act(async () => { source.dispatchEvent(new Event("open")); });
    expect(requests).toContain("/api/agents/manager/thread?since=1");
    expect(requests.filter((url) => url.includes("/active-wakes"))).toHaveLength(2);
    expect(requests.filter((url) => url.includes("/work-items"))).toHaveLength(2);
    expect(useAgentChatStore.getState().threadsByScope.get("manager")?.messages.map((m) => m.id)).toEqual(["m-1", "m-2"]);
  } finally {
    await act(async () => { root.unmount(); });
    host.remove();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalSource;
    stores.forEach((store, i) => (store as { setState: (state: never, replace: true) => void }).setState(saved[i] as never, true));
  }
  expect(source.closed).toBe(true);
});
