import { expect, test } from "bun:test";
import { MandateStore } from "../../src/server/app/store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import type { AgentScope } from "../../src/server/modules/agent/tool-scope.js";
import { WakeScheduler, type ToolDispatcher } from "../../src/server/modules/agent/wake-loop.js";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { createTestWakeScheduler } from "../helpers/wake-scheduler.js";
import { createMockLLM } from "../helpers/mock-llm.js";
import { tempDir } from "../helpers/temp.js";
import { contentOf } from "../helpers/typed.js";
import { z } from "zod";
import { ToolRegistry, ToolDispatcher as RegistryToolDispatcher } from "../../src/server/modules/agent/tool-registry.js";
import { freshAgentEnv } from "../helpers/fixtures.js";

function fresh() {
  const store = new MandateStore(tempDir("md-wl-"));
  return { store, agentStore: new AgentStore(store.db) };
}

const STUB_PROMPT_BUILDER = (_threadId: string) => "stub system prompt";
const STUB_SCOPE_BUILDER = (_threadId: string): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const STUB_TOOL_DISPATCHER: ToolDispatcher = {
  registry: { tools: {} },
  async dispatch(call) {
    if (call.toolName === "fakeOk") return { result: { ok: true } };
    if (call.toolName === "fakeErr") return { result: null, isError: true, error: "boom" };
    return { result: null, isError: true, error: `unknown tool ${call.toolName}` };
  }
};

function createFailingStreamLLM(message: string): LanguageModelV3 {
  return {
    specificationVersion: "v3" as const,
    provider: "mock",
    modelId: "mock-fail",
    supportedUrls: {},
    async doGenerate() {
      throw new Error(message);
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.error(new Error(message));
          }
        })
      };
    }
  };
}

test("WakeScheduler: falls back to the next model when primary fails before output", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-A");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "hello" }
  });
  const primary = createFailingStreamLLM("primary unavailable");
  const fallback = createMockLLM([
    { text: "fallback response", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 4 } }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: primary,
    llmForThread: () => ({
      model: primary,
      candidates: [
        { model: primary, meta: { provider: "openai", model: "primary", baseURL: "" } },
        { model: fallback, meta: { provider: "openai-compatible", model: "fallback", baseURL: "https://backup.example/v1" } }
      ]
    }),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });
  const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
  const wake = agentStore.getWakeById(wakeId)!;
  const msgs = agentStore.getActiveMessages(thread.id);
  expect(wake.status).toBe("finished");
  expect(msgs.at(-1)!.role).toBe("assistant");
  expect(contentOf(msgs.at(-1)!, "assistant").text).toBe("fallback response");
  expect(fallback.callsMade).toBe(1);
});

test("WakeScheduler: keeps accepted image attachments when only primary supports images", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-A");
  const imageBase64 = "iVBORw0KGgo=";
  const trigger = agentStore.appendMessage({
    threadId: thread.id,
    role: "user",
    source: "user",
    content: {
      type: "text",
      text: "look",
      attachments: [{
        type: "image",
        id: "img-test",
        name: "shot.png",
        mediaType: "image/png",
        data: imageBase64,
        sizeBytes: 8
      }]
    }
  });
  const llm = createMockLLM([
    { text: "saw it", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 4 } }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore,
    lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    llmForThread: () => ({
      model: llm,
      candidates: [
        { model: llm, supportsImageInput: true, meta: { provider: "openai", model: "primary-vision", baseURL: "" } },
        { model: llm, supportsImageInput: false, meta: { provider: "openai-compatible", model: "fallback-text", baseURL: "https://backup.example/v1" } }
      ]
    }),
    // The thread's own model, the primary, takes images; its fallback does not.
    supportsInputForThread: () => true,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  await wakeAndWait(thread.id, "user", trigger.id);
  const messages = llm.streamCalls[0]!.prompt;
  const userMessage = messages.find((message) => message.role === "user")!;
  expect(JSON.stringify(userMessage.content)).toContain(imageBase64);
  expect(JSON.stringify(userMessage.content)).toContain("image/png");
  expect(JSON.stringify(userMessage.content)).not.toContain("omitted because the current model does not support image input");
});

