import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { createAgentRuntimeLlmRecorders } from "../src/server/runtime/agent-llm-recorders.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { sanitizeForLlmLog } from "../src/server/modules/activity/llm-call-logging.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM, createScriptedStreamLLM } from "./helpers/mock-llm.js";

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-llmrec-"));
  const store = new MandateStore(dir);
  return {
    store, agentStore: new AgentStore(store.db),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const STUB_PROMPT = () => "system";
const STUB_SCOPE = (): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });
const STUB_DISPATCHER = { registry: { tools: {} as any }, async dispatch() { return { result: {} }; } };

test("sanitizeForLlmLog: redacts view_image payload bytes", () => {
  const imageBase64 = Buffer.from("png-bytes").toString("base64");
  const sanitized = sanitizeForLlmLog({
    output: {
      type: "view_image_result",
      message: "Viewed image: screenshot.png",
      image: {
        type: "image",
        id: "img-1",
        name: "screenshot.png",
        displayPath: "screenshot.png",
        mediaType: "image/png",
        data: imageBase64,
        sizeBytes: 9
      }
    },
    toolResult: {
      type: "content",
      value: [{
        type: "file",
        data: { type: "data", data: imageBase64 },
        mediaType: "image/png",
        filename: "screenshot.png"
      }]
    }
  });

  const text = JSON.stringify(sanitized);
  expect(text).not.toContain(imageBase64);
  expect(text).toContain("[omitted 9 byte image]");
});

test("sanitizeForLlmLog: redacts encrypted reasoning content fields", () => {
  const sanitized = sanitizeForLlmLog({
    messages: [{
      role: "assistant",
      content: [{
        type: "reasoning",
        providerOptions: {
          openai: {
            itemId: "rs_1",
            reasoningEncryptedContent: "encrypted-reasoning-payload"
          }
        }
      }]
    }],
    sdkAssistantMessages: [{
      role: "assistant",
      content: [{
        type: "reasoning",
        providerOptions: {
          openai: {
            encryptedContent: "stored-encrypted-reasoning"
          }
        }
      }]
    }]
  });

  const text = JSON.stringify(sanitized);
  expect(text).not.toContain("encrypted-reasoning-payload");
  expect(text).not.toContain("stored-encrypted-reasoning");
  expect(text).toContain("[omitted encrypted reasoning content");
});

test("wake step defaults OpenAI-compatible Responses calls to store=false", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([{ text: "ok", finishReason: "stop" }], {
      provider: "openai.responses",
      modelId: "gpt-5.5"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      llmForThread: () => ({
        model: llm,
        candidates: [{
          model: llm,
          meta: {
            provider: "openai-compatible",
            providerName: "proxy",
            model: "gpt-5.5",
            baseURL: "https://proxy.example/v1"
          }
        }]
      }),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE
    });

    await wakeAndWait(thread.id, "user", trigger.id);

    expect((llm.streamCalls[0]!.providerOptions as any)?.openai?.store).toBe(false);
    expect((llm.streamCalls[0]!.providerOptions as any)?.openai?.promptCacheKey).toBe(thread.id);
  } finally { cleanup(); }
});

test("wake step passes candidate reasoning effort to streamText", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([{ text: "ok", finishReason: "stop" }], {
      provider: "openai.responses",
      modelId: "gpt-5.5"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      llmForThread: () => ({
        model: llm,
        candidates: [{
          model: llm,
          meta: {
            provider: "openai",
            providerName: "openai",
            model: "gpt-5.5",
            baseURL: "",
            reasoningEffort: "high",
            supportsReasoning: true
          }
        }]
      }),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE
    });

    await wakeAndWait(thread.id, "user", trigger.id);

    expect((llm.streamCalls[0] as any).reasoning).toBe("high");
    expect((llm.streamCalls[0] as any).providerOptions?.openai?.forceReasoning).toBe(true);
  } finally { cleanup(); }
});

