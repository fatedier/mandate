import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { mountSseRoutes } from "../src/server/modules/sse/sse-routes.js";
import type { AgentClientMessageDto, AgentMessagePatchDto } from "../src/shared/api-contracts.js";
import { readSse, type SseFrame } from "./helpers/sse.js";

const streams: ReturnType<typeof readSse>[] = [];
afterEach(async () => { await Promise.all(streams.splice(0).map((events) => events.close())); });

function fixture() {
  const sse = new AgentSseEmitter();
  const app = new Hono();
  mountSseRoutes(app, { sse, getSnapshot: () => null, getProjectsState: () => [], heartbeatMs: 60000 });
  const delta = (totalText: string, wakeId = "w1", threadId = "t1") => {
    // This is deliberately only the last provider fragment: the wire encoder
    // must derive ALL coalesced text from the published cumulative value.
    sse.emit("agentMessageDelta", { threadId, wakeId, deltaText: totalText.slice(-1), totalText });
  };
  const connect = async () => {
    const response = await app.request("/api/events");
    expect(response.headers.get("content-encoding")).toBeNull();
    const events = readSse(response);
    streams.push(events);
    const next = async () => (await events.next()) as SseFrame & { data: any };
    expect((await next()).event).toBe("projectsState");
    const snapshot = await next();
    expect(snapshot.event).toBe("agentMessageStreams");
    expect(await next()).toMatchObject({ event: "_hb", data: { intervalMs: 60000 } });
    return { next, snapshot };
  };
  return { sse, delta, connect };
}

function assistant(wakeId = "w1", text = "done"): AgentClientMessageDto {
  return { id: `message-${text}`, threadId: "t1", wakeId, seq: 1, role: "assistant", source: "self", sourceThreadId: null, content: { type: "assistant", text }, createdAt: "2026-09-13" };
}

test("coalesced patches carry all coalesced text, never the whole reply", async () => {
  const h = fixture();
  const current = await h.connect();
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
  h.sse.emit("agentWakeFinished", { threadId: "t1", wakeId: "w1", status: "finished" });
  await client.next();
  h.delta("new text", "w2");
  h.sse.flushMessageDelta("t1", "w2");
  expect((await client.next()).data).toMatchObject({ offset: 3, deltaText: " text" });
  expect(h.sse.getMessageStreams()[0]?.wakeId).toBe("w2");
});

test("actual SSE bytes grow with the reply rather than repeated prefixes", async () => {
  const h = fixture();
  const current = await h.connect();
  let totalText = "";
  let reconstructed = "";
  let newBytes = current.snapshot.bytes;
  // What sending the whole reply on every update would have cost.
  let cumulativeBytes = 0;
  for (let i = 0; i < 300; i++) {
    totalText += `${i}:` + "x".repeat(96);
    h.delta(totalText);
    h.sse.flushMessageDelta("t1", "w1");
    const frame = await current.next();
    const patch = frame.data as AgentMessagePatchDto;
    reconstructed = reconstructed.slice(0, patch.offset) + patch.deltaText;
    expect(reconstructed).toBe(totalText);
    newBytes += frame.bytes;
    cumulativeBytes += totalText.length;
  }
  h.sse.emit("agentMessageAppended", { threadId: "t1", message: assistant("w1", totalText) });
  newBytes += (await current.next()).bytes;
  // Linear in the reply: its text, the final message carrying it once more,
  // and a frame's envelope per update.
  expect(newBytes).toBeLessThan(4 * totalText.length);
  expect(newBytes).toBeLessThan(cumulativeBytes / 30);
});