test("WakeScheduler: skips text-only fallback when view_image result is in prompt", async () => {
  const { agentStore } = fresh();
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const imageBase64 = "iVBORw0KGgo=";
    const trigger = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "inspect screenshot" }
    });
    agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "self",
      content: {
        type: "assistant",
        toolCalls: [{ toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } }]
      }
    });
    agentStore.appendMessage({
      threadId: thread.id,
      role: "tool",
      source: "self",
      content: {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "view_image",
        result: {
          type: "view_image_result",
          message: "Viewed image: screenshot.png",
          image: {
            type: "image",
            id: "img-1",
            name: "screenshot.png",
            displayPath: "screenshot.png",
            mediaType: "image/png",
            data: imageBase64,
            sizeBytes: 8
          }
        }
      }
    });
    const primary = createMockLLM([{ error: "primary unavailable" }]);
    const fallback = createMockLLM([{ text: "fallback should be skipped", finishReason: "stop" }]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore,
      lock: new WakeLock(),
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
      llmModel: primary,
      llmForThread: () => ({
        model: primary,
        candidates: [
          {
            model: primary,
            supportsImageInput: true,
            meta: { provider: "openai", model: "primary-vision", baseURL: "" }
          },
          {
            model: fallback,
            supportsImageInput: false,
            meta: { provider: "openai-compatible", model: "fallback-text", baseURL: "https://backup.example/v1" }
          }
        ]
      }),
      supportsInputForThread: (_threadId, input) => input === "image" ? true : true,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER
    });

    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);

    expect(primary.callsMade).toBeGreaterThan(0);
    expect(JSON.stringify(primary.streamCalls[0]!.prompt)).toContain(imageBase64);
    expect(fallback.callsMade).toBe(0);
    expect(agentStore.getWakeById(wakeId)!.status).toBe("error");
  } finally {
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("WakeScheduler: omits view_image bytes for chat-backed image-capable paths", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-A");
  const imageBase64 = "iVBORw0KGgo=";
  const trigger = agentStore.appendMessage({
    threadId: thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "inspect screenshot" }
  });
  agentStore.appendMessage({
    threadId: thread.id,
    role: "assistant",
    source: "self",
    content: {
      type: "assistant",
      toolCalls: [{ toolCallId: "call-1", toolName: "view_image", args: { path: "screenshot.png" } }]
    }
  });
  agentStore.appendMessage({
    threadId: thread.id,
    role: "tool",
    source: "self",
    content: {
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "view_image",
      result: {
        type: "view_image_result",
        message: "Viewed image: screenshot.png",
        image: {
          type: "image",
          id: "img-1",
          name: "screenshot.png",
          displayPath: "screenshot.png",
          mediaType: "image/png",
          data: imageBase64,
          sizeBytes: 8
        }
      }
    }
  });
  const llm = createMockLLM([
    { text: "cannot view that on this model path", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore,
    lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    llmForThread: () => ({
      model: llm,
      candidates: [{
        model: llm,
        supportsImageInput: true,
        supportsToolResultImages: false,
        meta: { provider: "kilo", model: "kilo-auto/balanced", baseURL: "https://api.kilo.ai/api/gateway" }
      }]
    }),
    supportsInputForThread: (_threadId, input) => input === "image" ? true : true,
    supportsToolResultImagesForThread: () => false,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  await wakeAndWait(thread.id, "user", trigger.id);

  const promptText = JSON.stringify(llm.streamCalls[0]!.prompt);
  expect(promptText).not.toContain(imageBase64);
  expect(promptText).not.toContain("image-data");
  expect(promptText).toContain("does not support image tool-result input");
});

test("WakeScheduler: tool call → result → agent final, two steps, finishes", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-A");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "do it" }
  });
  const llm = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }],
      finishReason: "tool-calls" },
    { text: "Done.", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });
  await wakeAndWait(thread.id, "user", trigger.id);
  const msgs = agentStore.getActiveMessages(thread.id);
  // user(trigger) + assistant(tool_calls) + tool(result) + assistant(text)
  expect(msgs.length).toBe(4);
  expect(msgs[1]!.role).toBe("assistant");
  expect(contentOf(msgs[1]!, "assistant").toolCalls?.length).toBe(1);
  expect(msgs[2]!.role).toBe("tool");
  expect(contentOf(msgs[2]!, "tool_result").toolCallId).toBe("c1");
  expect(msgs[3]!.role).toBe("assistant");
});

class CapturingSse {
  events: Array<{ name: string; data: any }> = [];
  emit(name: string, data: any) { this.events.push({ name, data }); }
}

test("end-to-end: user message → tool call → tool result → agent final, SSE events emitted in order", async () => {
  const { agentStore } = freshAgentEnv("md-mflow-");
  const reg = new ToolRegistry();
  reg.register({
    name: "echo", description: "Echo",
    parameters: z.object({ text: z.string() }),
    handler: async ({ text }) => ({ echoed: text })
  });
  const dispatcher = new RegistryToolDispatcher(reg);
  const sse = new CapturingSse();
  const llm = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "echo", args: { text: "yo" } }],
      finishReason: "tool-calls" },
    { text: "Echoed.", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(), 
    buildSystemPrompt: () => "stub", toolDispatcherForThread: () => dispatcher,
    llmModel: llm, sse: sse,
    buildToolScope: () => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } })
  });

  const thread = agentStore.getOrCreateThread("worker", "feat-A");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "say yo" }
  });
  const wakeId = await wakeAndWait(thread.id, "user", trigger.id);

  const names = sse.events.map((e) => e.name);
  expect(names[0]).toBe("agentWakeStarted");
  expect(names.filter((n) => n === "agentMessageAppended").length >= 3).toBeTruthy();
  expect(names.at(-1)).toBe("agentWakeFinished");

  const wake = agentStore.getWakeById(wakeId)!;
  expect(wake.status).toBe("finished");

  // Check that delta events carry the expected payload shape (when present).
  const deltas = sse.events.filter((e) => e.name === "agentMessageDelta");
  for (const d of deltas) {
    expect("threadId" in d.data).toBeTruthy();
    expect("wakeId" in d.data).toBeTruthy();
    expect("deltaText" in d.data).toBeTruthy();
    expect("totalText" in d.data).toBeTruthy();
  }
});

