import { expect, spyOn, test } from "bun:test";
import * as os from "node:os";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { DEFAULT_CONFIG } from "../src/server/config/defaults.js";
import { createAgentRuntimeLlmRecorders } from "../src/server/runtime/agent-llm-recorders.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { sanitizeForLlmLog } from "../src/server/modules/activity/llm-call-logging.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM, createScriptedStreamLLM } from "./helpers/mock-llm.js";
import { tempDir } from "./helpers/temp.js";
import { onCleanup } from "./helpers/cleanup.js";
import { contentOf } from "./helpers/typed.js";

function fresh() {
  const store = new MandateStore(tempDir("md-llmrec-"));
  return { store, agentStore: new AgentStore(store.db) };
}

const STUB_PROMPT = () => "system";
const STUB_SCOPE = (): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });
const STUB_DISPATCHER: ToolDispatcher = { registry: { tools: {} }, async dispatch() { return { result: {} }; } };

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
  const { agentStore } = fresh();
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
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER,
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

  expect(llm.streamCalls[0]!.providerOptions?.openai?.store).toBe(false);
  expect(llm.streamCalls[0]!.providerOptions?.openai?.promptCacheKey).toBe(thread.id);
});

test("wake step omits reasoning when candidate disables reasoning support", async () => {
  const { agentStore } = fresh();
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
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER,
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

  expect(llm.streamCalls[0]!.reasoning).toBeUndefined();
  expect(llm.streamCalls[0]!.providerOptions?.openai?.forceReasoning).toBeUndefined();
});

test("wake step persists SDK assistant messages on assistant turns", async () => {
  const { agentStore } = fresh();
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
      },
      {
        type: "reasoning-end",
        id: "rs_1:0",
        providerMetadata: {
          openai: {
            itemId: "rs_1",
            reasoningEncryptedContent: "encrypted-reasoning"
          }
        }
      },
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
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE
  });

  await wakeAndWait(thread.id, "user", trigger.id);

  const assistant = agentStore.getActiveMessages(thread.id)
    .find((message) => message.role === "assistant");
  expect(assistant?.content).toEqual({
    type: "assistant",
    sdkAssistantMessages: expect.any(Array),
    text: "ok"
  });
  const assistantContent = contentOf(assistant!, "assistant");
  expect(assistantContent.reasoning).toBeUndefined();
  expect(assistantContent.sdkAssistantMessages?.[0]?.role).toBe("assistant");
  expect(JSON.stringify(assistantContent)).toContain("encrypted-reasoning");
});

test("recorder: wake step records one llm_calls row with purpose=agent_wake_step", async () => {
  const { store, agentStore } = fresh();
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
    providerName: "provider-1", provider: "openai-compatible", api: "chat", model: "test-model", baseURL: "http://x", apiMode: "streamText"
  });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER,
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
  expect(c.metadata?.providerName).toBe("provider-1");
  // The API the call spoke, for Activity's "API" field.
  expect(c.metadata?.api).toBe("chat");
  expect(c.apiMode).toBe("streamText");
  // metadata mode → request_json must NOT be persisted; usage/tokens still are
  expect(c.request).toBe(null);
  expect(c.inputTokens).toBe(7);
  expect(c.outputTokens).toBe(3);
  expect(c.metadata?.wakeId).toBeTruthy();
  // What Activity reads once the thread or its wake rows are gone.
  expect(c.metadata?.threadScope).toBe("worker");
  expect(c.metadata?.wakeReason).toBe("user");
});

// A Kilo model on Messages runs as the anthropic family; its cost is still
// read as Kilo's (the upstream's, not Kilo's fee), whatever address the
// connection uses.
test("recorder: a Kilo call's cost is read as Kilo's whatever family and address it runs under", () => {
  const { store } = fresh();
  const recorder = new AgentLlmCallRecorder({
    store, logRequests: "metadata", providerName: "kilo", provider: "anthropic", providerType: "kilo", api: "messages",
    model: "vendor/claude-x", baseURL: "https://kilo-proxy.example/api/gateway", apiMode: "streamText"
  });
  const id = recorder.startCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "thr_x" });
  recorder.finishCall(id, { status: "succeeded", result: { text: "ok", facts: { usageCost: 0.0032, upstreamCost: 0.0642 } } });
  expect(store.db.prepare("select reported_cost_micros m, reported_cost_field f from llm_calls where id = ?").get(id))
    .toEqual({ m: 64_200, f: "upstream_inference_cost" });
});

