import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { buildApp } from "../src/server/app/http-app.js";
import type { AppDeps } from "../src/server/app/deps.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { readSse } from "./helpers/sse.js";
import type { AgentThreadResponse, AgentMessageDto, SseEventPayloadMap } from "../src/shared/api-contracts.js";
import { contentOf } from "./helpers/typed.js";
import { allMessages } from "./helpers/thread-messages.js";

function fixture(overrides: Partial<AppDeps> = {}) {
  const env = freshAgentEnv("mandate-http-transfer-");
  const sse = new AgentSseEmitter();
  const snapshot = { generatedAt: "fixture", sessions: [] };
  const deps = {
    config: { agent: { compressionThresholdTokens: 100000 } },
    agentStore: env.agentStore, store: env.store, scopes: { manager: {} }, sse,
    getSnapshot: () => snapshot, getProjectsState: () => [], heartbeatMs: 60000,
    getSnapshotError: () => ({ message: "fixture polling error" }),
    canvasStore: { getById: () => ({ id: "canvas", html: "<p>Document content</p>".repeat(1000) }) },
    ...overrides
  } as unknown as AppDeps;
  return { ...env, sse, snapshot, deps, ...buildApp(deps) };
}

function appendAssistant(env: ReturnType<typeof fixture>, threadId: string): AgentMessageDto {
  const text = "Assistant text. ".repeat(1000);
  return env.agentStore.appendMessage({
    threadId, role: "assistant", source: "self",
    content: {
      type: "assistant", text,
      toolCalls: [{ toolCallId: "call-1", toolName: "read_file", args: { path: "file.ts" } }],
      sdkAssistantMessages: [{ role: "assistant", content: [{ type: "text", text }, { type: "reasoning", text: "continuation data" }] }]
    }
  });
}

test("all thread history routes omit SDK state while keeping the stored continuation", async () => {
  const env = fixture();
  const thread = env.agentStore.createManagerThread("Release");
  const message = appendAssistant(env, thread.id);
  const other = env.agentStore.getOrCreateThread("worker", "worker-1");
  appendAssistant(env, other.id);
  for (const path of [
    `/api/agents/threads/${thread.id}?limit=50`, `/api/agents/threads/${thread.id}?since=0`,
    `/api/agents/threads/${other.id}?limit=50`, `/api/agents/threads/${other.id}?since=0`
  ]) {
    const response = await env.app.request(path);
    expect(response.status).toBe(200);
    const body = await response.json() as Exclude<AgentThreadResponse, { error: string }>;
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).not.toHaveProperty("supersededBySummaryId");
    expect(body.messages[0]!.content).not.toHaveProperty("sdkAssistantMessages");
    expect(body.messages[0]!.content).toMatchObject({ type: "assistant", text: contentOf(message, "assistant").text, toolCalls: contentOf(message, "assistant").toolCalls });
  }
  expect(allMessages(env.agentStore, thread.id)[0]!.content).toHaveProperty("sdkAssistantMessages");
  expect(message.content).toHaveProperty("sdkAssistantMessages");
});