test("WakeScheduler: preStepHook drains mailbox before the next model step", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("manager", null);
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "delegate work" }
  });
  const llm = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }],
      finishReason: "tool-calls" },
    { text: "I saw the feature result.", finishReason: "stop" }
  ]);
  const dispatcher: ToolDispatcher = {
    registry: STUB_TOOL_DISPATCHER.registry,
    async dispatch(call, ctx) {
      agentStore.enqueueMailboxMessage({
        threadId: thread.id,
        role: "user",
        source: "manager",
        sourceThreadId: "feature-thread",
        content: {
          type: "text",
          text: "Feature task completed."
        }
      });
      return STUB_TOOL_DISPATCHER.dispatch(call, ctx);
    }
  };
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => dispatcher,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER,
    preStepHook: (threadId, info) => {
      agentStore.drainMailboxToMessages(threadId, info.wakeId);
    }
  });

  await wakeAndWait(thread.id, "user", trigger.id);
  const msgs = agentStore.getActiveMessages(thread.id);
  expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
  expect(msgs[3]!.source).toBe("manager");
  expect(msgs[3]!.content.type).toBe("text");
  expect(agentStore.hasQueuedMailboxMessages(thread.id)).toBe(false);
});

test("WakeScheduler: tool error message recorded, wake continues", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-A");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "go" }
  });
  const llm = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "fakeErr", args: {} }], finishReason: "tool-calls" },
    { text: "Recovered.", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });
  await wakeAndWait(thread.id, "user", trigger.id);
  const msgs = agentStore.getActiveMessages(thread.id);
  const toolMsg = msgs.find((m) => m.role === "tool")!;
  expect(contentOf(toolMsg, "tool_result").isError).toBe(true);
  expect(msgs.at(-1)!.role).toBe("assistant");
});

test("WakeScheduler: tolerates persisted tool results that were separated by voice messages", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("manager", null);
  agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "previous task" }
  });
  agentStore.appendMessage({
    threadId: thread.id,
    role: "assistant",
    source: "self",
    wakeId: "old-wake",
    content: {
      type: "assistant",
      toolCalls: [{ toolCallId: "c-old", toolName: "fakeOk", args: {} }]
    }
  });
  agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "voice",
    content: { type: "text", text: "voice message while old tool was running" }
  });
  agentStore.appendMessage({
    threadId: thread.id,
    role: "tool",
    source: "self",
    wakeId: "old-wake",
    content: {
      type: "tool_result",
      toolCallId: "c-old",
      toolName: "fakeOk",
      result: { ok: true }
    }
  });
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "next task" }
  });

  const llm = createMockLLM([
    { text: "Still works.", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("finished");
  expect(llm.callsMade).toBe(1);
});

// The post-wake hook is told only the wake and how it ended; the token counts
// a wake saw are kept on its row (and read from there by context usage).
test("WakeScheduler: a wake records its latest and largest input-token counts and its steps", async () => {
  const { store, agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-token-hook");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "use a tool" }
  });
  const llm = createMockLLM([
    {
      toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }],
      finishReason: "tool-calls",
      usage: { promptTokens: 140, completionTokens: 5 }
    },
    {
      text: "Done.",
      finishReason: "stop",
      usage: { promptTokens: 120, completionTokens: 3 }
    }
  ]);
  const postWakeEvents: any[] = [];
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER,
    postWakeHook: (threadId, info) => { postWakeEvents.push({ threadId, info }); }
  });

  await wakeAndWait(thread.id, "user", trigger.id);

  expect(postWakeEvents.length).toBe(1);
  expect(postWakeEvents[0].threadId).toBe(thread.id);
  expect(postWakeEvents[0].info).toEqual({ wakeId: postWakeEvents[0].info.wakeId, status: "finished" });
  const row = store.db.prepare("select last_input_tokens, max_input_tokens, step_count from agent_wakes where id = ?")
    .get(postWakeEvents[0].info.wakeId) as { last_input_tokens: number; max_input_tokens: number; step_count: number };
  expect(row).toEqual({ last_input_tokens: 120, max_input_tokens: 140, step_count: 2 });
});

test("WakeScheduler: wake finished SSE includes context budget usage", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-context-event");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "hello" }
  });
  const llm = createMockLLM([
    { text: "Ready.", finishReason: "stop", usage: { promptTokens: 17, completionTokens: 3 } }
  ]);
  const events: Array<{ name: string; data: any }> = [];
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    contextBudgetTokens: 170,
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  await wakeAndWait(thread.id, "user", trigger.id);

  const updatedIndex = events.findIndex((event) => event.name === "agentContextUsageUpdated");
  const finishedIndex = events.findIndex((event) => event.name === "agentWakeFinished");
  expect(updatedIndex).toBeGreaterThanOrEqual(0);
  expect(finishedIndex).toBeGreaterThan(updatedIndex);
  expect(events[updatedIndex]!.data.contextUsage).toMatchObject({
    inputTokens: 17,
    budgetTokens: 170,
    source: "compression_budget"
  });
  const finished = events[finishedIndex]!;
  expect(finished.data.contextUsage).toMatchObject({
    inputTokens: 17,
    budgetTokens: 170,
    source: "compression_budget"
  });
});

