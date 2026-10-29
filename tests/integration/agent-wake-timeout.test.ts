import { expect, test } from "bun:test";
import type { ToolDispatcher, WakeScheduler } from "../../src/server/modules/agent/wake-loop.js";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import type { AgentScope } from "../../src/server/modules/agent/tool-scope.js";
import { AgentLlmCallRecorder } from "../../src/server/modules/activity/llm-call-recorder.js";
import { SSE_EVENTS } from "../../src/shared/api-contracts.js";
import { createTestWakeScheduler } from "../helpers/wake-scheduler.js";
import { freshAgentEnv } from "../helpers/fixtures.js";
import { createMockLLM, createScriptedStreamLLM } from "../helpers/mock-llm.js";

const STUB_PROMPT = () => "system";
const STUB_SCOPE = (): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const STUB_DISPATCHER: ToolDispatcher = { registry: { tools: {} }, async dispatch() { return { result: {} }; } };

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
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER,
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
    expect(calls[0]!.metadata?.stream).toMatchObject({
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
    // Each part comes well inside the idle timeout, so a busy machine's stall
    // does not reach it; a timer the parts did not refresh would fire after the
    // first and before the second, so the reasoning's end is reached only if
    // they refresh it.
    const IDLE_MS = 300;
    const GAP_MS = 200;
    const primary = createScriptedStreamLLM([
      [
        { type: "stream-start", warnings: [] },
        { delayMs: GAP_MS, type: "reasoning-start", id: "r1" },
        { delayMs: GAP_MS, type: "reasoning-delta", id: "r1", delta: "still thinking" },
        { delayMs: GAP_MS, type: "reasoning-end", id: "r1" },
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
      streamIdleTimeoutMs: IDLE_MS,
      llmTimeout: { totalMs: 10_000, chunkMs: 10_000 },
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
    expect((calls[0]!.metadata as any)?.stream?.partTypes?.["reasoning-end"]).toBe(1);
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
        { delayMs: 10, type: "tool-input-start", id: "call-1", toolName: "do_work" },
        { delayMs: 10, type: "tool-input-delta", id: "call-1", delta: "{\"value\":" },
        { delayMs: 10, type: "tool-input-delta", id: "call-1", delta: "\"ok\"" },
        { delayMs: 10, type: "tool-input-delta", id: "call-1", delta: ",\"step\":" },
        { delayMs: 10, type: "tool-input-delta", id: "call-1", delta: "1}" },
        { delayMs: 10, type: "tool-input-end", id: "call-1" },
        { type: "tool-call", toolCallId: "call-1", toolName: "do_work", input: "{\"value\":\"ok\",\"step\":1}" },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: undefined, reasoning: undefined }
          }
        }
      ],
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "done" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: undefined, reasoning: undefined }
          }
        }
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
    expect(toolCallLlmCall.metadata?.stream).toMatchObject({
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
        { type: "tool-input-start", id: "call-1", toolName: "feature_task_send" },
        { type: "tool-input-delta", id: "call-1", delta: "{\"featureId\":\"" },
        { type: "tool-input-delta", id: "call-1", delta: "research-issue-14-release-blocker" },
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
    expect(calls[0]!.metadata?.stream).toMatchObject({
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

// The two tests above reach their failure through the idle timeout, which the
// shared policy never retries anyway. These use an overload — retryable, so
// only the wake loop's own "text already shown" rule keeps the same model from
// streaming the reply a second time.
function partialThenOverloaded() {
  return createScriptedStreamLLM([
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "partial" },
      { type: "controller-error", error: Object.assign(new Error("Overloaded"), { status: 529 }) }
    ],
    // Reached only if the same model were retried.
    [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t2" },
      { type: "text-delta", id: "t2", delta: "same model again" },
      { type: "text-end", id: "t2" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined }
        }
      }
    ]
  ], { provider: "codex", modelId: "gpt-5.5" });
}