test("recorder: each call keeps why its reply ended, beside the metadata it started with", async () => {
  const { store, agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-finish");
  const trigger = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  const recorder = new AgentLlmCallRecorder({
    store, logRequests: "metadata",
    providerName: "provider-1", provider: "openai-compatible", model: "test-model", baseURL: "http://x", apiMode: "streamText"
  });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER,
    llmModel: createMockLLM([{ text: "par", finishReason: "length" }, { text: "part", finishReason: "stop" }]),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE,
    llmCallRecorder: recorder
  });
  await wakeAndWait(thread.id, "user", trigger.id);
  // In step order: two calls can start in the same millisecond.
  const calls = store.listLlmCalls(50).slice().sort((a, b) => Number(a.metadata?.promptMaxSeq) - Number(b.metadata?.promptMaxSeq));
  expect(calls.map((c) => c.metadata?.finishReason)).toStrictEqual(["length", "stop"]);
  expect(calls.every((c) => typeof c.metadata?.wakeId === "string")).toBe(true);

  // A finish that brings no metadata of its own keeps the start's.
  const id = recorder.startCall({ purpose: "memory_extraction", scopeType: "thread", scopeId: thread.id, metadata: { extractionId: "x1" } });
  recorder.finishCall(id, { status: "succeeded", result: { text: "", finishReason: "length" } });
  expect(store.getLlmCall(id!)?.metadata).toEqual({ extractionId: "x1", providerName: "provider-1", finishReason: "length" });
});

// The record of a call is for reading later. When the database refused it
// (an outside writer holding it), the call itself failed: a reply that had
// come back was thrown away and tried again as if the model had failed.
for (const refused of ["startLlmCall", "finishLlmCall"] as const) {
  test(`recorder: a call whose record the database refuses (${refused}) still delivers its reply`, async () => {
    const { store, agentStore } = fresh();
    const thread = agentStore.getOrCreateThread("worker", `feat-${refused}`);
    const trigger = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
    const refuse = spyOn(store, refused).mockImplementation(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    onCleanup(() => refuse.mockRestore());
    const logged = spyOn(console, "error").mockImplementation(() => {});
    onCleanup(() => logged.mockRestore());
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      providerName: "provider-1", provider: "openai-compatible", model: "test-model", baseURL: "http://x", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER,
      llmModel: createMockLLM([{ text: "hello back", finishReason: "stop" }]),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder
    });
    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
    expect(agentStore.getWakeById(wakeId)?.status).toBe("finished");
    const replies = agentStore.getMessages(thread.id).filter((m) => m.role === "assistant").map((m) => contentOf(m, "assistant").text);
    expect(replies).toStrictEqual(["hello back"]);
    expect(logged.mock.calls.some((call) => String(call[0]).includes("could not be recorded"))).toBe(true);
  });
}

test("recorder: logRequests=off writes nothing", async () => {
  const { store, agentStore } = fresh();
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
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER,
    llmModel: llm,
    sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
    llmCallRecorder: recorder
  });
  await wakeAndWait(thread.id, "user", trigger.id);
  expect(store.listLlmCalls(50).length).toBe(0);
});

test("recorder: logRequests=full persists request_json", async () => {
  const { store, agentStore } = fresh();
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
    buildSystemPrompt: STUB_PROMPT,
    toolDispatcherForThread: () => STUB_DISPATCHER,
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
  const { store, agentStore } = fresh();
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
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER,
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
  }
});