test("WakeScheduler: preWakeHook completes before the first LLM step", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-pre-hook");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "hello" }
  });
  const llm = createMockLLM([
    { text: "Ready.", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 3 } }
  ]);
  const events: string[] = [];
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => {
      events.push("prompt");
      return "stub system prompt";
    },
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER,
    preWakeHook: async (_threadId, info) => {
      events.push("pre-start");
      expect(info.wakeId).toBeTruthy();
      expect(info.triggerMessageId).toBe(trigger.id);
      await new Promise((resolve) => setImmediate(resolve));
      events.push("pre-end");
    }
  });

  await wakeAndWait(thread.id, "user", trigger.id);

  expect(events).toStrictEqual(["pre-start", "pre-end", "prompt"]);
});

test("WakeScheduler: beforeModelCallHook can compress and rebuild runtime context before prompt", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-step-compress");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "hello" }
  });
  const llm = createMockLLM([
    { text: "Ready.", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 3 } }
  ]);
  let initialBuilds = 0;
  let runtimeBuilds = 0;
  let compressed = false;
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    buildInitialContext: () => `baseline-v${++initialBuilds}`,
    buildRuntimeContext: () => `context-v${++runtimeBuilds}`,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER,
    beforeModelCallHook: (threadId, info) => {
      expect(threadId).toBe(thread.id);
      expect(info.wakeId).toBeTruthy();
      expect(info.triggerMessageId).toBe(trigger.id);
      const active = agentStore.getActiveMessages(threadId);
      expect(active.some((message) => message.source === "runtime-context")).toBe(true);
      const firstSeq = active[0]!.seq;
      const lastSeq = active.at(-1)!.seq;
      agentStore.appendMessage({
        threadId,
        role: "user",
        source: "compression",
        content: {
          type: "summary",
          summary: "compressed before model",
          replacedRange: [firstSeq, lastSeq],
          replacedCount: active.length,
          retained: []
        }
      });
      compressed = true;
      return { historyChanged: true };
    }
  });

  await wakeAndWait(thread.id, "user", trigger.id);

  expect(compressed).toBe(true);
  expect(initialBuilds).toBe(2);
  expect(runtimeBuilds).toBe(2);
  const promptText = JSON.stringify(llm.streamCalls[0]!.prompt);
  expect(promptText).toContain("compressed before model");
  expect(promptText).toContain("baseline-v2");
  expect(promptText).toContain("context-v2");
  expect(promptText).not.toContain("baseline-v1");
  expect(promptText).not.toContain("context-v1");

  const contexts = agentStore.getActiveMessages(thread.id).filter((message) =>
    message.source === "runtime-context"
  );
  expect(contexts).toHaveLength(1);
  const contextText = contexts[0]!.content.type === "text" ? contexts[0]!.content.text : "";
  expect(contextText).toContain("[initial_context]");
  expect(contextText).toContain("baseline-v2");
  expect(contextText).toContain("context-v2");
});

test("WakeScheduler: system prompt is immutable and runtime context is append-only", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-context");
  let systemVersion = "system-v1";
  let initialVersion = "skills-v1";
  let contextVersion = "context-v1";
  let systemBuilds = 0;
  const llm = createMockLLM([
    { text: "one", finishReason: "stop" },
    { text: "two", finishReason: "stop" },
    { text: "three", finishReason: "stop" },
    { text: "four", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => {
      systemBuilds++;
      return systemVersion;
    },
    buildInitialContext: () => initialVersion,
    buildRuntimeContext: () => contextVersion,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  const first = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "first" }
  });
  await wakeAndWait(thread.id, "user", first.id);
  expect(agentStore.getSystemMessage(thread.id)?.content).toMatchObject({
    type: "text",
    text: "system-v1"
  });
  expect(systemBuilds).toBe(1);

  systemVersion = "system-v2";
  contextVersion = "context-v2";
  const second = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "second" }
  });
  await wakeAndWait(thread.id, "user", second.id);
  expect(agentStore.getSystemMessage(thread.id)?.content).toMatchObject({
    type: "text",
    text: "system-v1"
  });

  const third = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "third" }
  });
  await wakeAndWait(thread.id, "user", third.id);

  const contexts = agentStore.getActiveMessages(thread.id).filter((message) =>
    message.source === "runtime-context"
  );
  expect(contexts.length).toBe(2);
  expect(contexts[0]!.content.type).toBe("text");
  expect(contexts[1]!.content.type).toBe("text");
  const initialText = contexts[0]!.content.type === "text" ? contexts[0]!.content.text : "";
  const updateText = contexts[1]!.content.type === "text" ? contexts[1]!.content.text : "";
  expect(initialText).toContain("[initial_context]");
  expect(initialText).toContain("skills-v1");
  expect(initialText).toContain("context-v1");
  expect(updateText).toContain("[runtime_context]");
  expect(updateText).toContain("context-v2");
  expect(updateText).not.toContain("skills-v2");
  expect(contentOf(contexts[0]!, "text").metadata?.runtimeContextMode).toBe("compact");
  expect(contentOf(contexts[1]!, "text").metadata?.runtimeContextMode).toBe("compact");

  agentStore.appendMessage({
    threadId: thread.id,
    role: "user",
    source: "compression",
    content: {
      type: "summary",
      summary: "compressed context",
      replacedRange: [contexts[0]!.seq, contexts.at(-1)!.seq],
      replacedCount: contexts.length,
      retained: []
    }
  });

  initialVersion = "skills-v2";
  contextVersion = "context-v3";
  const fourth = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "fourth" }
  });
  await wakeAndWait(thread.id, "user", fourth.id);

  const rebuiltContexts = agentStore.getActiveMessages(thread.id).filter((message) =>
    message.source === "runtime-context"
  );
  expect(rebuiltContexts.length).toBe(1);
  expect(rebuiltContexts[0]!.content.type).toBe("text");
  const rebuiltText = rebuiltContexts[0]!.content.type === "text" ? rebuiltContexts[0]!.content.text : "";
  expect(rebuiltText).toContain("[initial_context]");
  expect(rebuiltText).toContain("skills-v2");
  expect(rebuiltText).toContain("context-v3");
});