test("wake step omits reasoning when candidate disables reasoning support", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([{ text: "ok", finishReason: "stop" }], {
      provider: "openai.responses",
      modelId: "gpt-5.5"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      llmForThread: () => ({
        model: llm,
        candidates: [{
          model: llm,
          meta: {
            provider: "openai",
            providerName: "openai",
            model: "gpt-5.5",
            baseURL: "",
            reasoningEffort: "high",
            supportsReasoning: false
          }
        }]
      }),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE
    });

    await wakeAndWait(thread.id, "user", trigger.id);

    expect((llm.streamCalls[0] as any).reasoning).toBeUndefined();
    expect((llm.streamCalls[0] as any).providerOptions?.openai?.forceReasoning).toBeUndefined();
  } finally { cleanup(); }
});

test("wake step persists SDK assistant messages on assistant turns", async () => {
  const { agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createScriptedStreamLLM([
      [
        { type: "stream-start", warnings: [] },
        {
          type: "reasoning-start",
          id: "rs_1:0",
          providerMetadata: {
            openai: {
              itemId: "rs_1",
              reasoningEncryptedContent: "encrypted-reasoning"
            }
          }
        } as any,
        {
          type: "reasoning-end",
          id: "rs_1:0",
          providerMetadata: {
            openai: {
              itemId: "rs_1",
              reasoningEncryptedContent: "encrypted-reasoning"
            }
          }
        } as any,
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", delta: "ok" },
        { type: "text-end", id: "text-0" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined }
          }
        }
      ]
    ], { provider: "openai.responses", modelId: "gpt-5.5" });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE
    });

    await wakeAndWait(thread.id, "user", trigger.id);

    const assistant = agentStore.getActiveMessages(thread.id)
      .find((message) => message.role === "assistant");
    const assistantContent = assistant?.content as any;
    expect(assistant?.content).toEqual({
      type: "assistant",
      sdkAssistantMessages: expect.any(Array),
      text: "ok"
    });
    expect(assistantContent.reasoning).toBeUndefined();
    expect(assistantContent.sdkAssistantMessages[0]?.role).toBe("assistant");
    expect(JSON.stringify(assistantContent)).toContain("encrypted-reasoning");
  } finally { cleanup(); }
});

test("recorder: wake step records one llm_calls row with purpose=agent_wake_step", async () => {
  const { store, agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([
      { text: "hello back", finishReason: "stop", usage: { promptTokens: 7, completionTokens: 3 } }
    ]);
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      providerName: "nova", provider: "openai-compatible", model: "test-model", baseURL: "http://x", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder
    });
    await wakeAndWait(thread.id, "user", trigger.id);

    const calls = store.listLlmCalls(50);
    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.purpose).toBe("agent_wake_step");
    expect(c.scopeType).toBe("agent_thread");
    expect(c.scopeId).toBe(thread.id);
    expect(c.status).toBe("succeeded");
    expect(c.model).toBe("test-model");
    expect(c.provider).toBe("openai-compatible");
    expect((c.metadata as any)?.providerName).toBe("nova");
    expect(c.apiMode).toBe("streamText");
    // metadata mode → request_json must NOT be persisted; usage/tokens still are
    expect(c.request).toBe(null);
    expect(c.inputTokens).toBe(7);
    expect(c.outputTokens).toBe(3);
    expect((c.metadata as any)?.wakeId).toBeTruthy();
  } finally { cleanup(); }
});

