import { expect, test } from "bun:test";
import type { WakeScheduler } from "../../src/server/modules/agent/wake-loop.js";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import { AgentLlmCallRecorder } from "../../src/server/modules/activity/llm-call-recorder.js";
import { SSE_EVENTS } from "../../src/shared/api-contracts.js";
import { createTestWakeScheduler } from "../helpers/wake-scheduler.js";
import { freshAgentEnv } from "../helpers/fixtures.js";
import { createMockLLM, createScriptedStreamLLM } from "../helpers/mock-llm.js";

const STUB_PROMPT = () => "system";
const STUB_SCOPE = () => ({});
const STUB_DISPATCHER = { registry: { tools: {} as any }, async dispatch() { return { result: {} }; } };

function recorder(env: ReturnType<typeof freshAgentEnv>, provider: string, model: string, baseURL = "") {
  return new AgentLlmCallRecorder({
    store: env.store,
    logRequests: "metadata",
    provider,
    model,
    baseURL,
    apiMode: "streamText"
  });
}

function scheduler(env: ReturnType<typeof freshAgentEnv>, overrides: Partial<ConstructorParameters<typeof WakeScheduler>[0]>) {
  return createTestWakeScheduler({
    agentStore: env.agentStore,
    lock: new WakeLock(),
    maxStepsPerWake: 3,
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER as any,
    llmModel: overrides.llmModel!,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE,
    streamIdleTimeoutMs: 20,
    llmTimeout: { totalMs: 1_000, chunkMs: 1_000 },
    ...overrides
  });
}

function seedTrigger(env: ReturnType<typeof freshAgentEnv>) {
  const thread = env.agentStore.getOrCreateThread("worker", "feat-timeout");
  const trigger = env.agentStore.appendMessage({
    threadId: thread.id,
    role: "user",
    source: "user",
    content: { type: "text", text: "run" }
  });
  return { thread, trigger };
}