test("WakeScheduler: does not append runtime context for formatting-only state changes", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-context-normalized");
  let runtimeContext = "## State\n- pane working";
  const llm = createMockLLM([
    { text: "first", finishReason: "stop" },
    { text: "second", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    buildInitialContext: () => "baseline",
    buildRuntimeContext: () => runtimeContext,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  const first = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "first" }
  });
  await wakeAndWait(thread.id, "user", first.id);

  runtimeContext = "  ##   State  \n  -   pane   working  ";
  const second = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "second" }
  });
  await wakeAndWait(thread.id, "user", second.id);

  const contexts = agentStore.getActiveMessages(thread.id).filter((message) =>
    message.source === "runtime-context"
  );
  expect(contexts.length).toBe(1);
  expect(contexts[0]!.content.type).toBe("text");
  expect(contentOf(contexts[0]!, "text").text).toContain("[initial_context]");
});

test("WakeScheduler: appends at most one runtime context update during one tool wake", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-context-once");
  let runtimeContextSeq = 0;
  const llm = createMockLLM([
    { text: "ready", finishReason: "stop" },
    { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
    { toolCalls: [{ toolCallId: "c2", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
    { text: "done", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    buildInitialContext: () => "baseline",
    buildRuntimeContext: () => `context-v${++runtimeContextSeq}`,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  const first = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "prime context" }
  });
  await wakeAndWait(thread.id, "user", first.id);

  const second = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "run tools" }
  });
  await wakeAndWait(thread.id, "user", second.id);

  const contexts = agentStore.getActiveMessages(thread.id).filter((message) =>
    message.source === "runtime-context"
  );
  expect(contexts.length).toBe(2);
  const updateText = contexts[1]!.content.type === "text" ? contexts[1]!.content.text : "";
  expect(updateText).toContain("[runtime_context]");
  expect(updateText).toContain("context-v2");
  expect(updateText).not.toContain("context-v3");
  expect(contentOf(contexts[0]!, "text").metadata?.runtimeContextMode).toBe("compact");
  expect(contentOf(contexts[1]!, "text").metadata?.runtimeContextMode).toBe("compact");
});

test("WakeScheduler: the wake that sends a thread's first context sends no update after it", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-context-initial");
  let runtimeContextSeq = 0;
  const llm = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
    { toolCalls: [{ toolCallId: "c2", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
    { text: "done", finishReason: "stop" }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    buildInitialContext: () => "baseline",
    // A new state on every step: only the first step's goes out.
    buildRuntimeContext: () => `context-v${++runtimeContextSeq}`,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });
  const ask = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "run tools" }
  });
  await wakeAndWait(thread.id, "user", ask.id);

  const contexts = agentStore.getActiveMessages(thread.id).filter((message) => message.source === "runtime-context");
  expect(contexts.map((message) => contentOf(message, "text").metadata?.runtimeContextKind)).toStrictEqual(["initial"]);
  expect(runtimeContextSeq).toBe(3);
});