test("JSON compression preserves the response and both CORS/cache vary dimensions", async () => {
  const env = fixture();
  for (const path of ["/api/canvas/canvas", "/api/agents/manager/threads"]) {
    const plain = await env.app.request(path);
    const expected = await plain.text();
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    const compressed = await env.app.request(path, { headers: { "Accept-Encoding": "gzip", Origin: "http://localhost:4173" } });
    expect(compressed.headers.get("Content-Encoding")).toBe("gzip");
    expect(compressed.headers.get("Vary")).toContain("Origin");
    expect(compressed.headers.get("Vary")).toContain("Accept-Encoding");
    expect(compressed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:4173");
    const bytes = new Uint8Array(await compressed.arrayBuffer());
    expect(gunzipSync(bytes).toString()).toBe(expected);
  }
});

test("Canvas revalidation preserves validators and Vary across gzip, identity and CORS", async () => {
  const env = fixture();
  const url = "/api/canvas/canvas";
  const origin = "http://localhost:4173";
  const response = await env.app.request(url, { headers: { "Accept-Encoding": "gzip", Origin: origin } });
  expect(response.headers.get("Content-Encoding")).toBe("gzip");
  const etag = response.headers.get("ETag")!;
  expect(etag).toStartWith('W/"');
  await response.arrayBuffer();
  for (const encoding of ["gzip", "identity"]) {
    const cached = await env.app.request(url, {
      headers: { "Accept-Encoding": encoding, Origin: origin, "If-None-Match": etag }
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("Content-Encoding")).toBeNull();
    expect(cached.headers.get("ETag")).toBe(etag);
    expect(cached.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(cached.headers.get("Vary")).toBe(response.headers.get("Vary"));
    expect(cached.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  }
});

test("SSE boot state and live updates arrive uncompressed without leaking SDK data", async () => {
  const env = fixture();
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const message = appendAssistant(env, thread.id);
  const response = await env.app.request("/api/events", { headers: { "Accept-Encoding": "gzip" } });
  const events = readSse(response);
  try {
    expect(response.headers.get("Content-Encoding")).toBeNull();
    // Publish before reading the bootstrap: a slow reader must not lose events.
    env.sse.emit("agentMessageAppended", { threadId: thread.id, message });
    const texts: string[] = [];
    const { found, seen } = await events.until((frame) => {
      texts.push(frame.text);
      return frame.event === "agentMessageAppended";
    });
    expect(seen.some((event) => event === "snapshot" || event === "snapshotFull")).toBe(true);
    expect(seen).toContain("projectsState");
    expect(texts.join("\n")).toContain("fixture polling error");
    const data = found.data as SseEventPayloadMap["agentMessageAppended"];
    expect(data.message.id).toBe(message.id);
    expect(data.message).not.toHaveProperty("supersededBySummaryId");
    expect(contentOf(data.message, "assistant").text).toBe(contentOf(message, "assistant").text);
    expect(data.message.content).not.toHaveProperty("sdkAssistantMessages");
    expect(message.content).toHaveProperty("sdkAssistantMessages");
  } finally {
    await events.close();
  }
  expect(env.sse.sinkCount).toBe(0);
});

test("terminal WebSocket upgrades still deliver binary output", async () => {
  const env = fixture({ tmuxRuntime: {
    attachViewer: (_paneId: string, ws: { send: (data: Uint8Array) => void }) => {
      ws.send(new TextEncoder().encode("terminal fixture"));
      return { detach() {}, async handleMessage() {} };
    }
  } as unknown as AppDeps["tmuxRuntime"] });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: env.app.fetch, websocket: env.websocket });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/terminal?paneId=%251`);
  ws.binaryType = "arraybuffer";
  try {
    const output = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (event) => resolve(new TextDecoder().decode(event.data));
      ws.onerror = () => reject(new Error("WebSocket upgrade failed"));
    });
    expect(output).toBe("terminal fixture");
  } finally {
    ws.close();
    server.stop(true);
  }
});

test("info readiness checks skip JSON serialization and compression", async () => {
  const env = fixture();
  const response = await env.app.request("/api/info", {
    method: "HEAD", headers: { "Accept-Encoding": "gzip" }
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Encoding")).toBeNull();
});

test("a terminal page's frames reach its viewer in the order sent, and its close lets the viewer go", async () => {
  const handled: string[] = [];
  let detached = 0;
  const env = fixture({ tmuxRuntime: {
    attachViewer: () => ({ detach() { detached++; }, async handleMessage(data: unknown) { handled.push(String(data)); } })
  } as unknown as AppDeps["tmuxRuntime"] });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: env.app.fetch, websocket: env.websocket });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/terminal?paneId=%251`);
  try {
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WebSocket upgrade failed")); });
    for (const frame of ["fit", "resize", "typed"]) ws.send(frame);
    for (let i = 0; i < 200 && handled.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(handled).toEqual(["fit", "resize", "typed"]);
    ws.close();
    for (let i = 0; i < 200 && detached === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(detached).toBe(1);
  } finally {
    server.stop(true);
  }
});