test("recorder: feature-event wake metadata is redacted in llm_calls", async () => {
  const { store, agentStore, cleanup } = fresh();
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
        summary: "Sensitive task summary that belongs in thread state, not metadata logs."
      }
    });
    const wakeMetadata = {
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
        summary: "Sensitive task summary that belongs in thread state, not metadata logs.",
        artifacts: [{
          type: "canvas" as const,
          canvasId: "cnv-1",
          title: "Private report",
          path: "/canvas/cnv-1"
        }]
      }]
    };
    const llm = createMockLLM([
      { text: "noted", finishReason: "stop", usage: { promptTokens: 7, completionTokens: 3 } }
    ]);
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      provider: "openai-compatible", model: "test-model", baseURL: "http://x", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder
    });
    await wakeAndWait(thread.id, "feature-event", trigger.id, wakeMetadata);

    const metadata = store.listLlmCalls(50)[0]!.metadata as any;
    expect(metadata.wakeMetadata).toBeUndefined();
    expect(metadata.featureEvents).toHaveLength(1);
    expect(metadata.featureEvents[0]).toMatchObject({
      type: "feature_event",
      kind: "completion",
      taskId: "task-1",
      featureId: "feat-1",
      workItemId: "wi-1",
      label: "Implement source labels",
      source: {
        project: { name: "Mandate" },
        feature: { name: "Event source display" },
        workItem: { id: "wi-1", title: "Implement source labels" }
      }
    });
    expect(metadata.featureEvents[0].summary).toBeUndefined();
    expect(metadata.featureEvents[0].artifacts).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain("Sensitive task summary");
    expect(JSON.stringify(metadata)).not.toContain("Private report");
  } finally { cleanup(); }
});

test("recorder: limit-reached feature-event metadata omits task-only fields", async () => {
  const { store, agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "feature-event",
      content: {
        type: "feature_event",
        kind: "limit_reached",
        featureId: "feat-1",
        workItemId: "wi-1",
        label: "Implement source labels",
        summary: "Sensitive limit summary that belongs in thread state, not metadata logs.",
        stepCount: 200
      }
    });
    const wakeMetadata = {
      featureEvents: [{
        type: "feature_event" as const,
        kind: "limit_reached" as const,
        featureId: "feat-1",
        workItemId: "wi-1",
        label: "Implement source labels",
        summary: "Sensitive limit summary that belongs in thread state, not metadata logs.",
        stepCount: 200
      }]
    };
    const llm = createMockLLM([
      { text: "noted", finishReason: "stop", usage: { promptTokens: 7, completionTokens: 3 } }
    ]);
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      provider: "openai-compatible", model: "test-model", baseURL: "http://x", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder
    });
    await wakeAndWait(thread.id, "feature-event", trigger.id, wakeMetadata);

    const metadata = store.listLlmCalls(50)[0]!.metadata as any;
    expect(metadata.featureEvents).toHaveLength(1);
    expect(metadata.featureEvents[0]).toMatchObject({
      type: "feature_event",
      kind: "limit_reached",
      featureId: "feat-1",
      workItemId: "wi-1",
      label: "Implement source labels",
      stepCount: 200
    });
    expect(metadata.featureEvents[0].taskId).toBeUndefined();
    expect(metadata.featureEvents[0].signal).toBeUndefined();
    expect(metadata.featureEvents[0].summary).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain("Sensitive limit summary");
  } finally { cleanup(); }
});

test("recorder: logRequests=off writes nothing", async () => {
  const { store, agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([{ text: "ok", finishReason: "stop" }]);
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "off",
      provider: "openai", model: "m", baseURL: "", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3, buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder
    });
    await wakeAndWait(thread.id, "user", trigger.id);
    expect(store.listLlmCalls(50).length).toBe(0);
  } finally { cleanup(); }
});

test("recorder: logRequests=full persists request_json", async () => {
  const { store, agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([{ text: "ok", finishReason: "stop" }]);
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "full",
      provider: "openai", model: "m", baseURL: "", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3, buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder
    });
    await wakeAndWait(thread.id, "user", trigger.id);
    const calls = store.listLlmCalls(50);
    expect(calls.length).toBe(1);
    expect(calls[0]!.request).not.toBe(null);
    expect((calls[0]!.request as any)?.system).toBeTruthy();
    expect((calls[0]!.output as any)?.text).toBe("ok");
  } finally { cleanup(); }
});

