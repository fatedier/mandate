import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useApi } from "../src/client/hooks/useApi.js";
import { useSnapshotStore, type Snapshot } from "../src/client/store/snapshot.js";
import { attachSnapshotSseListeners } from "../src/client/lib/snapshot-sse-listeners.js";
import { SnapshotStreamEncoder } from "../src/server/modules/sse/snapshot-stream-encoder.js";
import { workspaceSnapshot } from "./helpers/workspace-snapshot.js";

const original = useSnapshotStore.getState();
beforeEach(() => useSnapshotStore.setState({ ...original, snapshot: null, snapshotGeneration: 0, banner: "", connection: "idle" }, true));
afterEach(() => useSnapshotStore.setState(original, true));

function context() {
  const state = useSnapshotStore.getState();
  return { generation: state.snapshotGeneration, snapshot: state.snapshot };
}

function stream() {
  const source = new EventTarget() as EventSource;
  let cancelled = false;
  let desyncs = 0;
  let encoder = new SnapshotStreamEncoder();
  attachSnapshotSseListeners(source, {
    cancelled: () => cancelled, setConnection() {}, onReconnect() {}, onStreamDesync: () => { desyncs++; }
  });
  const open = () => { encoder = new SnapshotStreamEncoder(); source.dispatchEvent(new Event("open")); };
  open();
  return {
    source, open, cancel: () => { cancelled = true; }, desyncs: () => desyncs,
    send(snapshot: unknown) {
      const event = encoder.encode(snapshot);
      source.dispatchEvent(new MessageEvent(event.event, { data: event.data }));
    }
  };
}

test("stale HTTP snapshots cannot overwrite SSE or contaminate later window patches", () => {
  const s = stream();
  const initial = workspaceSnapshot(1);
  s.send(initial);
  const request = context();
  const next = workspaceSnapshot(2);
  next.sessions[0]!.windows[0]!.windowName = "first update";
  s.send(next);
  useSnapshotStore.getState().applyHttpSnapshot(initial as Snapshot, request);
  expect(useSnapshotStore.getState().snapshot).toEqual(next);
  const later = structuredClone(next);
  later.snapshotVersion = { epoch: "fixture-server", revision: 3 };
  later.sessions[1]!.windows[0]!.windowName = "second update";
  s.send(later);
  expect(useSnapshotStore.getState().snapshot).toEqual(later);
  expect(s.desyncs()).toBe(0);
});

test("HTTP can complete ahead of queued SSE without rolling back the view or stream baseline", () => {
  const s = stream();
  s.send(workspaceSnapshot(1));
  const request = context();
  const second = workspaceSnapshot(2);
  second.sessions[0]!.windows[0]!.windowName = "second";
  const third = structuredClone(second);
  third.snapshotVersion = { epoch: "fixture-server", revision: 3 };
  third.sessions[1]!.windows[0]!.windowName = "third";
  useSnapshotStore.getState().applyHttpSnapshot(third as Snapshot, request);
  s.send(second);
  expect(useSnapshotStore.getState().snapshot).toEqual(third);
  s.send(third);
  expect(useSnapshotStore.getState().snapshot).toEqual(third);
  expect(s.desyncs()).toBe(0);
});

test("reopening the same EventSource resets the baseline and rejects HTTP from before reconnect", () => {
  const s = stream();
  s.send(workspaceSnapshot(10));
  const request = context();
  s.open();
  const restarted = workspaceSnapshot(1);
  restarted.snapshotVersion = { epoch: "restarted", revision: 1 };
  s.send(restarted);
  useSnapshotStore.getState().applyHttpSnapshot(workspaceSnapshot(11) as Snapshot, request);
  expect(useSnapshotStore.getState().snapshot).toEqual(restarted);
  restarted.snapshotVersion = { epoch: "restarted", revision: 2 };
  s.send(restarted);
  expect(useSnapshotStore.getState().snapshot).toEqual(restarted);
  expect(s.desyncs()).toBe(0);
});