test("recorder: wake falls back without retrying the primary after a timeout", async () => {
  const originalError = console.error;
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  console.error = () => {};
  const { store, agentStore } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const primary = createMockLLM([
      { error: "The operation timed out." },
      { error: "a timeout must not be retried on the same model" }
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
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER,
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
    expect(primaryCall.metadata?.providerName).toBe("primary");
    expect(fallbackCall.metadata?.providerName).toBe("backup");
    expect(fallbackCall.metadata?.candidateIndex).toBe(1);
    expect(fallbackCall.metadata?.attempt).toBe(1);
  } finally {
    console.error = originalError;
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("recorder: wake retries the primary once for an overload even when a fallback exists", async () => {
  const originalError = console.error;
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  console.error = () => {};
  const { store, agentStore } = fresh();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const primary = createMockLLM([
      { error: Object.assign(new Error("Overloaded"), { status: 529 }) },
      { text: "primary retry ok", finishReason: "stop" }
    ], { provider: "codex", modelId: "gpt-5.5" });
    const fallback = createMockLLM([
      { text: "fallback must not be reached", finishReason: "stop" }
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
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER,
      llmModel: primary,
      llmForThread: () => ({
        model: primary,
        llmCallRecorder: primaryRecorder,
        candidates: [
          { model: primary, llmCallRecorder: primaryRecorder, meta: { provider: "codex", model: "gpt-5.5" } },
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

    expect([primary.callsMade, fallback.callsMade]).toEqual([2, 0]);
    const calls = store.listLlmCalls(50).slice().reverse();
    expect(calls.map((call) => [call.provider, call.status])).toEqual([
      ["codex", "failed"],
      ["codex", "succeeded"]
    ]);
    // A retry of the primary is still a primary call on the Activity page.
    expect(calls[1]!.metadata).toMatchObject({ fallbackAttempt: false, candidateIndex: 0, attempt: 2 });
    const reply = agentStore.getActiveMessages(thread.id).at(-1)!;
    expect(reply.content.type === "assistant" ? reply.content.text : "").toBe("primary retry ok");
  } finally {
    console.error = originalError;
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("recorder: a subagent's steps, retries included, are filed under subagent_step with its parent; another thread's stay agent_wake_step", async () => {
  const originalError = console.error;
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "silent";
  console.error = () => {};
  const { store, agentStore } = fresh();
  try {
    const child = agentStore.getOrCreateThread("worker", "feat-child");
    const other = agentStore.getOrCreateThread("worker", "feat-other");
    const say = (threadId: string) => agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "hi" } }).id;
    const llm = createMockLLM([
      { error: "service unavailable" },
      { text: "Found the call sites.", finishReason: "stop" },
      { text: "ok", finishReason: "stop" }
    ]);
    const recorder = new AgentLlmCallRecorder({
      store, logRequests: "metadata",
      provider: "codex", model: "gpt-5.5", baseURL: "", apiMode: "streamText"
    });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: STUB_PROMPT,
      toolDispatcherForThread: () => STUB_DISPATCHER,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      llmCallRecorder: recorder,
      stepRecordingForThread: (threadId) => (threadId === child.id
        ? { purpose: "subagent_step", metadata: { parentThreadId: "thr_parent" } }
        : null)
    });
    await wakeAndWait(child.id, "user", say(child.id));
    await wakeAndWait(other.id, "user", say(other.id));

    // By thread, not by the list's order: two calls can start in one millisecond.
    const calls = store.listLlmCalls(50);
    const ofChild = calls.filter((c) => c.scopeId === child.id);
    const ofOther = calls.filter((c) => c.scopeId === other.id);
    expect(ofChild.map((c) => [c.purpose, c.status]).sort()).toEqual([["subagent_step", "failed"], ["subagent_step", "succeeded"]]);
    expect(ofOther.map((c) => c.purpose)).toEqual(["agent_wake_step"]);
    for (const c of ofChild) {
      expect(c.metadata).toMatchObject({ parentThreadId: "thr_parent", wakeId: expect.any(String), promptMaxSeq: expect.any(Number) });
    }
    // The retry, recorded by the attempts runner itself, carries them too.
    expect(ofChild.find((c) => c.status === "succeeded")!.metadata).toMatchObject({ attempt: 2, parentThreadId: "thr_parent" });
    expect(ofOther[0]!.metadata?.parentThreadId).toBeUndefined();
  } finally {
    console.error = originalError;
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
  }
});

test("recorder: provider error metadata is compact and structured", () => {
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  const oldDebug = process.env.MANDATE_DEBUG;
  process.env.MANDATE_LOG_LEVEL = "info";
  delete process.env.MANDATE_DEBUG;

  const { store } = fresh();
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

  const { store } = fresh();
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
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
    if (oldDebug === undefined) delete process.env.MANDATE_DEBUG;
    else process.env.MANDATE_DEBUG = oldDebug;
  }
});


test("runtime recorders retain configured provider names through metadata updates", () => {
  const { store } = fresh();
  const config = structuredClone(DEFAULT_CONFIG);
  config.agent.logRequests = "metadata";
  for (const role of ["manager", "worker", "global", "extraction", "subagent", "page"] as const) {
    config.agent[role].provider = "openai-compatible";
    config.agent[role].providerName = `${role}-gateway`;
    config.agent[role].model = "test-model";
  }
  const recorders = createAgentRuntimeLlmRecorders({ config, store });
  // The subagent route's two are walked too.
  expect(Object.keys(recorders)).toEqual(expect.arrayContaining(["subagentWakeRecorder", "compressionSubagentRecorder", "pageWakeRecorder", "compressionPageRecorder"]));
  for (const [key, recorder] of Object.entries(recorders)) {
    const lower = key.toLowerCase();
    const expectedName = lower.includes("page") ? "page-gateway" : lower.includes("subagent") ? "subagent-gateway" : lower.includes("extraction") ? "extraction-gateway" : lower.includes("manager") ? "manager-gateway" : lower.includes("global") ? "global-gateway" : "worker-gateway";
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

  // Each one also carries its route's API and connection type: a Kilo route
  // running as another family still has its cost read as Kilo's.
  for (const role of ["manager", "worker", "global", "extraction", "subagent", "page"] as const) {
    config.agent[role].api = "chat";
    config.agent[role].providerType = "kilo";
    config.agent[role].baseURL = "https://kilo-proxy.example/api/gateway";
  }
  for (const [key, kiloRecorder] of Object.entries(createAgentRuntimeLlmRecorders({ config, store }))) {
    const callId = kiloRecorder.startCall({ purpose: "test", scopeType: "agent_thread", scopeId: "thread" })!;
    kiloRecorder.finishCall(callId, { status: "succeeded", result: { facts: { usageCost: 0.0032, upstreamCost: 0.0642 } } });
    expect([key, store.getLlmCall(callId)?.metadata?.api, priceColumns(store, callId).reported_cost_field])
      .toEqual([key, "chat", "upstream_inference_cost"]);
  }
});

function priceColumns(store: MandateStore, id: string) {
  return store.db.prepare(
    "select provider_name, reported_cost_micros, reported_cost_field, cache_write_1h_tokens, cache_write_5m_tokens, service_tier, input_tokens, cache_read_tokens from llm_calls where id = ?"
  ).get(id) as Record<string, unknown>;
}

function factsRecorder(store: MandateStore, provider = "anthropic", baseURL = "https://gw.example.test/v1") {
  return new AgentLlmCallRecorder({ store, logRequests: "metadata", provider, providerName: "gw", model: "m", baseURL, apiMode: "streamText" });
}

test("recorder: finish writes the price facts and the connection name", () => {
  const { store } = fresh();
  const recorder = factsRecorder(store);
  const id = recorder.startCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "t" })!;
  recorder.finishCall(id, {
    status: "succeeded",
    result: { text: "ok", toolCalls: [], facts: { litellmHeader: "0.0042", cacheWrite1h: 900, cacheWrite5m: 120, serviceTier: "flex" } },
    usage: { promptTokens: 1000, completionTokens: 10 }
  });
  expect(priceColumns(store, id)).toMatchObject({
    provider_name: "gw", reported_cost_micros: 4200, reported_cost_field: "x-litellm-response-cost",
    cache_write_1h_tokens: 900, cache_write_5m_tokens: 120, service_tier: "flex"
  });
});

test("recorder: kilo's fee is not recorded as the reported cost", () => {
  const { store } = fresh();
  const recorder = factsRecorder(store, "kilo");
  const id = recorder.startCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "t" })!;
  recorder.finishCall(id, { status: "succeeded", result: { text: "ok", toolCalls: [], facts: { usageCost: 0.0032 } }, usage: { promptTokens: 1, completionTokens: 1 } });
  expect(priceColumns(store, id)).toMatchObject({ reported_cost_micros: null, reported_cost_field: null });
});

test("recorder: a custom connection at Kilo's address does not record Kilo's fee either", () => {
  const { store } = fresh();
  const recorder = factsRecorder(store, "openai-compatible", "https://api.kilo.ai/api/gateway");
  const id = recorder.startCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "t" })!;
  recorder.finishCall(id, { status: "succeeded", result: { text: "ok", toolCalls: [], facts: { usageCost: 0.0032 } }, usage: { promptTokens: 1, completionTokens: 1 } });
  expect(priceColumns(store, id)).toMatchObject({ reported_cost_micros: null, reported_cost_field: null });
});

