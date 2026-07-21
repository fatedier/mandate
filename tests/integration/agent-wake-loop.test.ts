import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MandateStore } from "../../src/server/app/store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { AgentUserMessageQueue } from "../../src/server/modules/agent/user-message-queue.js";
import { buildFeatureTaskSendTool } from "../../src/server/modules/agent/tools/feature-task-tools.js";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import { WakeScheduler } from "../../src/server/modules/agent/wake-loop.js";
import { createTestWakeScheduler } from "../helpers/wake-scheduler.js";
import { createMockLLM } from "../helpers/mock-llm.js";
import { freshStoresEnv, seedFeature, seedProject } from "../helpers/fixtures.js";

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-wl-"));
  const store = new MandateStore(dir);
  return { store, agentStore: new AgentStore(store.db),
           cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const STUB_PROMPT_BUILDER = (_threadId: string) => "stub system prompt";
const STUB_SCOPE_BUILDER = (_threadId: string) => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const STUB_TOOL_DISPATCHER = {
  registry: { tools: {} as any },
  async dispatch(call: any) {
    if (call.toolName === "fakeOk") return { result: { ok: true } };
    if (call.toolName === "fakeErr") return { result: null, isError: true, error: "boom" };
    return { result: null, isError: true, error: `unknown tool ${call.toolName}` };
  }
};

function createFailingStreamLLM(message: string) {
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
  } as any;
}

function enqueueFeatureEvent(agentStore: AgentStore, threadId: string) {
  agentStore.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: "feature-thread",
    content: {
      type: "feature_event",
      kind: "completion",
      taskId: "task-1",
      featureId: "feat-1",
      workItemId: null,
      label: "Feature task",
      summary: "done"
    }
  });
  return agentStore.listPendingFeatureEvents(threadId, 50)[0]!.id;
}

test("WakeScheduler: simple wake — assistant returns text, no tool calls, finishes", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hello" }
    });
    const llm = createMockLLM([
      { text: "hi back", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } }
    ]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER
    });
    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
    const wake = agentStore.getWakeById(wakeId)!;
    expect(wake.status).toBe("finished");
    expect(wake.stepCount).toBe(1);
    const msgs = agentStore.getActiveMessages(thread.id);
    expect(msgs.length).toBe(2);
    expect(msgs[1]!.role).toBe("assistant");
    expect(llm.callsMade).toBe(1);
  } finally { cleanup(); }
});

test("WakeScheduler: falls back to the next model when primary fails before output", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
    expect((msgs.at(-1)!.content as any).text).toBe("fallback response");
    expect(fallback.callsMade).toBe(1);
  } finally { cleanup(); }
});

test("WakeScheduler: keeps accepted image attachments when only primary supports images", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      llmForThread: () => ({
        model: llm,
        candidates: [
          { model: llm, meta: { provider: "openai", model: "primary-vision", baseURL: "" } },
          { model: llm, meta: { provider: "openai-compatible", model: "fallback-text", baseURL: "https://backup.example/v1" } }
        ]
      }),
      supportsInputForThread: (_threadId, input) => input === "image" ? true : true,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER
    });

    await wakeAndWait(thread.id, "user", trigger.id);
    const messages = llm.streamCalls[0]!.prompt as any[];
    const userMessage = messages.find((message) => message.role === "user")!;
    expect(JSON.stringify(userMessage.content)).toContain(imageBase64);
    expect(JSON.stringify(userMessage.content)).toContain("image/png");
    expect(JSON.stringify(userMessage.content)).not.toContain("omitted because the current model does not support image input");
  } finally { cleanup(); }
});

test("WakeScheduler: skips text-only fallback when view_image result is in prompt", async () => {
  const { agentStore, cleanup } = fresh();
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
    cleanup();
  }
});

test("WakeScheduler: omits view_image bytes for chat-backed image-capable paths", async () => {
  const { agentStore, cleanup } = fresh();
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
    const llm = createMockLLM([
      { text: "cannot view that on this model path", finishReason: "stop" }
    ]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore,
      lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
  } finally {
    cleanup();
  }
});