test("recorder: LLM error path records status=failed with error_json", async () => {
  const originalError = console.error;
  const lines: string[] = [];
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  const oldDebug = process.env.MANDATE_DEBUG;
  process.env.MANDATE_LOG_LEVEL = "error";
  delete process.env.MANDATE_DEBUG;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  const { store, agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    // Empty scripted array → first call throws "mock LLM exhausted after 0 calls".
    const llm = createMockLLM([]);
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      provider: "openai", model: "m", baseURL: "", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3, buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder
    });
    await wakeAndWait(thread.id, "user", trigger.id);
    const calls = store.listLlmCalls(50);
    expect(calls.length).toBe(1);
    expect(calls[0]!.status).toBe("failed");
    expect((calls[0]!.error as any)?.message).toContain("exhausted");
    expect((calls[0]!.error as any)?.stack).toBeUndefined();
    expect(lines.some((line) => line.includes("[mandate] agent wake"))).toBe(true);
    expect(lines.join("\n")).not.toContain("at runLlmCandidates");
  } finally {
    console.error = originalError;
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
    if (oldDebug === undefined) delete process.env.MANDATE_DEBUG;
    else process.env.MANDATE_DEBUG = oldDebug;
    cleanup();
  }
});

test("recorder: wake fallback switches provider after one retryable failure", async () => {
  const originalError = console.error;
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  console.error = () => {};
  const { store, agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const primary = createMockLLM([
      { error: "The operation timed out." },
      { error: "should not retry primary when fallback exists" }
    ], { provider: "codex", modelId: "gpt-5.5" });
    const fallback = createMockLLM([
      { text: "fallback ok", finishReason: "stop" }
    ], { provider: "openai-compatible", modelId: "gpt-5.5" });
    const primaryRecorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      providerName: "primary", provider: "codex", model: "gpt-5.5", baseURL: "", apiMode: "streamText"
    });
    const fallbackRecorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      providerName: "backup", provider: "openai-compatible", model: "gpt-5.5", baseURL: "http://proxy", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: primary,
      llmForThread: () => ({
        model: primary,
        llmCallRecorder: primaryRecorder,
        candidates: [
          {
            model: primary,
            llmCallRecorder: primaryRecorder,
            meta: { provider: "codex", model: "gpt-5.5" }
          },
          {
            model: fallback,
            llmCallRecorder: fallbackRecorder,
            meta: { provider: "openai-compatible", model: "gpt-5.5", baseURL: "http://proxy" }
          }
        ]
      }),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      llmCallRecorder: primaryRecorder
    });
    await wakeAndWait(thread.id, "user", trigger.id);

    expect(primary.callsMade).toBe(1);
    expect(fallback.callsMade).toBe(1);
    // Attempts can share a timestamp; identify them by provider, not random IDs.
    const calls = store.listLlmCalls(50);
    expect(calls).toHaveLength(2);
    const primaryCall = calls.find((call) => call.provider === "codex")!;
    const fallbackCall = calls.find((call) => call.provider === "openai-compatible")!;
    expect(primaryCall.status).toBe("failed");
    expect(fallbackCall.status).toBe("succeeded");
    expect((primaryCall.metadata as any)?.providerName).toBe("primary");
    expect((fallbackCall.metadata as any)?.providerName).toBe("backup");
    expect((fallbackCall.metadata as any)?.candidateIndex).toBe(1);
    expect((fallbackCall.metadata as any)?.attempt).toBe(1);
  } finally {
    console.error = originalError;
    cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("recorder: wake retries a single provider once for retryable errors", async () => {
  const originalError = console.error;
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  console.error = () => {};
  const { store, agentStore, cleanup } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([
      { error: "service unavailable" },
      { text: "retry ok", finishReason: "stop" }
    ]);
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      provider: "codex", model: "gpt-5.5", baseURL: "", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      maxStepsPerWake: 3,
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder
    });
    await wakeAndWait(thread.id, "user", trigger.id);

    expect(llm.callsMade).toBe(2);
    const calls = store.listLlmCalls(50).slice().reverse();
    expect(calls.map((call) => call.status)).toEqual(["failed", "succeeded"]);
    expect((calls[1]!.metadata as any)?.attempt).toBe(2);
  } finally {
    console.error = originalError;
    cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("recorder: provider error metadata is compact and structured", () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  const oldDebug = process.env.MANDATE_DEBUG;
  process.env.MANDATE_LOG_LEVEL = "info";
  delete process.env.MANDATE_DEBUG;

  const { store, cleanup } = fresh();
  try {
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      provider: "openai", model: "m", baseURL: "", apiMode: "streamText"
    });
    const callId = recorder.startCall({
      purpose: "agent_wake_step",
      scopeType: "agent_thread",
      scopeId: "thread_1"
    });
    const err = new Error("upstream failed") as Error & {
      statusCode: number;
      code: string;
      requestId: string;
    };
    err.statusCode = 503;
    err.code = "service_unavailable";
    err.requestId = "req_abc";
    recorder.finishCall(callId, {
      status: "failed",
      error: err,
      latencyMs: 12
    });

    const calls = store.listLlmCalls(50);
    expect(calls.length).toBe(1);
    expect(calls[0]!.error).toMatchObject({
      name: "Error",
      message: "upstream failed",
      status: 503,
      code: "service_unavailable",
      requestId: "req_abc"
    });
    expect((calls[0]!.error as any)?.stack).toBeUndefined();
  } finally {
    cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
    if (oldDebug === undefined) delete process.env.MANDATE_DEBUG;
    else process.env.MANDATE_DEBUG = oldDebug;
  }
});

