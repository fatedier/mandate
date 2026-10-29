import { expect, test } from "bun:test";
import { z } from "zod";
import { freshAgentEnv } from "../helpers/fixtures.js";
import { ToolRegistry, ToolDispatcher } from "../../src/server/modules/agent/tool-registry.js";
import {
  VoiceSessionOrchestrator,
  type VoiceSessionOrchestratorDeps
} from "../../src/server/modules/voice/voice-session-orchestrator.js";
import type { VoiceProvider, VoiceSession, VoiceSessionEvents, VoiceProviderConfig } from "../../src/server/modules/voice/voice-provider.js";
import { AgentSseEmitter } from "../../src/server/modules/sse/sse-events.js";
import type { SseEventPayloadMap } from "../../src/shared/api-contracts.js";
import { contentOf } from "../helpers/typed.js";

class FakeProvider implements VoiceProvider {
  lastEvents: VoiceSessionEvents | null = null;
  lastConfig: VoiceProviderConfig | null = null;
  sentTool: { callId: string; payload: Parameters<VoiceSession["sendToolResult"]>[1] } | null = null;
  contextMessages: string[] = [];
  preloaded: { role: string; text: string }[] = [];
  closeCalled = false;
  async startSession(config: VoiceProviderConfig, events: VoiceSessionEvents): Promise<VoiceSession> {
    this.lastConfig = config;
    this.lastEvents = events;
    return {
      sendAudio: () => {},
      sendToolResult: (callId, payload) => { this.sentTool = { callId, payload }; },
      sendContextMessage: (text) => { this.contextMessages.push(text); },
      updateInstructions: () => {},
      requestResponse: () => {},
      cancelResponse: () => {},
      truncateItem: () => {},
      preloadHistory: (items) => { this.preloaded.push(...items); },
      close: async () => { this.closeCalled = true; }
    };
  }
}

const listProjects = {
  name: "list_projects",
  description: "List",
  parameters: z.object({}),
  handler: async () => ({ projects: [{ id: "p1", name: "Foo" }] })
};

function buildDispatcher() {
  const registry = new ToolRegistry();
  registry.register(listProjects);
  return {
    registry: { tools: registry.tools },
    dispatch: async (call: any, ctx: any) => new ToolDispatcher(registry).dispatch(call, ctx)
  };
}

/** An orchestrator on the global agent's thread, as the factory builds it. */
function build(
  env: ReturnType<typeof freshAgentEnv>,
  provider: FakeProvider,
  over: Partial<VoiceSessionOrchestratorDeps> = {}
): VoiceSessionOrchestrator {
  return new VoiceSessionOrchestrator({
    threadId: env.agentStore.getOrCreateGlobalThread().id,
    agentStore: env.agentStore,
    provider,
    providerConfig: { apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "", tools: [listProjects] },
    dispatcher: buildDispatcher(),
    buildToolScope: () => ({ kind: "manager", managerDir: "", projectWorkingDirs: [] }),
    sse: new AgentSseEmitter(),
    idleTimeoutMs: 60_000,
    maxSessionMs: 600_000,
    contextMessageCount: 0,
    ...over
  });
}

test("VoiceSessionOrchestrator: dispatches a tool, persists tool_use + tool_result, sends back to provider", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const orch = build(env, provider);
  await orch.start();
  provider.lastEvents!.onToolCall({ callId: "c1", name: "list_projects", args: {} });
  await new Promise((r) => setTimeout(r, 10));

  expect(provider.sentTool?.callId).toBe("c1");
  expect(provider.sentTool?.payload.result).toMatchObject({
    projects: [{ id: "p1", name: "Foo" }]
  });

  const messages = env.agentStore.getActiveMessages(env.agentStore.getOrCreateGlobalThread().id);
  expect(messages.length).toBe(2);
  const toolUse = messages.find((m) => m.role === "assistant");
  const toolResult = messages.find((m) => m.role === "tool");
  expect(toolUse?.source).toBe("voice");
  expect(toolResult?.source).toBe("voice");
  expect(toolResult?.content.type).toBe("tool_result");
  expect(contentOf(toolResult!, "tool_result").toolCallId).toBe("c1");
});

