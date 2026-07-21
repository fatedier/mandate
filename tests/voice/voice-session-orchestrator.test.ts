import { expect, test } from "bun:test";
import { z } from "zod";
import { freshAgentEnv } from "../helpers/fixtures.js";
import { ToolRegistry, ToolDispatcher } from "../../src/server/modules/agent/tool-registry.js";
import { VoiceSessionOrchestrator } from "../../src/server/modules/voice/voice-session-orchestrator.js";
import type { VoiceProvider, VoiceSession, VoiceSessionEvents, VoiceProviderConfig } from "../../src/server/modules/voice/voice-provider.js";
import { AgentSseEmitter } from "../../src/server/modules/sse/sse-events.js";

class FakeProvider implements VoiceProvider {
  lastEvents: VoiceSessionEvents | null = null;
  lastConfig: VoiceProviderConfig | null = null;
  sentTool: { callId: string; payload: any } | null = null;
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
      cancelResponse: () => {},
      preloadHistory: (items) => { this.preloaded.push(...items); },
      close: async () => { this.closeCalled = true; }
    };
  }
}

function buildManagerDispatcher(_env: ReturnType<typeof freshAgentEnv>) {
  const registry = new ToolRegistry();
  registry.register({
    name: "list_projects",
    description: "List",
    parameters: z.object({}),
    approval: "never",
    handler: async () => ({ projects: [{ id: "p1", name: "Foo" }] })
  });
  registry.register({
    name: "bash",
    description: "Run shell",
    parameters: z.object({ cmd: z.string() }),
    approval: "always",
    handler: async () => ({})
  });
  return {
    registry: { tools: registry.tools },
    dispatch: async (call: any, ctx: any) =>
      new ToolDispatcher(registry).dispatch(call, ctx)
  };
}