test("WakeScheduler: tool call → result → agent final, two steps, finishes", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER
    });
    await wakeAndWait(thread.id, "user", trigger.id);
    const msgs = agentStore.getActiveMessages(thread.id);
    // user(trigger) + assistant(tool_calls) + tool(result) + assistant(text)
    expect(msgs.length).toBe(4);
    expect(msgs[1]!.role).toBe("assistant");
    expect((msgs[1]!.content as any).toolCalls?.length).toBe(1);
    expect(msgs[2]!.role).toBe("tool");
    expect((msgs[2]!.content as any).toolCallId).toBe("c1");
    expect(msgs[3]!.role).toBe("assistant");
  } finally { cleanup(); }
});

test("WakeScheduler: preStepHook drains mailbox before the next model step", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
    const dispatcher = {
      registry: STUB_TOOL_DISPATCHER.registry,
      async dispatch(call: any) {
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
        return STUB_TOOL_DISPATCHER.dispatch(call);
      }
    };
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => dispatcher as any,
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
  } finally { cleanup(); }
});

test("WakeScheduler: preStepHook can flush queued user messages before the next model step", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "do it" }
    });
    const queue = new AgentUserMessageQueue({
      agentStore,
      wakeScheduler: {
        wake: () => "unused-wake",
        isThreadBusy: () => true
      }
    });
    const llm = createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }],
        finishReason: "tool-calls" },
      { text: "I saw the new user message.", finishReason: "stop" }
    ]);
    const dispatcher = {
      registry: STUB_TOOL_DISPATCHER.registry,
      async dispatch(call: any) {
        const result = queue.submitUserMessage({
          scope: "worker",
          scopeId: "feat-A",
          content: "also consider this",
          clientRequestId: "local-during-tool"
        });
        expect(result.queued).toBe(true);
        return STUB_TOOL_DISPATCHER.dispatch(call);
      }
    };
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => dispatcher as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER,
      preStepHook: (threadId) => {
        queue.flushQueuedIntoThread(threadId);
      }
    });

    await wakeAndWait(thread.id, "user", trigger.id);
    const msgs = agentStore.getActiveMessages(thread.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(msgs[3]!.content.type).toBe("text");
    expect((msgs[3]!.content as any).text).toBe("also consider this");
    expect(queue.pendingCount(thread.id)).toBe(0);
  } finally { cleanup(); }
});

test("WakeScheduler: hits maxStepsPerWake → runs final reply-only step + status=limit_reached", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "loop" }
    });
    // Two tool-call rounds consume the budget (maxSteps=2), then the final
    // reply-only step takes the third scripted response — even though the
    // mock returns tool calls there, the wake-loop drops them in reply-only
    // mode and persists only the text.
    const llm = createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
      { toolCalls: [{ toolCallId: "c2", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
      { text: "Hit the budget — c1 and c2 ran; nothing else done.", finishReason: "stop" }
    ]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 2,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER
    });
    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
    const wake = agentStore.getWakeById(wakeId)!;
    expect(wake.status).toBe("limit_reached");
    // 2 normal steps + 1 reply-only step = 3
    expect(wake.stepCount).toBe(3);
    expect(llm.callsMade).toBe(3);
    // Last message is the agent's wrap-up assistant message — no more system
    // "send another message to continue" placeholder.
    const msgs = agentStore.getActiveMessages(thread.id);
    const last = msgs.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content.type).toBe("assistant");
    if (last.content.type === "assistant") {
      expect(last.content.text).toMatch(/Hit the budget/);
      expect(last.content.toolCalls).toBeUndefined();
    }
  } finally { cleanup(); }
});