test("VoiceSessionOrchestrator: explicit close fires onClose with client-closed", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const reasons: string[] = [];
  const orch = build(env, provider);
  orch.on("onClose", (r) => reasons.push(r));
  await orch.start();
  await orch.close();
  expect(reasons).toContain("client-closed");
  expect(provider.closeCalled).toBe(true);
});

test("VoiceSessionOrchestrator: preloads last N dialogue messages, filters tool/summary/runtime context", async () => {
  const env = freshAgentEnv();
  const thread = env.agentStore.getOrCreateGlobalThread();
  // Mix of dialogue, tool, summary, runtime context, assistant-with-tool-only-no-text
  env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "msg1-user" }
  });
  env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "runtime-context",
    content: { type: "text", text: "## Global agent runtime context" }
  }); // skipped — only the model reads it
  env.agentStore.appendMessage({
    threadId: thread.id, role: "assistant", source: "self",
    content: { type: "assistant", text: "msg2-asst" }
  });
  env.agentStore.appendMessage({
    threadId: thread.id, role: "assistant", source: "self",
    content: { type: "assistant", toolCalls: [{ toolCallId: "c1", toolName: "x", args: {} }] }
  }); // skipped — no text
  env.agentStore.appendMessage({
    threadId: thread.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c1", toolName: "x", result: {} }
  }); // skipped — tool role
  env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "compression",
    content: { type: "summary", summary: "old", replacedRange: [1, 5], replacedCount: 5, retained: [] }
  }); // skipped — summary type
  env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "msg3-user" }
  });

  const provider = new FakeProvider();
  const orch = build(env, provider, { contextMessageCount: 10 });
  await orch.start();

  expect(provider.preloaded).toStrictEqual([
    { role: "user", text: "msg1-user" },
    { role: "assistant", text: "msg2-asst" },
    { role: "user", text: "msg3-user" }
  ]);
});

test("VoiceSessionOrchestrator: preloads at most contextMessageCount", async () => {
  const env = freshAgentEnv();
  const thread = env.agentStore.getOrCreateGlobalThread();
  for (let i = 0; i < 25; i++) {
    env.agentStore.appendMessage({
      threadId: thread.id,
      role: i % 2 === 0 ? "user" : "assistant",
      source: i % 2 === 0 ? "user" : "self",
      content: i % 2 === 0
        ? { type: "text", text: `u${i}` }
        : { type: "assistant", text: `a${i}` }
    });
  }
  const provider = new FakeProvider();
  const orch = build(env, provider, { contextMessageCount: 10 });
  await orch.start();

  // Pattern: i=0 even → u0 (user), i=1 odd → a1 (assistant), …, i=24 even → u24 (user)
  // Last 10 are i=15..24
  expect(provider.preloaded).toHaveLength(10);
  expect(provider.preloaded[0]).toEqual({ role: "assistant", text: "a15" }); // i=15 odd
  expect(provider.preloaded[9]).toEqual({ role: "user", text: "u24" });       // i=24 even
});

test("VoiceSessionOrchestrator: contextMessageCount=0 → no preload even with messages", async () => {
  const env = freshAgentEnv();
  const thread = env.agentStore.getOrCreateGlobalThread();
  env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "should-be-skipped" }
  });
  const provider = new FakeProvider();
  const orch = build(env, provider, { contextMessageCount: 0 });
  await orch.start();

  expect(provider.preloaded).toStrictEqual([]);
});