test("recorder: a failed call records the usage and facts it had", () => {
  const { store } = fresh();
  const recorder = factsRecorder(store);
  const id = recorder.startCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "t" })!;
  const error = Object.assign(new Error("boom"), {
    facts: { cacheWrite1h: 0 },
    usageSoFar: { inputTokens: 5010, inputTokenDetails: { cacheReadTokens: 5000, cacheWriteTokens: 0 } }
  });
  recorder.finishCall(id, { status: "failed", error });
  expect(priceColumns(store, id)).toMatchObject({ input_tokens: 5010, cache_read_tokens: 5000, cache_write_1h_tokens: 0 });
});

test("recorder: the text-model path reads provider metadata, headers and raw usage", () => {
  const { store } = fresh();
  const recorder = factsRecorder(store, "openai-compatible");
  const id = recorder.startCall({ purpose: "agent_compression", scopeType: "agent_thread", scopeId: "t" })!;
  recorder.finishCall(id, {
    status: "succeeded",
    result: {
      text: "summary",
      providerMetadata: { openai: { serviceTier: "priority" } },
      response: { headers: {} },
      usage: { inputTokens: 100, outputTokens: 10, raw: { cost: 0.002, is_byok: false } }
    }
  });
  expect(priceColumns(store, id)).toMatchObject({ reported_cost_micros: 2000, reported_cost_field: "usage.cost", service_tier: "priority" });
});

