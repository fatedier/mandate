import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes.js";
import type { AgentClientMessageDto, AgentMessagePatchDto } from "../src/shared/api-contracts.js";

const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
afterEach(async () => { await Promise.all(readers.splice(0).map((reader) => reader.cancel())); });

function fixture() {
  const sse = new AgentSseEmitter();
  const app = new Hono();
  mountSseRoutes(app, { sse, getSnapshot: () => null, getProjectsState: () => [], heartbeatMs: 60000 });
  const delta = (totalText: string, wakeId = "w1", threadId = "t1") => {
    // This is deliberately only the last provider fragment: the wire encoder
    // must derive ALL coalesced text from the published cumulative value.
    sse.emit("agentMessageDelta", { threadId, wakeId, deltaText: totalText.slice(-1), totalText });
  };
  const connect = async (incremental = true) => {
    const response = await app.request(`/api/events${incremental ? "?messageFormat=delta" : ""}`);
    expect(response.headers.get("content-encoding")).toBeNull();
    const reader = response.body!.getReader();
    readers.push(reader);
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE ended before the expected event");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf("\n\n") + 2;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end);
      const lines = frame.trimEnd().split("\n");
      return { event: lines[0]!.slice(7), data: JSON.parse(lines[1]!.slice(6)), bytes: new TextEncoder().encode(frame).length };
    };
    expect((await next()).event).toBe("projectsState");
    const snapshot = incremental ? await next() : null;
    if (snapshot) expect(snapshot.event).toBe("agentMessageStreams");
    expect(await next()).toMatchObject({ event: "_hb", data: { intervalMs: 60000 } });
    return { next, snapshot };
  };
  return { sse, delta, connect };
}

function assistant(wakeId = "w1", text = "done"): AgentClientMessageDto {
  return { id: `message-${text}`, threadId: "t1", wakeId, seq: 1, role: "assistant", source: "self", content: { type: "assistant", text }, createdAt: "2026-09-13" };
}

test("coalesced patches carry all coalesced text while existing clients retain the full-text protocol", async () => {
  const h = fixture();
  const current = await h.connect();
  const old = await h.connect(false);
  h.delta("H");
  h.delta("Hello");
  h.delta("Hello\nfinished");
  h.sse.flushMessageDelta("t1", "w1");
  const first = await current.next();
  const second = await current.next();
  expect(first).toMatchObject({ event: "agentMessagePatch", data: { offset: 0, deltaText: "H" } });
  expect(second).toMatchObject({ event: "agentMessagePatch", data: { offset: 1, deltaText: "ello\nfinished" } });
  expect(first.data).not.toHaveProperty("totalText");
  expect(second.data).not.toHaveProperty("totalText");
  expect((await old.next()).data.totalText).toBe("H");
  expect((await old.next()).data.totalText).toBe("Hello\nfinished");
});

test("mid-stream connections and reconnects start from the published baseline, including a paused stream", async () => {
  const h = fixture();
  h.delta("hel");
  h.delta("hello");
  const first = await h.connect();
  expect(first.snapshot?.data.streams).toEqual([{ threadId: "t1", wakeId: "w1", totalText: "hel" }]);
  h.sse.flushMessageDelta("t1", "w1");
  expect((await first.next()).data).toMatchObject({ offset: 3, deltaText: "lo" });
  const second = await h.connect();
  expect(second.snapshot?.data.streams[0].totalText).toBe("hello");
  h.delta("hello world");
  h.sse.flushMessageDelta("t1", "w1");
  for (const client of [first, second]) expect((await client.next()).data).toMatchObject({ offset: 5, deltaText: " world" });
  h.sse.emit("agentMessageAppended", { threadId: "t1", message: assistant() });
  expect(h.sse.getMessageStreams()).toEqual([]);
  expect((await h.connect()).snapshot?.data.streams).toEqual([]);
});

test("fallbacks reset text and every assistant step starts a fresh baseline, even within one wake", async () => {
  const h = fixture();
  const client = await h.connect();
  h.delta("wrong answer");
  h.delta("");
  h.sse.flushMessageDelta("t1", "w1");
  await client.next();
  expect((await client.next()).data).toMatchObject({ offset: 0, deltaText: "" });
  h.delta("right");
  // End events must flush the tail before the final message and drop the cache.
  h.delta("right answer");
  h.sse.emit("agentMessageAppended", { threadId: "t1", message: assistant("w1", "right answer") });
  expect((await client.next()).data).toMatchObject({ offset: 0, deltaText: "right" });
  expect((await client.next()).data).toMatchObject({ offset: 5, deltaText: " answer" });
  expect((await client.next()).event).toBe("agentMessageAppended");
  h.delta("right answer, next step");
  expect((await client.next()).data).toMatchObject({ offset: 0, deltaText: "right answer, next step" });
  h.sse.emit("agentWakeFinished", { threadId: "t1", wakeId: "w1", status: "canceled" });
  expect((await client.next()).event).toBe("agentWakeFinished");
  expect(h.sse.getMessageStreams()).toEqual([]);
});

test("finishing another wake does not drop an active stream", async () => {
  const h = fixture();
  const client = await h.connect();
  h.delta("new", "w2");
  h.sse.flushMessageDelta("t1", "w2");
  await client.next();
  h.sse.emit("agentWakeFinished", { threadId: "t1", wakeId: "w1", status: "succeeded" });
  await client.next();
  h.delta("new text", "w2");
  h.sse.flushMessageDelta("t1", "w2");
  expect((await client.next()).data).toMatchObject({ offset: 3, deltaText: " text" });
  expect(h.sse.getMessageStreams()[0]?.wakeId).toBe("w2");
});

test("actual SSE bytes grow with the reply rather than repeated prefixes", async () => {
  const h = fixture();
  const current = await h.connect();
  const old = await h.connect(false);
  let totalText = "";
  let reconstructed = "";
  let newBytes = current.snapshot!.bytes;
  let oldBytes = 0;
  for (let i = 0; i < 300; i++) {
    totalText += `${i}:` + "x".repeat(96);
    h.delta(totalText);
    h.sse.flushMessageDelta("t1", "w1");
    const frame = await current.next();
    const patch = frame.data as AgentMessagePatchDto;
    reconstructed = reconstructed.slice(0, patch.offset) + patch.deltaText;
    expect(reconstructed).toBe(totalText);
    newBytes += frame.bytes;
    oldBytes += (await old.next()).bytes;
  }
  h.sse.emit("agentMessageAppended", { threadId: "t1", message: assistant("w1", totalText) });
  newBytes += (await current.next()).bytes;
  oldBytes += (await old.next()).bytes;
  expect(newBytes).toBeLessThan(oldBytes / 30);
  console.log(`SSE fixture: ${totalText.length} text bytes; cumulative ${oldBytes} bytes; incremental ${newBytes} bytes (${(100 * (1 - newBytes / oldBytes)).toFixed(1)}% less)`);
});