test("VoiceSessionOrchestrator: persists final user transcript to the global thread", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const sse = new AgentSseEmitter();
  const sseEvents: Array<SseEventPayloadMap["agentMessageAppended"]> = [];
  sse.addSink((e) => {
    if (e.event === "agentMessageAppended") sseEvents.push(e.data);
  });
  const orch = build(env, provider, { sse });
  await orch.start();

  // Simulate provider firing onTranscript with isFinal=true for user
  provider.lastEvents!.onTranscript({ speaker: "user", text: "hello world", isFinal: true });

  const thread = env.agentStore.getOrCreateGlobalThread();
  const msgs = env.agentStore.getActiveMessages(thread.id);
  const userMsgs = msgs.filter((m) => m.role === "user" && m.source === "voice");
  expect(userMsgs).toHaveLength(1);
  expect(userMsgs[0].content).toEqual({ type: "text", text: "hello world" });
  expect(sseEvents).toHaveLength(1);
  expect(sseEvents[0]!.threadId).toBe(thread.id);
});

test("VoiceSessionOrchestrator: persists final assistant transcript with toolCalls=[]", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const orch = build(env, provider);
  await orch.start();

  provider.lastEvents!.onTranscript({ speaker: "assistant", text: "hi there", isFinal: true });

  const msgs = env.agentStore.getActiveMessages(env.agentStore.getOrCreateGlobalThread().id);
  const asstMsgs = msgs.filter((m) => m.role === "assistant" && m.source === "voice");
  expect(asstMsgs).toHaveLength(1);
  expect(asstMsgs[0].content).toEqual({ type: "assistant", text: "hi there", toolCalls: [] });
});

test("VoiceSessionOrchestrator: non-final transcript deltas do NOT persist", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const orch = build(env, provider);
  await orch.start();

  provider.lastEvents!.onTranscript({ speaker: "user", text: "hel", isFinal: false });
  provider.lastEvents!.onTranscript({ speaker: "user", text: "hello", isFinal: false });

  const msgs = env.agentStore.getActiveMessages(env.agentStore.getOrCreateGlobalThread().id);
  expect(msgs.filter((m) => m.source === "voice")).toHaveLength(0);
});

test("VoiceSessionOrchestrator: empty final transcript text → no persistence", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const orch = build(env, provider);
  await orch.start();

  provider.lastEvents!.onTranscript({ speaker: "user", text: "", isFinal: true });
  provider.lastEvents!.onTranscript({ speaker: "user", text: "   ", isFinal: true });

  const msgs = env.agentStore.getActiveMessages(env.agentStore.getOrCreateGlobalThread().id);
  expect(msgs.filter((m) => m.source === "voice")).toHaveLength(0);
});

test("VoiceSessionOrchestrator: forwards transcript to outbound regardless of isFinal", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const orch = build(env, provider);
  const transcripts: any[] = [];
  orch.on("onTranscript", (d) => transcripts.push(d));
  await orch.start();

  provider.lastEvents!.onTranscript({ speaker: "user", text: "hel", isFinal: false });
  provider.lastEvents!.onTranscript({ speaker: "user", text: "hello", isFinal: true });

  expect(transcripts).toHaveLength(2);
  expect(transcripts[0]).toMatchObject({ text: "hel", isFinal: false });
  expect(transcripts[1]).toMatchObject({ text: "hello", isFinal: true });
});

test("VoiceSessionOrchestrator: a spoken reply's end, and the session's close, are the turn's end that publishes the page", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  let ends = 0;
  const orch = build(env, provider, { afterResponse: () => { ends += 1; } });
  await orch.start();
  provider.lastEvents!.onResponseDone({ responseId: null, status: "completed" });
  expect(ends).toBe(1);
  await orch.close();
  expect(ends).toBe(2);
});

test("VoiceSessionOrchestrator: a page that cannot be published never stops the session", async () => {
  const env = freshAgentEnv();
  const provider = new FakeProvider();
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => { warned.push(String(line)); };
  try {
    const orch = build(env, provider, { afterResponse: () => { throw new Error("disk full"); } });
    const reasons: string[] = [];
    orch.on("onClose", (r) => reasons.push(r));
    await orch.start();
    provider.lastEvents!.onResponseDone({ responseId: null, status: "completed" });
    await orch.close();
    expect(reasons).toContain("client-closed");
    expect(warned).toContain("[voice] after a spoken reply: disk full");
  } finally {
    console.warn = warn;
  }
});