test("WakeScheduler: cancelWake stops a wake before the first model step", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-cancel");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "stop me" }
  });
  let releasePreWake!: () => void;
  let markPreWakeStarted!: () => void;
  const preWakeStarted = new Promise<void>((resolve) => {
    markPreWakeStarted = resolve;
  });
  const releasePreWakePromise = new Promise<void>((resolve) => {
    releasePreWake = resolve;
  });
  const llm = createMockLLM([
    { text: "should not run", finishReason: "stop" }
  ]);
  let scheduler!: WakeScheduler;
  let canceledEvent: Record<string, unknown> | null = null;
  const finished = new Promise<void>((resolve) => {
    scheduler = new WakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
      llmModel: llm,
      sse: {
        emit: (name, data: any) => {
          if (name === "agentWakeFinished" && data.status === "canceled") { canceledEvent = data; resolve(); }
        }
      },
      buildToolScope: STUB_SCOPE_BUILDER,
      preWakeHook: async () => {
        markPreWakeStarted();
        await releasePreWakePromise;
      }
    });
  });

  const wakeId = scheduler.wake(thread.id, "user", trigger.id)!;
  await preWakeStarted;
  expect(scheduler.cancelWake(wakeId)).toMatchObject({ ok: true, wakeId });
  releasePreWake();
  await finished;
  expect(Object.keys(canceledEvent!).sort()).toEqual(["contextUsage", "errorMessage", "scope", "scopeId", "status", "threadId", "wakeId"]);
  const wake = agentStore.getRunningWakeForThread(thread.id);
  expect(wake).toBe(null);
  expect(agentStore.getActiveMessages(thread.id).length).toBe(1);
  expect(llm.callsMade).toBe(0);
});

test("WakeScheduler: cancelWake preserves tool-call/result pairing", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-cancel-tools");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "use tools then stop" }
  });
  let resolveTool!: () => void;
  let toolStarted!: () => void;
  const toolStartedPromise = new Promise<void>((resolve) => {
    toolStarted = resolve;
  });
  const releaseToolPromise = new Promise<void>((resolve) => {
    resolveTool = resolve;
  });
  const llm = createMockLLM([
    {
      toolCalls: [
        { toolCallId: "c1", toolName: "fakeOk", args: {} },
        { toolCallId: "c2", toolName: "fakeOk", args: {} }
      ],
      finishReason: "tool-calls"
    },
    { text: "should not continue", finishReason: "stop" }
  ]);
  const dispatcher: ToolDispatcher = {
    registry: STUB_TOOL_DISPATCHER.registry,
    async dispatch(call) {
      if (call.toolCallId === "c1") {
        toolStarted();
        await releaseToolPromise;
      }
      return { result: { ok: true, call: call.toolCallId } };
    }
  };
  let finishedResolve!: () => void;
  const finished = new Promise<void>((resolve) => { finishedResolve = resolve; });
  const scheduler = new WakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => dispatcher,
    llmModel: llm,
    sse: {
      emit: (name, data: any) => {
        if (name === "agentWakeFinished" && data.status === "canceled") finishedResolve();
      }
    },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  const wakeId = scheduler.wake(thread.id, "user", trigger.id)!;
  await toolStartedPromise;
  expect(scheduler.cancelWake(wakeId).ok).toBe(true);
  resolveTool();
  await finished;

  expect(agentStore.getWakeById(wakeId)?.status).toBe("canceled");
  expect(llm.callsMade).toBe(1);
  const msgs = agentStore.getActiveMessages(thread.id);
  const toolResults = msgs.filter((m) => m.role === "tool");
  expect(toolResults.map((m) => contentOf(m, "tool_result").toolCallId)).toEqual(["c1", "c2"]);
  expect(contentOf(toolResults[0]!, "tool_result").result).toEqual({ ok: true, call: "c1" });
  expect(contentOf(toolResults[1]!, "tool_result").isError).toBe(true);
});

// A stop reaches the tool that is running (bash kills its command on it):
// the wake ends without waiting for the call to finish on its own.
test("WakeScheduler: cancelWake reaches the running tool, which stops; the wake ends without waiting for it", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-cancel-running-tool");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "run something long" }
  });
  let toolStarted!: () => void;
  const toolStartedPromise = new Promise<void>((resolve) => { toolStarted = resolve; });
  const llm = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
    { text: "should not continue", finishReason: "stop" }
  ]);
  const dispatcher: ToolDispatcher = {
    registry: STUB_TOOL_DISPATCHER.registry,
    async dispatch(_call, ctx) {
      toolStarted();
      // Runs until the turn's stop reaches it, and no longer.
      await new Promise<void>((resolve) => {
        if (ctx.signal?.aborted) resolve();
        ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { isError: true, error: "Stopped by user." };
    }
  };
  let finishedResolve!: () => void;
  const finished = new Promise<void>((resolve) => { finishedResolve = resolve; });
  const scheduler = new WakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => dispatcher,
    llmModel: llm,
    sse: {
      emit: (name, data: any) => {
        if (name === "agentWakeFinished" && data.status === "canceled") finishedResolve();
      }
    },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  const wakeId = scheduler.wake(thread.id, "user", trigger.id)!;
  await toolStartedPromise;
  expect(scheduler.cancelWake(wakeId).ok).toBe(true);
  await finished;

  expect([agentStore.getWakeById(wakeId)?.status, llm.callsMade]).toEqual(["canceled", 1]);
  const results = agentStore.getActiveMessages(thread.id).filter((m) => m.role === "tool").map((m) => contentOf(m, "tool_result"));
  expect(results.map((r) => [r.toolCallId, r.isError, r.error])).toEqual([["c1", true, "Stopped by user."]]);
});