test("WakeScheduler: stream idle timeout fails empty streams and falls back", async () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  const env = freshAgentEnv("md-wake-timeout-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const primary = createScriptedStreamLLM([
      [
        { type: "hang" }
      ]
    ], { provider: "codex", modelId: "gpt-5.5" });
    const fallback = createMockLLM([
      { text: "fallback ok", finishReason: "stop", usage: { promptTokens: 9, completionTokens: 2 } }
    ], { provider: "openai-compatible", modelId: "gpt-5.5" });
    const primaryRecorder = recorder(env, "codex", "gpt-5.5");
    const fallbackRecorder = recorder(env, "openai-compatible", "gpt-5.5", "http://proxy");

    await scheduler(env, {
      llmModel: primary,
      llmCallRecorder: primaryRecorder,
      llmForThread: () => ({
        model: primary,
        llmCallRecorder: primaryRecorder,
        candidates: [
          { model: primary, llmCallRecorder: primaryRecorder, meta: { provider: "codex", model: "gpt-5.5" } },
          { model: fallback, llmCallRecorder: fallbackRecorder, meta: { provider: "openai-compatible", model: "gpt-5.5", baseURL: "http://proxy" } }
        ]
      })
    }).wakeAndWait(thread.id, "user", trigger.id);

    expect(primary.callsMade).toBe(1);
    expect(fallback.callsMade).toBe(1);
    const calls = env.store.listLlmCalls(50).slice().reverse();
    expect(calls.map((call) => [call.provider, call.status])).toEqual([
      ["codex", "failed"],
      ["openai-compatible", "succeeded"]
    ]);
    expect((calls[0]!.error as any)?.message).toMatch(/activity/);
    expect((calls[0]!.metadata as any)?.stream).toMatchObject({
      status: "failed",
      modelDataPartCount: 0,
      visibleOutputPartCount: 0,
      idleTimeoutMs: 20
    });
    expect((calls[0]!.metadata as any)?.stream?.partCount).toBeGreaterThan(0);
    const messages = env.agentStore.getActiveMessages(thread.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.content.type).toBe("assistant");
    if (messages[1]!.content.type === "assistant") {
      expect(messages[1]!.content.text).toBe("fallback ok");
    }
  } finally {
    env.cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("WakeScheduler: non-output stream parts refresh stream idle timeout", async () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  const env = freshAgentEnv("md-wake-timeout-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const primary = createScriptedStreamLLM([
      [
        { type: "stream-start", warnings: [] },
        { delayMs: 5, type: "reasoning-start", id: "r1" } as any,
        { delayMs: 5, type: "reasoning-delta", id: "r1", delta: "still thinking" } as any,
        { delayMs: 5, type: "reasoning-end", id: "r1" } as any,
        { type: "hang" }
      ]
    ], { provider: "codex", modelId: "gpt-5.5" });
    const fallback = createMockLLM([
      { text: "fallback after reasoning", finishReason: "stop" }
    ], { provider: "openai-compatible", modelId: "gpt-5.5" });
    const primaryRecorder = recorder(env, "codex", "gpt-5.5");
    const fallbackRecorder = recorder(env, "openai-compatible", "gpt-5.5", "http://proxy");

    await scheduler(env, {
      llmModel: primary,
      llmCallRecorder: primaryRecorder,
      llmForThread: () => ({
        model: primary,
        llmCallRecorder: primaryRecorder,
        candidates: [
          { model: primary, llmCallRecorder: primaryRecorder, meta: { provider: "codex", model: "gpt-5.5" } },
          { model: fallback, llmCallRecorder: fallbackRecorder, meta: { provider: "openai-compatible", model: "gpt-5.5", baseURL: "http://proxy" } }
        ]
      })
    }).wakeAndWait(thread.id, "user", trigger.id);

    expect(primary.callsMade).toBe(1);
    expect(fallback.callsMade).toBe(1);
    const calls = env.store.listLlmCalls(50).slice().reverse();
    expect(calls.map((call) => [call.provider, call.status])).toEqual([
      ["codex", "failed"],
      ["openai-compatible", "succeeded"]
    ]);
    expect((calls[0]!.metadata as any)?.stream?.partCount).toBeGreaterThan(1);
    expect((calls[0]!.metadata as any)?.stream?.modelDataPartCount).toBeGreaterThan(0);
    expect((calls[0]!.metadata as any)?.stream?.timeoutActivityPartCount).toBeGreaterThan(1);
    expect((calls[0]!.metadata as any)?.stream?.visibleOutputPartCount).toBe(0);
  } finally {
    env.cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("WakeScheduler: tool input deltas refresh stream idle timeout until tool-call arrives", async () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  const env = freshAgentEnv("md-wake-timeout-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const primary = createScriptedStreamLLM([
      [
        { type: "stream-start", warnings: [] },
        { delayMs: 10, type: "tool-input-start", id: "call-1", toolName: "do_work" } as any,
        { delayMs: 10, type: "tool-input-delta", id: "call-1", delta: "{\"value\":" } as any,
        { delayMs: 10, type: "tool-input-delta", id: "call-1", delta: "\"ok\"" } as any,
        { delayMs: 10, type: "tool-input-delta", id: "call-1", delta: ",\"step\":" } as any,
        { delayMs: 10, type: "tool-input-delta", id: "call-1", delta: "1}" } as any,
        { delayMs: 10, type: "tool-input-end", id: "call-1" } as any,
        { type: "tool-call", toolCallId: "call-1", toolName: "do_work", input: "{\"value\":\"ok\",\"step\":1}" } as any,
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }
        } as any
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "done" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 1 } }
        } as any
      ]
    ], { provider: "codex", modelId: "gpt-5.5" });
    const primaryRecorder = recorder(env, "codex", "gpt-5.5");

    await scheduler(env, {
      llmModel: primary,
      llmCallRecorder: primaryRecorder,
      streamIdleTimeoutMs: 50,
      llmForThread: () => ({
        model: primary,
        llmCallRecorder: primaryRecorder,
        candidates: [
          { model: primary, llmCallRecorder: primaryRecorder, meta: { provider: "codex", model: "gpt-5.5" } }
        ]
      })
    }).wakeAndWait(thread.id, "user", trigger.id);

    expect(primary.callsMade).toBe(2);
    const calls = env.store.listLlmCalls(50);
    expect(calls.map((call) => call.status)).toEqual(["succeeded", "succeeded"]);
    const toolCallLlmCall = calls.find((call) => (call.metadata as any)?.stream?.toolCallCount === 1)!;
    expect((toolCallLlmCall.metadata as any)?.stream).toMatchObject({
      status: "succeeded",
      visibleOutputPartCount: 1,
      toolCallCount: 1
    });
    expect((toolCallLlmCall.metadata as any)?.stream?.timeoutActivityPartCount).toBeGreaterThan(4);
    const messages = env.agentStore.getActiveMessages(thread.id);
    const assistant = messages[messages.length - 1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content.type).toBe("assistant");
    if (assistant.content.type === "assistant") {
      expect(assistant.content.text).toBe("done");
    }
  } finally {
    env.cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("WakeScheduler: clears partial visible text before falling back", async () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  const env = freshAgentEnv("md-wake-timeout-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const sseEvents: Array<{ name: string; data: any }> = [];
    const primary = createScriptedStreamLLM([
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "partial" },
        { type: "text-end", id: "t1" },
        { type: "tool-input-start", id: "call-1", toolName: "feature_task_send" } as any,
        { type: "tool-input-delta", id: "call-1", delta: "{\"featureId\":\"" } as any,
        { type: "tool-input-delta", id: "call-1", delta: "research-issue-5391-release-blocker" } as any,
        { type: "hang" }
      ]
    ], { provider: "codex", modelId: "gpt-5.5" });
    const fallback = createMockLLM([
      { text: "fallback ok", finishReason: "stop" }
    ], { provider: "openai-compatible", modelId: "gpt-5.5" });
    const primaryRecorder = recorder(env, "codex", "gpt-5.5");
    const fallbackRecorder = recorder(env, "openai-compatible", "gpt-5.5", "http://proxy");

    const wakeId = await scheduler(env, {
      llmModel: primary,
      llmCallRecorder: primaryRecorder,
      sse: { emit: (name, data) => sseEvents.push({ name, data }) },
      llmForThread: () => ({
        model: primary,
        llmCallRecorder: primaryRecorder,
        candidates: [
          { model: primary, llmCallRecorder: primaryRecorder, meta: { provider: "codex", model: "gpt-5.5" } },
          { model: fallback, llmCallRecorder: fallbackRecorder, meta: { provider: "openai-compatible", model: "gpt-5.5", baseURL: "http://proxy" } }
        ]
      })
    }).wakeAndWait(thread.id, "user", trigger.id);

    expect(primary.callsMade).toBe(1);
    expect(fallback.callsMade).toBe(1);
    expect(env.agentStore.getWakeById(wakeId)?.status).toBe("finished");
    const calls = env.store.listLlmCalls(50).slice().reverse();
    expect(calls.map((call) => [call.provider, call.status])).toEqual([
      ["codex", "failed"],
      ["openai-compatible", "succeeded"]
    ]);
    expect((calls[0]!.metadata as any)?.stream).toMatchObject({
      status: "failed",
      visibleOutputPartCount: 1,
      textDeltaCount: 1
    });
    expect((calls[0]!.metadata as any)?.stream?.modelDataPartCount).toBeGreaterThan(0);
    expect((calls[0]!.metadata as any)?.stream?.timeoutActivityPartCount).toBeGreaterThan(4);
    const reset = sseEvents.find((event) =>
      event.name === SSE_EVENTS.agentMessageDelta
      && event.data.wakeId === wakeId
      && event.data.totalText === ""
    );
    expect(reset?.data.deltaText).toBe("");
    const messages = env.agentStore.getActiveMessages(thread.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]!.content.type).toBe("assistant");
    if (messages[1]!.content.type === "assistant") {
      expect(messages[1]!.content.text).toBe("fallback ok");
    }
  } finally {
    env.cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("WakeScheduler: does not retry one candidate after partial visible text", async () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  const env = freshAgentEnv("md-wake-timeout-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const primary = createScriptedStreamLLM([
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "partial" },
        { type: "hang" }
      ]
    ], { provider: "codex", modelId: "gpt-5.5" });
    const primaryRecorder = recorder(env, "codex", "gpt-5.5");

    const wakeId = await scheduler(env, {
      llmModel: primary,
      llmCallRecorder: primaryRecorder,
      llmForThread: () => ({
        model: primary,
        llmCallRecorder: primaryRecorder,
        candidates: [
          { model: primary, llmCallRecorder: primaryRecorder, meta: { provider: "codex", model: "gpt-5.5" } }
        ]
      })
    }).wakeAndWait(thread.id, "user", trigger.id);

    expect(primary.callsMade).toBe(1);
    expect(env.agentStore.getWakeById(wakeId)?.status).toBe("error");
    expect(env.store.listLlmCalls(50).map((call) => call.status)).toEqual(["failed"]);
    expect(env.agentStore.getActiveMessages(thread.id).map((message) => message.role)).toEqual(["user"]);
  } finally {
    env.cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});