test("WakeScheduler: queued feature task flushed before final reply still schedules a follow-up wake", async () => {
  const env = freshStoresEnv("md-wl-limit-task-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const thread = env.agentStore.getOrCreateThread("worker", featureId);
    const trigger = env.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "loop" }
    });
    const queuedTaskWakeThreads = new Set<string>();
    const followUpWakeRequests: string[] = [];
    let scheduler!: WakeScheduler;
    const queue = new AgentUserMessageQueue({
      agentStore: env.agentStore,
      wakeScheduler: {
        wake: (threadId) => {
          followUpWakeRequests.push(threadId);
          return "follow-up-wake";
        },
        isThreadBusy: (threadId) => scheduler.isThreadBusy(threadId),
        getRunningWakeForThread: (threadId) => scheduler.getRunningWakeForThread(threadId)
      },
      onPendingTaskMessageFlushed: (threadId) => queuedTaskWakeThreads.add(threadId)
    });
    const sendTask = buildFeatureTaskSendTool({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: { emit: () => {} } as any,
      wakeScheduler: {
        wake: (threadId, reason, triggerMessageId) => scheduler.wake(threadId, reason, triggerMessageId),
        getRunningWakeForThread: (threadId) => scheduler.getRunningWakeForThread(threadId)
      },
      userMessageQueue: queue,
      markPendingTaskWake: (threadId) => queuedTaskWakeThreads.add(threadId)
    });
    const dispatcher = {
      registry: STUB_TOOL_DISPATCHER.registry,
      async dispatch(call: any, ctx: any) {
        const result = await sendTask.handler({
          feature: featureId,
          title: "Queued follow-up",
          message: "Follow-up after this wake."
        }, ctx);
        expect(result).toMatchObject({ status: "queued", featureThreadId: thread.id });
        return STUB_TOOL_DISPATCHER.dispatch(call);
      }
    };
    const llm = createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
      { text: "Hit the budget; queued follow-up should run next.", finishReason: "stop" }
    ]);
    const { scheduler: testScheduler, wakeAndWait } = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(),
      maxStepsPerWake: 1,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => dispatcher as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER,
      preStepHook: (threadId, info) => {
        queue.flushQueuedIntoThread(threadId);
        const drained = env.agentStore.drainMailboxToMessages(threadId, info.wakeId);
        if (drained.some((message) =>
          message.content.type === "text" && message.content.metadata?.featureTaskDispatch
        )) {
          queuedTaskWakeThreads.add(threadId);
        }
      },
      afterWakeReleasedHook: (threadId) => {
        if (env.agentStore.hasQueuedFeatureTaskDispatchMailboxMessages(threadId)) {
          followUpWakeRequests.push(threadId);
          return;
        }
        if (!queuedTaskWakeThreads.has(threadId)) return;
        if (queue.isFlushBlocked(threadId) || queue.pendingCount(threadId) > 0) return;
        queuedTaskWakeThreads.delete(threadId);
        if (!env.agentStore.hasOpenTasksForThread(threadId)) return;
        followUpWakeRequests.push(threadId);
      }
    });

    scheduler = testScheduler;
    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
    const wake = env.agentStore.getWakeById(wakeId)!;
    expect(wake.status).toBe("limit_reached");
    expect(queue.pendingCount(thread.id)).toBe(0);
    expect(followUpWakeRequests).toEqual([thread.id]);

    const messages = env.agentStore.getActiveMessages(thread.id);
    expect(messages.some((message) =>
      message.content.type === "text" && message.content.text.includes("Follow-up after this wake.")
    )).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("WakeScheduler: reply-only final step drops tool calls if model still emits them", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "loop" }
    });
    const llm = createMockLLM([
      { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
      // Reply-only step: model ignores the "no tools" instruction and emits a
      // tool call anyway. Wake-loop must drop it and not dispatch.
      { text: "wrap-up", toolCalls: [{ toolCallId: "rogue", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" }
    ]);
    const dispatchedCalls: string[] = [];
    const dispatcher = {
      registry: { tools: { fakeOk: { description: "x", parameters: { safeParse: () => ({ success: true, data: {} }) }, approval: "always", handler: async () => ({ ok: true }) } } },
      dispatch: async (call: any) => { dispatchedCalls.push(call.toolCallId); return { result: { ok: true } }; }
    };
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 1,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => dispatcher as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER
    });
    await wakeAndWait(thread.id, "user", trigger.id);
    // Only c1 was dispatched (from step 1). The "rogue" call from the
    // reply-only step must NOT have been dispatched.
    expect(dispatchedCalls).toEqual(["c1"]);
    const msgs = agentStore.getActiveMessages(thread.id);
    const last = msgs.at(-1)!;
    expect(last.role).toBe("assistant");
    if (last.content.type === "assistant") {
      expect(last.content.text).toBe("wrap-up");
      expect(last.content.toolCalls).toBeUndefined();
    }
  } finally { cleanup(); }
});

