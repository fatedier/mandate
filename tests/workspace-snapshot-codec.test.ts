import { expect, test } from "bun:test";
import { SnapshotStreamEncoder } from "../src/server/modules/sse/snapshot-stream-encoder.js";
import { WorkspaceSnapshotDecoder } from "../src/shared/workspace-snapshot.js";
import { workspaceSnapshot } from "./helpers/workspace-snapshot.js";

function harness() {
  const encoder = new SnapshotStreamEncoder();
  const decoder = new WorkspaceSnapshotDecoder();
  const send = (snapshot: unknown) => {
    const encoded = encoder.encode(snapshot);
    const payload = JSON.parse(encoded.data);
    const decoded = encoded.event === "snapshotFull" ? decoder.full(payload) : decoder.patch(payload);
    expect(decoded).toEqual(JSON.parse(JSON.stringify(snapshot)));
    return { ...encoded, payload, decoded };
  };
  return { encoder, decoder, send };
}

test("one changed window preserves unrelated sessions and matching IDs in other sessions", () => {
  const h = harness();
  const snapshot = workspaceSnapshot();
  const first = h.send(snapshot);
  expect(first.event).toBe("snapshotFull");
  const next = structuredClone(snapshot);
  next.sessions[0]!.windows[0]!.panes = [{ paneId: "%0", preview: "updated preview" }];
  const second = h.send(next);
  expect(second.event).toBe("snapshotPatch");
  expect(second.payload.windows).toEqual([{ sessionName: "alpha", window: next.sessions[0]!.windows[0] }]);
  expect(second.payload).not.toHaveProperty("sessions");
  expect(second.payload).not.toHaveProperty("fields");
  expect(second.decoded.sessions[1]).toBe(first.decoded.sessions[1]);
  expect(second.decoded.sessions[0]!.windows[1]).toBe(first.decoded.sessions[0]!.windows[1]);
  expect(second.decoded.sessions[0]!.windows[0]).not.toBe(first.decoded.sessions[0]!.windows[0]);
});

test("snapshots reconstruct additions, removals, ordering, renames and cleared fields", () => {
  const h = harness();
  const snapshot = workspaceSnapshot();
  h.send(snapshot);
  snapshot.sessions[0]!.windows.push({ windowId: "@new", windowIndex: 3, windowName: "new" });
  h.send(snapshot);
  snapshot.sessions[0]!.windows.splice(1, 1);
  h.send(snapshot);
  snapshot.sessions[0]!.windows.reverse();
  snapshot.sessions[0]!.windows.forEach((window, i) => { window.windowIndex = i; });
  h.send(snapshot);
  snapshot.sessions[0]!.sessionName = "renamed";
  h.send(snapshot);
  snapshot.sessions.reverse();
  h.send(snapshot);
  snapshot.sessions[0]!.sessionAttached = 1;
  snapshot.clients = [{ sessionName: "beta" }];
  snapshot.counts = { totalWindows: 6, working: 5, done: 1 };
  const metadata = h.send(snapshot);
  expect(metadata.payload.windows).toBeUndefined();
  delete snapshot.sessions[0]!.windows[0]!.aggregate;
  snapshot.sessions[0]!.windows[0]!.panes = [];
  snapshot.optional = "temporary";
  h.send(snapshot);
  delete snapshot.optional;
  const cleared = h.send(snapshot);
  expect(cleared.payload.removedFields).toEqual(["optional"]);
  snapshot.sessions = [];
  snapshot.clients = [];
  snapshot.counts = { totalWindows: 0 };
  h.send(snapshot);
  snapshot.sessions.push({ sessionName: "empty", windows: [] });
  h.send(snapshot);
});

test("identical recovery reaches the client and all-window changes fall back to full", () => {
  const h = harness();
  const snapshot = workspaceSnapshot();
  h.send(snapshot);
  expect(h.send(snapshot).payload).toEqual({ baseRevision: 1, revision: 2 });
  for (const session of snapshot.sessions) {
    session.sessionAttached = 1;
    for (const window of session.windows) window.windowName = "changed";
  }
  snapshot.generatedAt = "later";
  snapshot.clients = [{ sessionName: "alpha" }];
  snapshot.counts = { totalWindows: 6, done: 6 };
  snapshot.snapshotVersion = { epoch: "fixture-server", revision: 2 };
  expect(h.send(snapshot).event).toBe("snapshotFull");
  snapshot.sessions[0]!.windows[0]!.windowName = "next change";
  expect(h.send(snapshot).event).toBe("snapshotPatch");
});

test("serialized baselines detect producer mutations and unsupported full shapes remain compatible", () => {
  const encoder = new SnapshotStreamEncoder();
  const value = workspaceSnapshot();
  encoder.encode(value);
  value.sessions[0]!.windows[0]!.windowName = "mutated";
  expect(JSON.parse(encoder.encode(value).data).windows).toHaveLength(1);
  expect(encoder.encode({ sessions: [{ windows: [] }] }).event).toBe("snapshot");
  expect(encoder.encode(value).event).toBe("snapshotFull");
});

test("missing baselines, revisions and invalid patches are rejected without corrupting state", () => {
  const h = harness();
  expect(() => h.decoder.patch({ baseRevision: 0, revision: 1 })).toThrow();
  const baseline = workspaceSnapshot();
  h.send(baseline);
  for (const invalid of [
    { baseRevision: 0 }, { revision: 3 }, { sessions: null }, { sessions: [{}] },
    { fields: { sessions: [] } }, { removedFields: ["sessions"] },
    { fields: { clients: [] }, removedFields: ["clients"] },
    { windows: [{ sessionName: "missing", window: { windowId: "@0" } }] },
    { sessions: [{ sessionName: "alpha", windowIds: ["@missing"] }] },
    { sessions: [{ sessionName: "alpha", windowIds: ["@0", "@0"] }] },
    { sessions: [{ sessionName: "alpha", windowIds: [] }, { sessionName: "alpha", windowIds: [] }] },
    { windows: [{ sessionName: "alpha", window: { windowId: "@0" } }, { sessionName: "alpha", window: { windowId: "@0" } }] }
  ]) {
    expect(() => h.decoder.patch({ baseRevision: 1, revision: 2, ...invalid })).toThrow();
  }
  expect(h.decoder.patch({ baseRevision: 1, revision: 2 })).toEqual(baseline);
  expect(() => h.decoder.full({ revision: 2, snapshot: baseline })).toThrow();
  h.decoder.reset();
  expect(h.decoder.full({ revision: 1, snapshot: baseline })).toEqual(baseline);
});
