import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { buildApp } from "../src/server/app/http-app.js";
import type { AppDeps } from "../src/server/app/deps.js";
import { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import type { AgentThreadResponse, AgentMessageDto } from "../src/shared/api-contracts.js";

function fixture(overrides: Partial<AppDeps> = {}) {
  const env = freshAgentEnv("mandate-http-transfer-");
  const sse = new AgentSseEmitter();
  const snapshot = { generatedAt: "fixture", sessions: [], clients: [], counts: {} };
  const deps = {
    config: { agent: { compressionThresholdTokens: 100000 } },
    agentStore: env.agentStore, scopes: { manager: {} }, sse,
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
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const message = appendAssistant(env, thread.id);
    const side = env.agentStore.createSideThread(thread.id);
    appendAssistant(env, side.id);
    for (const path of [
      "/api/agents/manager/thread?limit=50", "/api/agents/manager/thread?since=0",
      `/api/agents/threads/${side.id}?limit=50`, `/api/agents/threads/${side.id}?since=0`
    ]) {
      const response = await env.app.request(path);
      expect(response.status).toBe(200);
      const body = await response.json() as Exclude<AgentThreadResponse, { error: string }>;
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]).not.toHaveProperty("supersededBySummaryId");
      expect(body.messages[0]!.content).not.toHaveProperty("sdkAssistantMessages");
      expect(body.messages[0]!.content).toMatchObject({ type: "assistant", text: (message.content as any).text, toolCalls: (message.content as any).toolCalls });
    }
    expect(env.agentStore.getMessages(thread.id)[0]!.content).toHaveProperty("sdkAssistantMessages");
    expect(message.content).toHaveProperty("sdkAssistantMessages");
  } finally { env.cleanup(); }
});

test("JSON compression preserves the response and both CORS/cache vary dimensions", async () => {
  const env = fixture();
  try {
    for (const path of ["/api/canvas/canvas", "/api/agents/manager/thread?limit=50"]) {
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
  } finally { env.cleanup(); }
});

test("Canvas revalidation preserves validators and Vary across gzip, identity and CORS", async () => {
  const env = fixture();
  try {
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
  } finally { env.cleanup(); }
});

test("SSE boot state and live updates arrive uncompressed without leaking SDK data", async () => {
  const env = fixture();
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const message = appendAssistant(env, thread.id);
  const response = await env.app.request("/api/events", { headers: { "Accept-Encoding": "gzip" } });
  const reader = response.body!.getReader();
  try {
    expect(response.headers.get("Content-Encoding")).toBeNull();
    // Publish before reading the bootstrap: a slow reader must not lose events.
    env.sse.emit("agentMessageAppended", { threadId: thread.id, message });
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes("event: agentMessageAppended") || !text.endsWith("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE ended before the live message");
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain("event: snapshot");
    expect(text).toContain("event: projectsState");
    expect(text).toContain("fixture polling error");
    const event = text.split("\n\n").find((frame) => frame.startsWith("event: agentMessageAppended"))!;
    const data = JSON.parse(event.split("\ndata: ")[1]!);
    expect(data.message.id).toBe(message.id);
    expect(data.message).not.toHaveProperty("supersededBySummaryId");
    expect(data.message.content.text).toBe((message.content as any).text);
    expect(data.message.content).not.toHaveProperty("sdkAssistantMessages");
    expect(message.content).toHaveProperty("sdkAssistantMessages");
  } finally {
    await reader.cancel();
    env.cleanup();
  }
  expect(env.sse.sinkCount).toBe(0);
});

test("terminal WebSocket upgrades still deliver binary output", async () => {
  const env = fixture({ paneRuntimes: { tmux: {
    attachViewer: async (_paneId: string, ws: { send: (data: Uint8Array) => void }) => {
      ws.send(new TextEncoder().encode("terminal fixture"));
      return { detach() {}, handleMessage() {} };
    }
  } } as unknown as AppDeps["paneRuntimes"] });
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
    env.cleanup();
  }
});

test("info readiness checks skip JSON serialization and compression", async () => {
  const env = fixture();
  try {
    const response = await env.app.request("/api/info", {
      method: "HEAD", headers: { "Accept-Encoding": "gzip" }
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Encoding")).toBeNull();
  } finally { env.cleanup(); }
});