test("WakeScheduler: a retryable error after partial text falls back instead of retrying the same model", async () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  const env = freshAgentEnv("md-wake-timeout-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const sseEvents: Array<{ name: string; data: any }> = [];
    const primary = partialThenOverloaded();
    const fallback = createMockLLM([{ text: "fallback ok", finishReason: "stop" }], { provider: "openai-compatible", modelId: "gpt-5.5" });
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

    expect([primary.callsMade, fallback.callsMade]).toEqual([1, 1]);
    expect(env.agentStore.getWakeById(wakeId)?.status).toBe("finished");
    const reset = sseEvents.find((event) =>
      event.name === SSE_EVENTS.agentMessageDelta
      && event.data.wakeId === wakeId
      && event.data.totalText === ""
    );
    expect(reset?.data.deltaText).toBe("");
    const reply = env.agentStore.getActiveMessages(thread.id).at(-1)!;
    expect(reply.content.type === "assistant" ? reply.content.text : "").toBe("fallback ok");
  } finally {
    env.cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("WakeScheduler: a retryable error after partial text with no fallback fails the wake without a retry", async () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  const env = freshAgentEnv("md-wake-timeout-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const primary = partialThenOverloaded();
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
    // The partial text is not kept as a reply.
    expect(env.agentStore.getActiveMessages(thread.id).map((message) => message.role)).toEqual(["user"]);
  } finally {
    env.cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

// A provider can spend a long time on one part the SDK holds back until it is
// whole (the Open Responses package buffers a tool call's arguments): its
// chunks still prove the stream is alive, so the idle guard counts them.
test("WakeScheduler: provider chunks that bring no visible part keep the stream alive", async () => {
  const env = freshAgentEnv("md-wake-raw-alive-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const model = {
      specificationVersion: "v4" as const, provider: "openResponses.responses", modelId: "vendor/model", supportedUrls: {},
      doGenerate: async () => { throw new Error("streams only"); },
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            // 120 ms of provider chunks, each well inside the 40 ms idle window, none of them a part.
            for (let i = 0; i < 8; i++) { await sleep(15); controller.enqueue({ type: "raw", rawValue: { type: "response.function_call_arguments.delta", delta: "x" } }); }
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "done" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
            controller.close();
          }
        })
      })
    };
    await scheduler(env, { llmModel: model as never, streamIdleTimeoutMs: 40, llmTimeout: { totalMs: 5_000, chunkMs: 5_000 } }).wakeAndWait(thread.id, "user", trigger.id);
    const last = env.agentStore.getMessages(thread.id).at(-1)!;
    expect(last.content).toMatchObject({ type: "assistant", text: "done" });
  } finally { env.cleanup(); }
});

// A heartbeat proves only that the connection is open, not that the model is
// working: a stream that sends nothing but pings still stalls.
test("WakeScheduler: heartbeat chunks alone do not keep a stalled stream alive", async () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  const env = freshAgentEnv("md-wake-ping-stall-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let calls = 0;
    const model = {
      specificationVersion: "v4" as const, provider: "anthropic.messages", modelId: "vendor/model", supportedUrls: {},
      doGenerate: async () => { throw new Error("streams only"); },
      doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        calls++;
        return {
          stream: new ReadableStream({
            async start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              for (let i = 0; i < 40 && !abortSignal?.aborted; i++) { await sleep(10); controller.enqueue({ type: "raw", rawValue: { type: "ping" } }); }
              controller.close();
            }
          })
        };
      }
    };
    const started = Date.now();
    await scheduler(env, { llmModel: model as never, streamIdleTimeoutMs: 60, llmTimeout: { totalMs: 5_000, chunkMs: 5_000 } }).wakeAndWait(thread.id, "user", trigger.id);
    // Stopped by the idle guard (60 ms), not by the 400 ms of pings running out.
    expect(Date.now() - started).toBeLessThan(380);
    expect(calls).toBeGreaterThan(0);
  } finally {
    env.cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL; else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

// The AI SDK's own chunk timer resets only on parts it emits; the Open
// Responses package emits none while a tool call's arguments stream. Its
// models leave the stall to Mandate's idle guard, which counts the deltas.
test("WakeScheduler: a long tool call on the Open Responses package outlives the SDK's chunk timer", async () => {
  const env = freshAgentEnv("md-wake-chunk-timer-");
  try {
    const { thread, trigger } = seedTrigger(env);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const model = {
      specificationVersion: "v4" as const, provider: "openResponses.responses", modelId: "deepseek/deepseek-flash", supportedUrls: {},
      doGenerate: async () => { throw new Error("streams only"); },
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "reasoning-start", id: "r" });
            controller.enqueue({ type: "reasoning-delta", id: "r", delta: "thinking" });
            controller.enqueue({ type: "reasoning-end", id: "r" });
            // 150 ms of argument deltas the package holds back: past a 50 ms chunk timer, inside a 200 ms idle guard.
            for (let i = 0; i < 10; i++) { await sleep(15); controller.enqueue({ type: "raw", rawValue: { type: "response.function_call_arguments.delta", delta: "x" } }); }
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "done" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
            controller.close();
          }
        })
      })
    };
    await scheduler(env, { llmModel: model as never, streamIdleTimeoutMs: 200, llmTimeout: { totalMs: 5_000, chunkMs: 50 } }).wakeAndWait(thread.id, "user", trigger.id);
    expect(env.agentStore.getMessages(thread.id).at(-1)!.content).toMatchObject({ type: "assistant", text: "done" });
  } finally { env.cleanup(); }
});