test("WakeScheduler: wake started/finished SSE payloads carry thread scope + scopeId", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-A");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "hello" }
  });
  const events: Array<{ name: string; data: any }> = [];
  const llm = createMockLLM([
    { text: "hi back", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } }
  ]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE_BUILDER
  });
  await wakeAndWait(thread.id, "user", trigger.id);

  const started = events.find((e) => e.name === "agentWakeStarted")!.data;
  expect(started.scope).toBe("worker");
  expect(started.scopeId).toBe("feat-A");
  const finished = events.find((e) => e.name === "agentWakeFinished")!.data;
  expect(finished.status).toBe("finished");
  expect(finished.scope).toBe("worker");
  expect(finished.scopeId).toBe("feat-A");
  // Each ending's event carries exactly these fields (see the other endings).
  expect(Object.keys(finished).sort()).toEqual(["contextUsage", "scope", "scopeId", "status", "stepCount", "threadId", "wakeId"]);
});

test("WakeScheduler: wake metadata persists, streams, and decorates assistant messages", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("manager", null);
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "Pick up where the restart left off." }
  });
  // What a recovered wake carries: the wakes it stands in for.
  const metadata = {
    recovery: { wakeIds: ["wake_before"], originalReason: "user" as const, originalTriggerMessageId: trigger.id }
  };
  const events: Array<{ name: string; data: any }> = [];
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: createMockLLM([
      { text: "noted", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } }
    ]),
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  const wakeId = await wakeAndWait(thread.id, "user", trigger.id, metadata);

  expect(agentStore.getWakeById(wakeId)?.metadata).toEqual(metadata);
  const started = events.find((e) => e.name === "agentWakeStarted")!.data;
  expect(started.metadata).toEqual(metadata);
  const assistant = agentStore.getActiveMessages(thread.id).find((m) => m.role === "assistant")!;
  expect(assistant.wakeId).toBe(wakeId);
  expect(assistant.wakeMetadata).toEqual(metadata);
});


test("WakeScheduler: error-path agentWakeFinished carries scope for overview threads too", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("manager", null);
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "hello" }
  });
  const events: Array<{ name: string; data: any }> = [];
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: createFailingStreamLLM("provider down"),
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE_BUILDER
  });
  await wakeAndWait(thread.id, "user", trigger.id);

  const started = events.find((e) => e.name === "agentWakeStarted")!.data;
  expect(started.scope).toBe("manager");
  expect(started.scopeId).toBe(null);
  const finished = events.find((e) => e.name === "agentWakeFinished")!.data;
  expect(finished.status).toBe("error");
  expect(finished.scope).toBe("manager");
  expect(finished.scopeId).toBe(null);
  expect(Object.keys(finished).sort()).toEqual(["contextUsage", "error", "errorMessage", "scope", "scopeId", "status", "threadId", "wakeId"]);
});

test("WakeScheduler: cancelWake without an in-memory entry emits scoped agentWakeFinished", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-A");
  // Wake row exists (status running) but the scheduler has no in-memory
  // entry — the post-restart cancellation path.
  const wake = agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  const events: Array<{ name: string; data: any }> = [];
  const scheduler = new WakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: createMockLLM([]),
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE_BUILDER
  });
  expect(scheduler.cancelWake(wake.id).ok).toBe(true);
  const finished = events.find((e) => e.name === "agentWakeFinished")!.data;
  expect(finished.status).toBe("canceled");
  expect(finished.scope).toBe("worker");
  expect(finished.scopeId).toBe("feat-A");
  expect(finished).toMatchObject({ errorMessage: "Stopped by user.", contextUsage: null });
  expect(Object.keys(finished).sort()).toEqual(["contextUsage", "errorMessage", "scope", "scopeId", "status", "threadId", "wakeId"]);
});

test("WakeScheduler: a wake's start time goes out with its start event and on every message it writes", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("manager", null);
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" }
  });
  const events: Array<{ name: string; data: any }> = [];
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: createMockLLM([
      { text: "hello", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } }
    ]),
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE_BUILDER
  });

  const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
  const startedAt = agentStore.getWakeById(wakeId)!.startedAt;
  expect(typeof startedAt).toBe("string");
  expect(events.find((e) => e.name === "agentWakeStarted")!.data.startedAt).toBe(startedAt);
  // The reply as it streamed out, and as each read path returns it.
  const appended = events.find((e) => e.name === "agentMessageAppended" && e.data.message.role === "assistant")!;
  expect(appended.data.message.wakeStartedAt).toBe(startedAt);
  const reads = {
    page: agentStore.getMessagesPage(thread.id),
    pageBefore: agentStore.getMessagesPage(thread.id, { beforeSeq: 1_000 }),
    since: agentStore.getMessagesSince(thread.id, 0)
  };
  for (const [name, messages] of Object.entries(reads)) {
    const reply = messages.find((m) => m.role === "assistant");
    expect([name, reply?.wakeStartedAt]).toEqual([name, startedAt]);
    // A message outside any wake has none.
    expect([name, messages.find((m) => m.id === trigger.id)?.wakeStartedAt ?? null]).toEqual([name, null]);
  }
});

