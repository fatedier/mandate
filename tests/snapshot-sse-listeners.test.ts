import { expect, test } from "bun:test";
import { SSE_EVENTS, SSE_HEARTBEAT_EVENT } from "../src/shared/api-contracts.js";
import { attachSnapshotSseListeners } from "../src/client/lib/snapshot-sse-listeners.js";
import { useSnapshotStore } from "../src/client/store/snapshot.js";

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
  expect(connections).toEqual([]);
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
  expect(connections).toEqual(["error"]);
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
  expect(activity).toEqual([undefined, 60000, undefined, undefined]);

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