test("recorder: DOMException cause metadata stays compact", () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  const oldDebug = process.env.MANDATE_DEBUG;
  process.env.MANDATE_LOG_LEVEL = "info";
  delete process.env.MANDATE_DEBUG;

  const { store, cleanup } = fresh();
  try {
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      provider: "codex", model: "gpt-5.5", baseURL: "", apiMode: "streamText"
    });
    const callId = recorder.startCall({
      purpose: "memory_dream",
      scopeType: "memory",
      scopeId: "global"
    });
    recorder.finishCall(callId, {
      status: "failed",
      error: new Error("The operation timed out.", {
        cause: new DOMException("The operation timed out.", "TimeoutError")
      }),
      latencyMs: 240876
    });

    const calls = store.listLlmCalls(50);
    expect(calls.length).toBe(1);
    expect(calls[0]!.error).toMatchObject({
      name: "TimeoutError",
      message: "The operation timed out. (TimeoutError code=23)",
      code: 23
    });
    expect((calls[0]!.error as any)?.TIMEOUT_ERR).toBeUndefined();
    expect((calls[0]!.error as any)?.stack).toBeUndefined();
  } finally {
    cleanup();
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
    if (oldDebug === undefined) delete process.env.MANDATE_DEBUG;
    else process.env.MANDATE_DEBUG = oldDebug;
  }
});


test("runtime recorders retain configured provider names through metadata updates", () => {
  const { store, cleanup } = fresh();
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agent.logRequests = "metadata";
    for (const role of ["manager", "worker"] as const) {
      config.agent[role].provider = "openai-compatible";
      config.agent[role].providerName = `${role}-gateway`;
      config.agent[role].model = "test-model";
    }
    const recorders = createAgentRuntimeLlmRecorders({ config, store });
    for (const [key, recorder] of Object.entries(recorders)) {
      const expectedName = key.toLowerCase().includes("manager") ? "manager-gateway" : "worker-gateway";
      const id = recorder.startCall({ purpose: "test", scopeType: "agent_thread", scopeId: "thread", metadata: { phase: "started" } })!;
      expect(store.getLlmCall(id)?.metadata).toMatchObject({ providerName: expectedName, phase: "started" });
      recorder.finishCall(id, { status: "succeeded", metadata: { phase: "finished", providerName: "wrong-provider" } });
      expect(store.getLlmCall(id)?.metadata).toMatchObject({ providerName: expectedName, phase: "finished" });
      expect(store.listLlmCallSummaries(50).find((call) => call.id === id)?.metadata)
        .toMatchObject({ providerName: expectedName });
    }
    const recorder = recorders.managerWakeRecorder;
    const id = recorder.startCall({ purpose: "test", scopeType: "agent_thread", scopeId: "thread", metadata: { phase: "retained" } })!;
    recorder.finishCall(id, { status: "succeeded" });
    expect(store.getLlmCall(id)?.metadata).toMatchObject({ providerName: "manager-gateway", phase: "retained" });
  } finally { cleanup(); }
});