// A compaction started by hand runs with no turn. The thread must be busy
// all the same, or a message sent meanwhile is answered against the window
// the summary is about to replace, and then hidden by that summary.
test("WakeScheduler.holdThread: holds a thread as a wake does, and its release starts what queued behind", () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-hold");
  const released: string[] = [];
  const { scheduler } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: createMockLLM([]),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER,
    afterWakeReleasedHook: (threadId) => { released.push(threadId); }
  });

  const release = scheduler.holdThread(thread.id);
  expect(typeof release).toBe("function");
  expect(scheduler.isThreadBusy(thread.id)).toBe(true);
  // A second hold and a wake both find it busy; nothing has been released.
  expect(scheduler.holdThread(thread.id)).toBe(null);
  expect(scheduler.wake(thread.id, "user", null)).toBe(null);
  expect(released).toStrictEqual([]);

  release!();
  expect(scheduler.isThreadBusy(thread.id)).toBe(false);
  expect(released).toStrictEqual([thread.id]);
  // Releasing twice neither frees a later holder's lock nor runs the hook again.
  const again = scheduler.holdThread(thread.id);
  release!();
  expect(scheduler.isThreadBusy(thread.id)).toBe(true);
  expect(released).toStrictEqual([thread.id]);
  again!();
});

// A turn that measured a step, compacted at a later gate, and then failed
// before any call measured the compacted window ends with no figure: the one
// its own steps recorded is from before the compaction, and the page would
// show it as the conversation's size while it sits idle.
test("WakeScheduler: a wake that ends after compacting, with nothing measured since, reports no context figure", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-context-after-compaction");
  const trigger = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "hello" }
  });
  // One step that calls a tool, measured at 140; the next call has no answer and fails.
  const llm = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }], finishReason: "tool-calls", usage: { promptTokens: 140, completionTokens: 3 } }
  ]);
  const events: Array<{ name: string; data: any }> = [];
  let calls = 0;
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    contextBudgetTokens: 170,
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE_BUILDER,
    // The gate before the second call compacts, as the compression controller would.
    beforeModelCallHook: async (threadId) => {
      calls += 1;
      if (calls !== 2) return { historyChanged: false };
      await new Promise((resolve) => setTimeout(resolve, 2));
      agentStore.appendMessage({
        threadId, role: "user", source: "compression",
        content: { type: "summary", summary: "compressed", replacedRange: [1, 1], replacedCount: 1, retained: [] }
      });
      return { historyChanged: true };
    }
  });

  const wakeId = await wakeAndWait(thread.id, "user", trigger.id);

  expect(agentStore.getWakeById(wakeId)!.status).toBe("error");
  // The step was measured while it ran.
  expect(events.find((event) => event.name === "agentContextUsageUpdated")!.data.contextUsage.inputTokens).toBe(140);
  const finished = events.find((event) => event.name === "agentWakeFinished")!;
  expect(finished.data.contextUsage).toMatchObject({ inputTokens: null, budgetTokens: 170 });
  expect(agentStore.getContextUsage(thread.id, 170).inputTokens).toBe(null);
});

// After a compaction the conversation is told, once, what still runs in the
// background; a later wake's update does not repeat it.
test("WakeScheduler: the first context names the background tasks still running; a later update does not", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-tasks-context");
  const tasksPart = "Background tasks running when this conversation was compacted (list_tasks shows them as they are now):\n- task_1 · Command · e2e · `make e2e` · running 1m 00s";
  let contextVersion = "context-v1";
  let tasksBuilt = 0;
  const llm = createMockLLM([{ text: "one", finishReason: "stop" }, { text: "two", finishReason: "stop" }]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT_BUILDER,
    buildInitialContext: () => "baseline",
    buildRuntimeContext: () => contextVersion,
    buildTasksContext: () => { tasksBuilt++; return tasksPart; },
    toolDispatcherForThread: () => STUB_TOOL_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE_BUILDER
  });
  const first = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hello" } });
  await wakeAndWait(thread.id, "user", first.id);
  contextVersion = "context-v2";
  const second = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "again" } });
  await wakeAndWait(thread.id, "user", second.id);
  const contexts = agentStore.getActiveMessages(thread.id).filter((m) => m.source === "runtime-context").map((m) => (m.content.type === "text" ? m.content.text : ""));
  expect(contexts).toHaveLength(2);
  expect(contexts[0]).toContain("[initial_context]");
  expect(contexts[0]).toContain(tasksPart);
  expect(contexts[0]!.indexOf("baseline")).toBeLessThan(contexts[0]!.indexOf(tasksPart));
  expect(contexts[0]!.indexOf(tasksPart)).toBeLessThan(contexts[0]!.indexOf("context-v1"));
  expect(contexts[1]).toContain("context-v2");
  expect(contexts[1]).not.toContain("Background tasks running");
  expect(tasksBuilt).toBe(1);
});
