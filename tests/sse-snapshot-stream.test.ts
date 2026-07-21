import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes.js";
import { WorkspaceSnapshotDecoder } from "../src/shared/workspace-snapshot.js";
import { workspaceSnapshot } from "./helpers/workspace-snapshot.js";

const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => { await Promise.all(readers.splice(0).map((reader) => reader.cancel())); });

function fixture(initial: unknown = workspaceSnapshot()) {
  let snapshot = initial;
  const sse = new AgentSseEmitter();
  const app = new Hono();
  mountSseRoutes(app, { sse, getSnapshot: () => snapshot, getProjectsState: () => [], heartbeatMs: 60000 });
  return {
    sse,
    cache(value: unknown) { snapshot = value; },
    publish(value: unknown) { snapshot = value; sse.emit("snapshot", value); },
    async connect(query = "?messageFormat=delta&snapshotFormat=delta") {
      const response = await app.request(`/api/events${query}`);
      expect(response.headers.get("content-encoding")).toBeNull();
      const reader = response.body!.getReader();
      readers.push(reader);
      let buffer = "";
      const text = new TextDecoder();
      const next = async () => {
        while (!buffer.includes("\n\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("SSE ended before expected frame");
          buffer += text.decode(chunk.value, { stream: true });
        }
        const end = buffer.indexOf("\n\n") + 2;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end);
        const lines = frame.trimEnd().split("\n");
        return { event: lines[0]!.slice(7), data: JSON.parse(lines[1]!.slice(6)), bytes: Buffer.byteLength(frame) };
      };
      const nextSnapshot = async () => {
        for (;;) {
          const event = await next();
          if (["snapshot", "snapshotFull", "snapshotPatch"].includes(event.event)) return event;
        }
      };
      return { next, nextSnapshot, close: () => reader.cancel() };
    }
  };
}

test("snapshot delta is opt-in and queued bootstrap does not lose live updates", async () => {
  const h = fixture();
  const current = await h.connect();
  const old = await h.connect("?messageFormat=delta");
  const next = workspaceSnapshot(2);
  next.sessions[0]!.windows[0]!.windowName = "changed";
  h.publish(next);
  expect((await current.nextSnapshot()).event).toBe("snapshotFull");
  const patch = await current.nextSnapshot();
  expect(patch.event).toBe("snapshotPatch");
  expect(patch.data.windows).toHaveLength(1);
  expect((await old.nextSnapshot()).event).toBe("snapshot");
  expect((await old.nextSnapshot()).data).toEqual(next);
  h.sse.emit("agentMessageDelta", { threadId: "t1", wakeId: "w1", totalText: "reply", deltaText: "reply" });
  expect((await current.next()).event).toBe("agentMessagePatch");
  await current.close();
  await old.close();
  expect(h.sse.sinkCount).toBe(0);
});

test("late connections and reconnects use their own full baseline including idle cached polls", async () => {
  const h = fixture();
  const first = await h.connect();
  const firstDecoder = new WorkspaceSnapshotDecoder();
  firstDecoder.full((await first.nextSnapshot()).data);
  // The poller cache advances its version even when dedup suppresses a broadcast.
  h.cache(workspaceSnapshot(5));
  const late = await h.connect();
  const lateDecoder = new WorkspaceSnapshotDecoder();
  expect(lateDecoder.full((await late.nextSnapshot()).data)).toEqual(workspaceSnapshot(5));
  const next = workspaceSnapshot(6);
  next.sessions[1]!.windows[0]!.windowName = "new name";
  h.publish(next);
  expect(firstDecoder.patch((await first.nextSnapshot()).data)).toEqual(next);
  expect(lateDecoder.patch((await late.nextSnapshot()).data)).toEqual(next);
  await first.close();
  const reconnect = await h.connect();
  expect((await reconnect.nextSnapshot()).data).toEqual({ revision: 1, snapshot: next });
});

test("a connection before the first poll receives full state before any deltas", async () => {
  const h = fixture(null);
  const client = await h.connect();
  h.publish(workspaceSnapshot());
  expect((await client.nextSnapshot()).event).toBe("snapshotFull");
  h.sse.emit("error", { message: "polling failed" });
  expect((await client.next()).event).toBe("error");
  h.publish(workspaceSnapshot());
  expect((await client.nextSnapshot()).data).toEqual({ baseRevision: 1, revision: 2 });
});

test("actual SSE frames send one changed window instead of every preview", async () => {
  const h = fixture();
  const current = await h.connect();
  const old = await h.connect("");
  const decoder = new WorkspaceSnapshotDecoder();
  const initial = await current.nextSnapshot();
  decoder.full(initial.data);
  let deltaBytes = initial.bytes;
  let fullBytes = (await old.nextSnapshot()).bytes;
  for (let i = 2; i <= 61; i++) {
    const next = workspaceSnapshot(i);
    next.sessions[0]!.windows[0]!.panes = [{ paneId: "%0", preview: `tick-${i}\n` + "terminal output\n".repeat(500) }];
    h.publish(next);
    const frame = await current.nextSnapshot();
    expect(frame.event).toBe("snapshotPatch");
    expect(decoder.patch(frame.data)).toEqual(next);
    deltaBytes += frame.bytes;
    fullBytes += (await old.nextSnapshot()).bytes;
  }
  expect(deltaBytes).toBeLessThan(fullBytes / 4);
  console.log(`Workspace SSE fixture: full ${fullBytes} bytes; incremental ${deltaBytes} bytes (${(100 * (1 - deltaBytes / fullBytes)).toFixed(1)}% less), including initial state`);
});