test("WakeScheduler: tool error message recorded, wake continues", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER
    });
    await wakeAndWait(thread.id, "user", trigger.id);
    const msgs = agentStore.getActiveMessages(thread.id);
    const toolMsg = msgs.find((m) => m.role === "tool")!;
    expect((toolMsg.content as any).isError).toBe(true);
    expect(msgs.at(-1)!.role).toBe("assistant");
  } finally { cleanup(); }
});

test("WakeScheduler: tolerates persisted tool results that were separated by voice messages", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER
    });

    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
    expect(agentStore.getWakeById(wakeId)?.status).toBe("finished");
    expect(llm.callsMade).toBe(1);
  } finally { cleanup(); }
});

test("WakeScheduler: wakeFinishedHook fires with correct event payload", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-hook");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([
      { text: "hello back", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 3 } }
    ]);

    const events: Array<{
      threadId: string; wakeId: string; reason: string;
      status: string; triggerMessageId: string | null;
    }> = [];

    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER,
      wakeFinishedHook: (e) => { events.push(e); }
    });

    await wakeAndWait(thread.id, "user", trigger.id);

    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.threadId).toBe(thread.id);
    expect(ev.wakeId).toBeTruthy();
    expect(ev.reason).toBe("user");
    expect(ev.status).toBe("finished");
    expect(ev.triggerMessageId).toBe(trigger.id);
  } finally { cleanup(); }
});

test("WakeScheduler: postWakeHook receives latest and max input-token usage", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER,
      postWakeHook: (threadId, info) => { postWakeEvents.push({ threadId, info }); }
    });

    await wakeAndWait(thread.id, "user", trigger.id);

    expect(postWakeEvents.length).toBe(1);
    expect(postWakeEvents[0].threadId).toBe(thread.id);
    expect(postWakeEvents[0].info.lastInputTokens).toBe(120);
    expect(postWakeEvents[0].info.lastPromptMaxSeq).toBe(3);
    expect(postWakeEvents[0].info.maxInputTokens).toBe(140);
    expect(postWakeEvents[0].info.stepCount).toBe(2);
  } finally { cleanup(); }
});

test("WakeScheduler: consumed feature_event is marked before release-time mailbox flush", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const eventId = enqueueFeatureEvent(agentStore, thread.id);
    const llm = createMockLLM([
      { text: "Feature event handled.", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 3 } }
    ]);
    const extraWakeIds: string[] = [];
    const { scheduler, wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      buildRuntimeContext: () => "event context",
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER,
      postWakeHook: () => {
        agentStore.markFeatureEventsProcessed([eventId]);
      },
      afterWakeReleasedHook: (threadId) => {
        if (!agentStore.hasQueuedMailboxMessages(threadId) && !agentStore.hasQueuedFeatureEvents(threadId)) return;
        const wakeId = scheduler.wake(threadId, "feature-event", null);
        if (wakeId) extraWakeIds.push(wakeId);
      }
    });

    await wakeAndWait(thread.id, "feature-event", null);

    expect(extraWakeIds).toHaveLength(0);
    expect(agentStore.hasQueuedFeatureEvents(thread.id)).toBe(false);
    expect(agentStore.listPendingFeatureEvents(thread.id, 50)).toHaveLength(0);
  } finally { cleanup(); }
});

test("WakeScheduler: queued feature_event still wakes overview after busy release", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const eventId = enqueueFeatureEvent(agentStore, thread.id);
    const llm = createMockLLM([
      { text: "Current wake finished.", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 3 } },
      { text: "Queued event handled.", finishReason: "stop", usage: { promptTokens: 11, completionTokens: 3 } }
    ]);
    const extraWakeIds: string[] = [];
    const { scheduler, wakeAndWait, waitForWake } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      buildRuntimeContext: () => "event context",
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER,
      postWakeHook: (_threadId, info) => {
        if (info.reason === "feature-event" && info.status === "finished") {
          agentStore.markFeatureEventsProcessed([eventId]);
        }
      },
      afterWakeReleasedHook: (threadId) => {
        if (!agentStore.hasQueuedMailboxMessages(threadId) && !agentStore.hasQueuedFeatureEvents(threadId)) return;
        const wakeId = scheduler.wake(threadId, "feature-event", null);
        if (wakeId) extraWakeIds.push(wakeId);
      }
    });

    await wakeAndWait(thread.id, "user", null);

    expect(extraWakeIds).toHaveLength(1);
    await waitForWake(extraWakeIds[0]!);
    expect(agentStore.getWakeById(extraWakeIds[0]!)?.reason).toBe("feature-event");
    expect(agentStore.hasQueuedFeatureEvents(thread.id)).toBe(false);
  } finally { cleanup(); }
});