test("recorder: what is learned after a call merges into its metadata; metadata that is not an object is left as it is", () => {
  const { store } = fresh();
  onCleanup(() => store.db.close());
  const recorder = new AgentLlmCallRecorder({ store, logRequests: "metadata", provider: "gw", model: "m", baseURL: "", apiMode: "generateText" });
  const id = recorder.startCall({ purpose: "manager_request_check", scopeType: "agent_thread", scopeId: "thr_1", metadata: { kind: "chat" } });
  recorder.finishCall(id, { status: "succeeded", metadata: { kind: "chat", judgement: { answer: "done", subject: { replySeq: 3 } } } });
  recorder.mergeMetadata(id, { judgement: { notUsed: "newer_reply" } });
  expect(store.listLlmCalls(5)[0]!.metadata).toEqual({ kind: "chat", judgement: { answer: "done", subject: { replySeq: 3 }, notUsed: "newer_reply" } });
  for (const kept of ["not json at all", "[1,2]"]) {
    store.db.prepare("update llm_calls set metadata_json = ? where id = ?").run(kept, id);
    recorder.mergeMetadata(id, { judgement: { notUsed: "stopped" } });
    expect((store.db.prepare("select metadata_json from llm_calls where id = ?").get(id) as { metadata_json: string }).metadata_json).toBe(kept);
  }
});