test("manual refresh works while disconnected and protects a restarted server from old queued SSE", () => {
  const s = stream();
  s.send(workspaceSnapshot(10));
  useSnapshotStore.getState().setConnection("error");
  const restarted = workspaceSnapshot(1);
  restarted.snapshotVersion = { epoch: "restarted", revision: 1 };
  useSnapshotStore.getState().applyHttpSnapshot(restarted as Snapshot, context());
  s.send(workspaceSnapshot(11));
  expect(useSnapshotStore.getState().snapshot).toEqual(restarted);
  s.open();
  s.send(restarted);
  expect(useSnapshotStore.getState().snapshot).toEqual(restarted);
});

test("legacy snapshots remain usable and stale legacy HTTP is ignored after an SSE update", () => {
  const s = stream();
  const initial = { sessions: [] };
  s.source.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(initial) }));
  const request = context();
  const latest = { sessions: [], counts: { totalWindows: 0 } };
  s.source.dispatchEvent(new MessageEvent("snapshot", { data: JSON.stringify(latest) }));
  useSnapshotStore.getState().applyHttpSnapshot(initial, request);
  expect(useSnapshotStore.getState().snapshot).toEqual(latest);
  useSnapshotStore.getState().applyHttpSnapshot(initial, context());
  expect(useSnapshotStore.getState().snapshot).toEqual(initial);
});

test("malformed or mismatched frames request resync and stale sources do not apply patches", () => {
  const s = stream();
  s.source.dispatchEvent(new MessageEvent("snapshotPatch", { data: '{"baseRevision":0,"revision":1}' }));
  s.source.dispatchEvent(new MessageEvent("snapshotFull", { data: "invalid json" }));
  s.source.dispatchEvent(new MessageEvent("snapshotFull", { data: '{"revision":1,"snapshot":{}}' }));
  expect(s.desyncs()).toBe(3);
  s.send(workspaceSnapshot());
  s.source.dispatchEvent(new MessageEvent("snapshotPatch", { data: '{"baseRevision":0,"revision":1}' }));
  expect(s.desyncs()).toBe(4);
  s.cancel();
  s.send(workspaceSnapshot(2));
  expect(useSnapshotStore.getState().snapshot).toEqual(workspaceSnapshot());
});

test("a recovery patch clears the polling error even when HTTP already displayed newer state", () => {
  const s = stream();
  s.send(workspaceSnapshot());
  useSnapshotStore.getState().applyHttpSnapshot(workspaceSnapshot(2) as Snapshot, context());
  const error = () => s.source.dispatchEvent(new MessageEvent("error", { data: '{"message":"poll failed"}' }));
  error();
  expect(useSnapshotStore.getState().banner).toBe("poll failed");
  s.send(workspaceSnapshot());
  expect(useSnapshotStore.getState().banner).toBe("");
  expect(useSnapshotStore.getState().snapshot).toEqual(workspaceSnapshot(2));
  error();
  expect(useSnapshotStore.getState().banner).toBe("poll failed");
});

test("useApi captures snapshot freshness before fetching a manual refresh", async () => {
  const previousFetch = globalThis.fetch;
  let resolve!: (response: Response) => void;
  let request!: ReturnType<typeof useApi>;
  globalThis.fetch = (() => new Promise<Response>((done) => { resolve = done; })) as typeof fetch;
  function Probe() { request = useApi(); return null; }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    const s = stream();
    s.send(workspaceSnapshot());
    await act(async () => { root.render(<Probe />); });
    const response = request("POST", "/api/windows/inspect", { windowId: "@0" });
    s.send(workspaceSnapshot(2));
    await act(async () => {
      resolve(Response.json({ ok: true, snapshot: workspaceSnapshot() }));
      await response;
    });
    expect(useSnapshotStore.getState().snapshot).toEqual(workspaceSnapshot(2));
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previousFetch;
  }
});