test("WakeScheduler: wake finished SSE includes context budget usage", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
  } finally { cleanup(); }
});

test("WakeScheduler: preWakeHook completes before the first LLM step", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: () => {
        events.push("prompt");
        return "stub system prompt";
      },
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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

    expect(events).toEqual(["pre-start", "pre-end", "prompt"]);
  } finally { cleanup(); }
});

test("WakeScheduler: beforeModelCallHook can compress and rebuild runtime context before prompt", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      buildInitialContext: () => `baseline-v${++initialBuilds}`,
      buildRuntimeContext: () => `context-v${++runtimeBuilds}`,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE_BUILDER,
      beforeModelCallHook: (threadId, info) => {
        expect(threadId).toBe(thread.id);
        expect(info.wakeId).toBeTruthy();
        expect(info.triggerMessageId).toBe(trigger.id);
        expect(info.allowTools).toBe(true);
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
            replacedCount: active.length
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
  } finally { cleanup(); }
});

test("WakeScheduler: system prompt is immutable and runtime context is append-only", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: () => {
        systemBuilds++;
        return systemVersion;
      },
      buildInitialContext: () => initialVersion,
      buildRuntimeContext: () => contextVersion,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
    expect((contexts[0]!.content as any).metadata?.runtimeContextMode).toBe("compact");
    expect((contexts[1]!.content as any).metadata?.runtimeContextMode).toBe("compact");

    agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "compression",
      content: {
        type: "summary",
        summary: "compressed context",
        replacedRange: [contexts[0]!.seq, contexts.at(-1)!.seq],
        replacedCount: contexts.length
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
  } finally { cleanup(); }
});

test("WakeScheduler: does not append runtime context for formatting-only state changes", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context-normalized");
    let runtimeContext = "## State\n- pane working";
    const llm = createMockLLM([
      { text: "first", finishReason: "stop" },
      { text: "second", finishReason: "stop" }
    ]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      buildInitialContext: () => "baseline",
      buildRuntimeContext: () => runtimeContext,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
    expect((contexts[0]!.content as any).text).toContain("[initial_context]");
  } finally { cleanup(); }
});

test("WakeScheduler: appends at most one runtime context update during one tool wake", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      buildInitialContext: () => "baseline",
      buildRuntimeContext: () => `context-v${++runtimeContextSeq}`,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
    expect((contexts[0]!.content as any).metadata?.runtimeContextMode).toBe("compact");
    expect((contexts[1]!.content as any).metadata?.runtimeContextMode).toBe("compact");
  } finally { cleanup(); }
});

test("WakeScheduler: still appends final step-budget runtime context after one wake update", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context-budget");
    let runtimeContextSeq = 0;
    const llm = createMockLLM([
      { text: "ready", finishReason: "stop" },
      { toolCalls: [{ toolCallId: "c1", toolName: "fakeOk", args: {} }], finishReason: "tool-calls" },
      { text: "budget summary", finishReason: "stop" }
    ]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 1,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      buildInitialContext: () => "baseline",
      buildRuntimeContext: () => `context-v${++runtimeContextSeq}`,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
      content: { type: "text", text: "run one tool then summarize" }
    });
    await wakeAndWait(thread.id, "user", second.id);

    const contexts = agentStore.getActiveMessages(thread.id).filter((message) =>
      message.source === "runtime-context"
    );
    expect(contexts.length).toBe(3);
    const finalText = contexts[2]!.content.type === "text" ? contexts[2]!.content.text : "";
    expect(finalText).toContain("Step budget exhausted");
    expect(finalText).toContain("No more tool calls will be honored");
  } finally { cleanup(); }
});