test("VoiceSessionOrchestrator: registers only whitelisted tools with provider", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    // The orchestrator needs the source ToolDefinitions to map. The plan's design
    // is that server.ts wiring (Task 9) passes them in via providerConfig.tools;
    // the orchestrator filters and adds dispatch_to_manager. For this unit
    // test we manually pass the manager scope's source ToolDefinitions.
    const sourceTools = [
      { name: "list_projects", description: "List", parameters: z.object({}), approval: "never" as const, handler: async () => ({}) },
      { name: "bash", description: "Run", parameters: z.object({ cmd: z.string() }), approval: "always" as const, handler: async () => ({}) }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore,
      provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto",
        systemPrompt: "be brief",
        tools: sourceTools
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "wake-id",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000,
      maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();

    expect(provider.lastConfig?.tools.map((t) => t.name).sort()).toEqual([
      "dispatch_to_manager", "list_projects"
    ]);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: dispatches whitelisted tool, persists tool_use + tool_result, sends back to provider", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const sourceTools = [
      { name: "list_projects", description: "List", parameters: z.object({}), approval: "never" as const, handler: async () => ({}) }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore,
      provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: sourceTools
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();
    provider.lastEvents!.onToolCall({ callId: "c1", name: "list_projects", args: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(provider.sentTool?.callId).toBe("c1");
    expect((provider.sentTool?.payload as any).result).toMatchObject({
      projects: [{ id: "p1", name: "Foo" }]
    });

    const thread = env.agentStore.getThreadByScope("manager", null);
    const messages = env.agentStore.getActiveMessages(thread!.id);
    expect(messages.length).toBe(2);
    const toolUse = messages.find((m) => m.role === "assistant");
    const toolResult = messages.find((m) => m.role === "tool");
    expect(toolUse?.source).toBe("voice");
    expect(toolResult?.source).toBe("voice");
    expect((toolResult?.content as any).type).toBe("tool_result");
    expect((toolResult?.content as any).toolCallId).toBe("c1");
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: rejects non-whitelisted tool calls with error result", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const sourceTools = [
      { name: "list_projects", description: "List", parameters: z.object({}), approval: "never" as const, handler: async () => ({}) }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore,
      provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: sourceTools
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();
    provider.lastEvents!.onToolCall({ callId: "c2", name: "bash", args: { cmd: "rm -rf /" } });
    await new Promise((r) => setTimeout(r, 10));

    expect(provider.sentTool?.callId).toBe("c2");
    expect((provider.sentTool?.payload as any).errorMessage).toContain("not allowed");
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: dispatch_to_manager kicks wake + delivers final text on wakeFinished", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    let scheduledWakeId: string | null = null;
    let toolResultWasPresentAtWake = false;
    const sourceTools = [
      { name: "list_projects", description: "List", parameters: z.object({}), approval: "never" as const, handler: async () => ({}) }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore,
      provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: sourceTools
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: (threadId) => {
        scheduledWakeId = "wake-x";
        const messages = env.agentStore.getActiveMessages(threadId);
        toolResultWasPresentAtWake = messages.some(
          (m) =>
            m.role === "tool" &&
            m.content.type === "tool_result" &&
            m.content.toolCallId === "c-manager"
        );
        return "wake-x";
      },
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();
    provider.lastEvents!.onToolCall({
      callId: "c-manager", name: "dispatch_to_manager",
      args: { query: "what's risky in my recent work" }
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(scheduledWakeId).toBe("wake-x");
    expect(toolResultWasPresentAtWake).toBe(true);
    // Voice model gets immediate {status:"started"} ack
    expect(provider.sentTool?.callId).toBe("c-manager");
    expect((provider.sentTool?.payload as any).result).toMatchObject({ status: "started" });

    // Simulate manager agent producing a final answer
    const thread = env.agentStore.getThreadByScope("manager", null)!;
    env.agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "self",
      wakeId: "wake-x",
      content: { type: "assistant", text: "Two PRs need review." }
    });
    await orch.onManagerWakeFinished({
      threadId: thread.id, wakeId: "wake-x", reason: "user",
      status: "finished", triggerMessageId: null
    });

    // The final async answer is injected as new Mandate context so the
    // realtime model can speak a follow-up instead of receiving a duplicate
    // function_call_output for an already-acknowledged call.
    expect(provider.contextMessages).toHaveLength(1);
    expect(provider.contextMessages[0]).toContain("Two PRs need review");
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: idle timeout closes session", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const closeReasons: string[] = [];
    const sourceTools = [
      { name: "list_projects", description: "List", parameters: z.object({}), approval: "never" as const, handler: async () => ({}) }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: sourceTools
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 50, maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    orch.on("onClose", (r) => closeReasons.push(r));
    await orch.start();

    await new Promise((r) => setTimeout(r, 80));
    expect(closeReasons).toContain("idle-timeout");
    expect(provider.closeCalled).toBe(true);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: hard cap closes session", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const closeReasons: string[] = [];
    const sourceTools = [
      { name: "list_projects", description: "List", parameters: z.object({}), approval: "never" as const, handler: async () => ({}) }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: sourceTools
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 600_000, maxSessionMs: 50,
      contextMessageCount: 0
    });
    orch.on("onClose", (r) => closeReasons.push(r));
    await orch.start();

    await new Promise((r) => setTimeout(r, 80));
    expect(closeReasons).toContain("max-session-reached");
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: explicit close fires onClose with client-closed", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const reasons: string[] = [];
    const sourceTools = [
      { name: "list_projects", description: "List", parameters: z.object({}), approval: "never" as const, handler: async () => ({}) }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: sourceTools
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    orch.on("onClose", (r) => reasons.push(r));
    await orch.start();
    await orch.close();
    expect(reasons).toContain("client-closed");
    expect(provider.closeCalled).toBe(true);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: preloads last N dialogue messages, filters tool/summary", async () => {
  const env = freshAgentEnv();
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    // Mix of dialogue, tool, summary, assistant-with-tool-only-no-text
    env.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "msg1-user" }
    });
    env.agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "manager",
      content: { type: "assistant", text: "msg2-asst" }
    });
    env.agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "manager",
      content: { type: "assistant", toolCalls: [{ toolCallId: "c1", toolName: "x", args: {} }] }
    }); // skipped — no text
    env.agentStore.appendMessage({
      threadId: thread.id, role: "tool", source: "manager",
      content: { type: "tool_result", toolCallId: "c1", toolName: "x", result: {} }
    }); // skipped — tool role
    env.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "compression",
      content: { type: "summary", summary: "old", replacedRange: [1, 5], replacedCount: 5 }
    }); // skipped — summary type
    env.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "msg3-user" }
    });

    const provider = new FakeProvider();
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000,
      contextMessageCount: 10
    });
    await orch.start();

    expect(provider.preloaded).toEqual([
      { role: "user", text: "msg1-user" },
      { role: "assistant", text: "msg2-asst" },
      { role: "user", text: "msg3-user" }
    ]);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: preloads at most contextMessageCount", async () => {
  const env = freshAgentEnv();
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    for (let i = 0; i < 25; i++) {
      env.agentStore.appendMessage({
        threadId: thread.id,
        role: i % 2 === 0 ? "user" : "assistant",
        source: i % 2 === 0 ? "user" : "manager",
        content: i % 2 === 0
          ? { type: "text", text: `u${i}` }
          : { type: "assistant", text: `a${i}` }
      });
    }
    const provider = new FakeProvider();
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000,
      contextMessageCount: 10
    });
    await orch.start();

    // Pattern: i=0 even → u0 (user), i=1 odd → a1 (assistant), …, i=24 even → u24 (user)
    // Last 10 are i=15..24
    expect(provider.preloaded).toHaveLength(10);
    expect(provider.preloaded[0]).toEqual({ role: "assistant", text: "a15" }); // i=15 odd
    expect(provider.preloaded[9]).toEqual({ role: "user", text: "u24" });       // i=24 even
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: empty thread → no preload", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000,
      contextMessageCount: 10
    });
    await orch.start();

    expect(provider.preloaded).toEqual([]);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: contextMessageCount=0 → no preload even with messages", async () => {
  const env = freshAgentEnv();
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    env.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "should-be-skipped" }
    });
    const provider = new FakeProvider();
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();

    expect(provider.preloaded).toEqual([]);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: persists final user transcript to manager thread", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const sse = new AgentSseEmitter();
    const sseEvents: any[] = [];
    sse.addSink((e) => {
      if (e.event === "agentMessageAppended") sseEvents.push(e.data);
    });
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse,
      idleTimeoutMs: 60_000, maxSessionMs: 600_000, contextMessageCount: 0
    });
    await orch.start();

    // Simulate provider firing onTranscript with isFinal=true for user
    provider.lastEvents!.onTranscript({ speaker: "user", text: "hello world", isFinal: true });

    const thread = env.agentStore.getThreadByScope("manager", null)!;
    const msgs = env.agentStore.getActiveMessages(thread.id);
    const userMsgs = msgs.filter((m) => m.role === "user" && m.source === "voice");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toEqual({ type: "text", text: "hello world" });
    expect(sseEvents).toHaveLength(1);
    expect((sseEvents[0] as any).threadId).toBe(thread.id);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: persists final assistant transcript with toolCalls=[]", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000, contextMessageCount: 0
    });
    await orch.start();

    provider.lastEvents!.onTranscript({ speaker: "assistant", text: "hi there", isFinal: true });

    const thread = env.agentStore.getThreadByScope("manager", null)!;
    const msgs = env.agentStore.getActiveMessages(thread.id);
    const asstMsgs = msgs.filter((m) => m.role === "assistant" && m.source === "voice");
    expect(asstMsgs).toHaveLength(1);
    expect(asstMsgs[0].content).toEqual({ type: "assistant", text: "hi there", toolCalls: [] });
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: non-final transcript deltas do NOT persist", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000, contextMessageCount: 0
    });
    await orch.start();

    provider.lastEvents!.onTranscript({ speaker: "user", text: "hel", isFinal: false });
    provider.lastEvents!.onTranscript({ speaker: "user", text: "hello", isFinal: false });

    const thread = env.agentStore.getThreadByScope("manager", null)!;
    const msgs = env.agentStore.getActiveMessages(thread.id);
    expect(msgs.filter((m) => m.source === "voice")).toHaveLength(0);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: empty final transcript text → no persistence", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000, contextMessageCount: 0
    });
    await orch.start();

    provider.lastEvents!.onTranscript({ speaker: "user", text: "", isFinal: true });
    provider.lastEvents!.onTranscript({ speaker: "user", text: "   ", isFinal: true });

    const thread = env.agentStore.getThreadByScope("manager", null)!;
    const msgs = env.agentStore.getActiveMessages(thread.id);
    expect(msgs.filter((m) => m.source === "voice")).toHaveLength(0);
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: forwards transcript to outbound regardless of isFinal", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore, provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto", systemPrompt: "",
        tools: []
      },
      managerDispatcher: buildManagerDispatcher(env),
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000, maxSessionMs: 600_000, contextMessageCount: 0
    });
    const transcripts: any[] = [];
    orch.on("onTranscript", (d) => transcripts.push(d));
    await orch.start();

    provider.lastEvents!.onTranscript({ speaker: "user", text: "hel", isFinal: false });
    provider.lastEvents!.onTranscript({ speaker: "user", text: "hello", isFinal: true });

    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toMatchObject({ text: "hel", isFinal: false });
    expect(transcripts[1]).toMatchObject({ text: "hello", isFinal: true });
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: injects background feature-task completion into realtime context", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    let featureThreadId = "";
    let featureWakeId = "";
    let taskId = "";
    let dispatchedArgs: any = null;
    const fakeDispatcher = {
      registry: { tools: {} },
      dispatch: async (call: any, ctx: any) => {
        dispatchedArgs = call.args;
        const thread = env.agentStore.getOrCreateThread("worker", "feature-1");
        const task = env.agentStore.createTask({
          featureId: "feature-1",
          threadId: thread.id,
          source: "agent",
          channel: "voice",
          title: "voice task",
          message: "do it",
          callerThreadId: ctx.threadId,
          createdByThreadId: ctx.threadId
        });
        const taskMsg = env.agentStore.appendMessage({
          threadId: thread.id,
          role: "user",
          source: "manager",
          content: { type: "text", text: "do it" }
        });
        const wake = env.agentStore.createWake({
          threadId: thread.id,
          reason: "user",
          triggerMessageId: taskMsg.id
        });
        featureThreadId = thread.id;
        featureWakeId = wake.id;
        taskId = task.id;
        return { result: { taskId: task.id, featureThreadId: thread.id, status: "started" } };
      }
    };
    const sourceTools = [
      {
        name: "feature_task_send",
        description: "x",
        parameters: z.object({
          feature: z.string(),
          message: z.string()
        }),
        approval: "never" as const,
        handler: async () => ({})
      }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore,
      provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto",
        systemPrompt: "", tools: sourceTools
      },
      managerDispatcher: fakeDispatcher,
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000,
      maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();

    provider.lastEvents!.onToolCall({
      callId: "c-feature",
      name: "feature_task_send",
      args: { feature: "feature-1", message: "do it" }
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(provider.sentTool?.callId).toBe("c-feature");
    expect((provider.sentTool?.payload as any).result).toMatchObject({
      taskId,
      featureThreadId
    });
    expect(dispatchedArgs).toMatchObject({ channel: "voice" });

    env.agentStore.appendMessage({
      threadId: featureThreadId,
      role: "assistant",
      source: "self",
      wakeId: featureWakeId,
      content: { type: "assistant", text: "Feature task is done." }
    });
    await orch.onManagerWakeFinished({
      threadId: featureThreadId,
      wakeId: featureWakeId,
      reason: "user",
      status: "finished",
      triggerMessageId: null
    });

    expect(provider.contextMessages).toHaveLength(1);
    expect(provider.contextMessages[0]).toContain("Feature task is done.");
    expect(provider.contextMessages[0]).toContain("background worker task completed");
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: preserves feature-task followup when dispatch is queued", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    let featureThreadId = "";
    let featureWakeId = "";
    let taskId = "";
    let dispatchedArgs: any = null;
    const fakeDispatcher = {
      registry: { tools: {} },
      dispatch: async (call: any, ctx: any) => {
        dispatchedArgs = call.args;
        const thread = env.agentStore.getOrCreateThread("worker", "feature-queued");
        const task = env.agentStore.createTask({
          featureId: "feature-queued",
          threadId: thread.id,
          source: "agent",
          channel: "voice",
          title: "queued voice task",
          message: "do it after compression",
          callerThreadId: ctx.threadId,
          createdByThreadId: ctx.threadId
        });
        featureThreadId = thread.id;
        taskId = task.id;
        return { result: { taskId: task.id, featureThreadId: thread.id, status: "queued" } };
      }
    };
    const sourceTools = [
      {
        name: "feature_task_send",
        description: "x",
        parameters: z.object({
          feature: z.string(),
          message: z.string()
        }),
        approval: "never" as const,
        handler: async () => ({})
      }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore,
      provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto",
        systemPrompt: "", tools: sourceTools
      },
      managerDispatcher: fakeDispatcher,
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000,
      maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();

    provider.lastEvents!.onToolCall({
      callId: "c-feature-queued",
      name: "feature_task_send",
      args: { feature: "feature-queued", message: "do it after compression" }
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(provider.sentTool?.callId).toBe("c-feature-queued");
    expect((provider.sentTool?.payload as any).result).toMatchObject({
      taskId,
      featureThreadId,
      status: "queued"
    });
    expect(dispatchedArgs).toMatchObject({ channel: "voice" });
    expect(provider.contextMessages).toHaveLength(0);

    const wake = env.agentStore.createWake({
      threadId: featureThreadId,
      reason: "user",
      triggerMessageId: null
    });
    featureWakeId = wake.id;
    env.agentStore.appendMessage({
      threadId: featureThreadId,
      role: "assistant",
      source: "self",
      wakeId: featureWakeId,
      content: { type: "assistant", text: "Queued feature task is done." }
    });
    await orch.onManagerWakeFinished({
      threadId: featureThreadId,
      wakeId: featureWakeId,
      reason: "user",
      status: "finished",
      triggerMessageId: null
    });

    expect(provider.contextMessages).toHaveLength(1);
    expect(provider.contextMessages[0]).toContain("Queued feature task is done.");
    expect(provider.contextMessages[0]).toContain("background worker task completed");
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: queued feature-task dispatch waits past the current running wake", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    let featureThreadId = "";
    let currentWakeId = "";
    let taskId = "";
    const fakeDispatcher = {
      registry: { tools: {} },
      dispatch: async (_call: any, ctx: any) => {
        const thread = env.agentStore.getOrCreateThread("worker", "feature-running-queued");
        const task = env.agentStore.createTask({
          featureId: "feature-running-queued",
          threadId: thread.id,
          source: "agent",
          channel: "voice",
          title: "queued while running",
          message: "do it after this wake",
          callerThreadId: ctx.threadId,
          createdByThreadId: ctx.threadId
        });
        const wake = env.agentStore.createWake({
          threadId: thread.id,
          reason: "user",
          triggerMessageId: null
        });
        featureThreadId = thread.id;
        currentWakeId = wake.id;
        taskId = task.id;
        return { result: { taskId: task.id, featureThreadId: thread.id, status: "queued" } };
      }
    };
    const sourceTools = [
      {
        name: "feature_task_send",
        description: "x",
        parameters: z.object({
          feature: z.string(),
          message: z.string()
        }),
        approval: "never" as const,
        handler: async () => ({})
      }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore,
      provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto",
        systemPrompt: "", tools: sourceTools
      },
      managerDispatcher: fakeDispatcher,
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000,
      maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();

    provider.lastEvents!.onToolCall({
      callId: "c-feature-running-queued",
      name: "feature_task_send",
      args: { feature: "feature-running-queued", message: "do it after this wake" }
    });
    await new Promise((r) => setTimeout(r, 5));

    expect((provider.sentTool?.payload as any).result).toMatchObject({
      taskId,
      featureThreadId,
      status: "queued"
    });

    env.agentStore.appendMessage({
      threadId: featureThreadId,
      role: "assistant",
      source: "self",
      wakeId: currentWakeId,
      content: { type: "assistant", text: "Unrelated current wake output." }
    });
    await orch.onManagerWakeFinished({
      threadId: featureThreadId,
      wakeId: currentWakeId,
      reason: "user",
      status: "finished",
      triggerMessageId: null
    });
    expect(provider.contextMessages).toHaveLength(0);

    const actualWake = env.agentStore.createWake({
      threadId: featureThreadId,
      reason: "user",
      triggerMessageId: null
    });
    env.agentStore.appendMessage({
      threadId: featureThreadId,
      role: "assistant",
      source: "self",
      wakeId: actualWake.id,
      content: { type: "assistant", text: "Actual queued task output." }
    });
    await orch.onManagerWakeFinished({
      threadId: featureThreadId,
      wakeId: actualWake.id,
      reason: "user",
      status: "finished",
      triggerMessageId: null
    });

    expect(provider.contextMessages).toHaveLength(1);
    expect(provider.contextMessages[0]).toContain("Actual queued task output.");
    expect(provider.contextMessages[0]).not.toContain("Unrelated current wake output.");
  } finally { env.cleanup(); }
});

test("VoiceSessionOrchestrator: queued feature-task dispatch follows up when completed in current wake", async () => {
  const env = freshAgentEnv();
  try {
    const provider = new FakeProvider();
    let featureThreadId = "";
    let currentWakeId = "";
    let taskId = "";
    const fakeDispatcher = {
      registry: { tools: {} },
      dispatch: async (_call: any, ctx: any) => {
        const thread = env.agentStore.getOrCreateThread("worker", "feature-current-wake-done");
        const task = env.agentStore.createTask({
          featureId: "feature-current-wake-done",
          threadId: thread.id,
          source: "agent",
          channel: "voice",
          title: "queued and drained",
          message: "complete during this wake",
          callerThreadId: ctx.threadId,
          createdByThreadId: ctx.threadId
        });
        const wake = env.agentStore.createWake({
          threadId: thread.id,
          reason: "user",
          triggerMessageId: null
        });
        featureThreadId = thread.id;
        currentWakeId = wake.id;
        taskId = task.id;
        return { result: { taskId: task.id, featureThreadId: thread.id, status: "queued" } };
      }
    };
    const sourceTools = [
      {
        name: "feature_task_send",
        description: "x",
        parameters: z.object({
          feature: z.string(),
          message: z.string()
        }),
        approval: "never" as const,
        handler: async () => ({})
      }
    ];
    const orch = new VoiceSessionOrchestrator({
      agentStore: env.agentStore,
      provider,
      providerConfig: {
        apiKey: "k", model: "m", voice: "alloy", language: "auto",
        systemPrompt: "", tools: sourceTools
      },
      managerDispatcher: fakeDispatcher,
      wakeManager: () => "w",
      sse: new AgentSseEmitter(),
      idleTimeoutMs: 60_000,
      maxSessionMs: 600_000,
      contextMessageCount: 0
    });
    await orch.start();

    provider.lastEvents!.onToolCall({
      callId: "c-feature-current-wake-done",
      name: "feature_task_send",
      args: { feature: "feature-current-wake-done", message: "complete during this wake" }
    });
    await new Promise((r) => setTimeout(r, 5));

    expect((provider.sentTool?.payload as any).result).toMatchObject({
      taskId,
      featureThreadId,
      status: "queued"
    });

    env.agentStore.updateTask({
      id: taskId,
      status: "done",
      lastNote: "Completed during the already-running wake."
    });
    env.agentStore.appendMessage({
      threadId: featureThreadId,
      role: "assistant",
      source: "self",
      wakeId: currentWakeId,
      content: { type: "assistant", text: "Current wake completed the queued task." }
    });
    await orch.onManagerWakeFinished({
      threadId: featureThreadId,
      wakeId: currentWakeId,
      reason: "user",
      status: "finished",
      triggerMessageId: null
    });

    expect(provider.contextMessages).toHaveLength(1);
    expect(provider.contextMessages[0]).toContain("Current wake completed the queued task.");
    expect((orch as any).toolCoordinator.pendingCount).toBe(0);
  } finally { env.cleanup(); }
});