test("WakeScheduler: cancelWake stops a wake before the first model step", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
    const finished = new Promise<void>((resolve) => {
      scheduler = new WakeScheduler({
        agentStore, lock: new WakeLock(),
        maxStepsPerWake: 5,
        buildSystemPrompt: STUB_PROMPT_BUILDER,
        toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
        llmModel: llm,
        sse: {
          emit: (name, data: any) => {
            if (name === "agentWakeFinished" && data.status === "canceled") resolve();
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
    const wake = agentStore.getRunningWakeForThread(thread.id);
    expect(wake).toBe(null);
    expect(agentStore.getActiveMessages(thread.id).length).toBe(1);
    expect(llm.callsMade).toBe(0);
  } finally { cleanup(); }
});

test("WakeScheduler: cancelWake preserves tool-call/result pairing", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
    const dispatcher = {
      registry: STUB_TOOL_DISPATCHER.registry,
      async dispatch(call: any) {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => dispatcher as any,
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
    expect(toolResults.map((m) => (m.content as any).toolCallId)).toEqual(["c1", "c2"]);
    expect((toolResults[0]!.content as any).result).toEqual({ ok: true, call: "c1" });
    expect((toolResults[1]!.content as any).isError).toBe(true);
  } finally { cleanup(); }
});

test("WakeScheduler: wake started/finished SSE payloads carry thread scope + scopeId", async () => {
  const { agentStore, cleanup } = fresh();
  try {
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
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
  } finally { cleanup(); }
});

test("WakeScheduler: wake metadata persists, streams, and decorates assistant messages", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "feature-event",
      content: {
        type: "feature_event",
        kind: "completion",
        taskId: "task-1",
        featureId: "feat-1",
        workItemId: "wi-1",
        label: "Implement source labels",
        summary: "Done."
      }
    });
    const metadata = {
      featureEvents: [{
        type: "feature_event" as const,
        kind: "completion" as const,
        taskId: "task-1",
        featureId: "feat-1",
        workItemId: "wi-1",
        source: {
          project: { id: "proj-1", name: "Mandate" },
          feature: { id: "feat-1", name: "Event source display" },
          workItem: { id: "wi-1", title: "Implement source labels" },
          capturedAt: "2026-05-28T00:00:00Z"
        },
        label: "Implement source labels",
        summary: "Done."
      }]
    };
    const events: Array<{ name: string; data: any }> = [];
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: createMockLLM([
        { text: "noted", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } }
      ]),
      sse: { emit: (name, data) => events.push({ name, data }) },
      buildToolScope: STUB_SCOPE_BUILDER
    });

    const wakeId = await wakeAndWait(thread.id, "feature-event", trigger.id, metadata);

    expect(agentStore.getWakeById(wakeId)?.metadata).toEqual(metadata);
    const started = events.find((e) => e.name === "agentWakeStarted")!.data;
    expect(started.metadata).toEqual(metadata);
    const assistant = agentStore.getActiveMessages(thread.id).find((m) => m.role === "assistant")!;
    expect(assistant.wakeId).toBe(wakeId);
    expect(assistant.wakeMetadata).toEqual(metadata);
  } finally { cleanup(); }
});


test("WakeScheduler: error-path agentWakeFinished carries scope for overview threads too", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hello" }
    });
    const events: Array<{ name: string; data: any }> = [];
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
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
  } finally { cleanup(); }
});

test("WakeScheduler: cancelWake without an in-memory entry emits scoped agentWakeFinished", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    // Wake row exists (status running) but the scheduler has no in-memory
    // entry — the post-restart cancellation path.
    const wake = agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    const events: Array<{ name: string; data: any }> = [];
    const scheduler = new WakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 5,
      buildSystemPrompt: STUB_PROMPT_BUILDER,
      toolDispatcherForThread: () => STUB_TOOL_DISPATCHER as any,
      llmModel: createMockLLM([]),
      sse: { emit: (name, data) => events.push({ name, data }) },
      buildToolScope: STUB_SCOPE_BUILDER
    });
    expect(scheduler.cancelWake(wake.id).ok).toBe(true);
    const finished = events.find((e) => e.name === "agentWakeFinished")!.data;
    expect(finished.status).toBe("canceled");
    expect(finished.scope).toBe("worker");
    expect(finished.scopeId).toBe("feat-A");
  } finally { cleanup(); }
});
