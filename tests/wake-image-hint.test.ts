import { expect, test } from "bun:test";
import fs from "node:fs";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { withImageHint } from "../src/server/modules/agent/wake-failure-hint.js";
import { ModelImageFitter } from "../src/server/modules/agent/model-images.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import type { WakeLlmCandidate } from "../src/server/modules/agent/wake-loop.js";
import { stub } from "./helpers/typed.js";

// A request rejection on a prompt that carried images may be the model refusing
// them: the failure says which setting turns image input off. Nothing is
// learned.

const STUB_SCOPE = (_t: string): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const DISPATCH = stub<ToolDispatcher>({ registry: stub<ToolRegistry>({ tools: {} }), dispatch: async () => ({ result: "ok" }) });
const HINT = "turn off its Image input in Settings → Providers";

async function failingWake(opts: { image: boolean; error: Error }) {
  const store = new MandateStore(tempDir("md-image-hint-"));
  const agentStore = new AgentStore(store.db);
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-hint");
    const ask = agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: {
        type: "text", text: "look",
        ...(opts.image ? { attachments: [{ type: "image", id: "img-1", name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=", sizeBytes: 8 }] } : {})
      }
    });
    // The summary-free retry consumes a second turn; give it the same failure.
    const llm = createMockLLM([{ error: opts.error }, { error: opts.error }, { error: opts.error }], { provider: "openai.responses", modelId: "deepseek/deepseek-v4-pro" });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: () => "stub system prompt",
      toolDispatcherForThread: () => DISPATCH,
      llmModel: llm,
      llmForThread: () => ({ model: llm, candidates: [{ model: llm, meta: { provider: "openai-compatible", model: "deepseek/deepseek-v4-pro", baseURL: "https://proxy.example/v1" } }] }),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE
    });
    await wakeAndWait(thread.id, "user", ask.id);
    const row = agentStore.getMessages(thread.id).find((m) => m.content.type === "wake_failure")!;
    return (row.content as { message: string | null }).message ?? "";
  } finally {
    store.db.close();
  }
}

const rejected = () => Object.assign(new Error("unknown variant `image_url`, expected `text`"), { statusCode: 400 });

test("a rejected request that carried an image names the model and the setting", async () => {
  const message = await failingWake({ image: true, error: rejected() });
  // The provider's own words first; the hint after, as a possibility.
  expect(message.startsWith("Model provider rejected the request: unknown variant `image_url`, expected `text`.")).toBe(true);
  expect(message).toContain(HINT);
  expect(message).toContain("If deepseek/deepseek-v4-pro doesn't take images");
});

test("the same rejection without an image shows no hint", async () => {
  expect(await failingWake({ image: false, error: rejected() })).not.toContain(HINT);
});

test("an image turn that fails another way (auth) shows no hint", async () => {
  const unauthorized = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
  expect(await failingWake({ image: true, error: unauthorized })).not.toContain(HINT);
});

test("withImageHint: unchanged without an image model or for another category", () => {
  const invalid = { message: "Model provider rejected the request.", category: "invalid_request", retryable: false } as const;
  expect(withImageHint(invalid, undefined)).toBe(invalid.message);
  expect(withImageHint({ ...invalid, category: "auth_failed" }, "m")).toBe(invalid.message);
  expect(withImageHint(invalid, "m")).toBe(`${invalid.message} The request included images. If m doesn't take images, turn off its Image input in Settings → Providers.`);
});

function imageThread(agentStore: AgentStore) {
  const thread = agentStore.getOrCreateThread("worker", `feat-${Math.random().toString(36).slice(2)}`);
  const ask = agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "look", attachments: [{ type: "image", id: "img-1", name: "shot.png", mediaType: "image/png", data: "iVBORw0KGgo=", sizeBytes: 8 }] }
  });
  return { thread, ask };
}
const meta = (model: string): WakeLlmCandidate["meta"] => ({ provider: "openai-compatible", model, baseURL: "https://proxy.example/v1" });

test("the hint names the model whose request was rejected, not the primary", async () => {
  const store = new MandateStore(tempDir("md-image-hint-fallback-"));
  const agentStore = new AgentStore(store.db);
  try {
    const { thread, ask } = imageThread(agentStore);
    const unauthorized = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    const primary = createMockLLM([{ error: unauthorized }, { error: unauthorized }], { provider: "openai.responses", modelId: "primary-vision" });
    const fallback = createMockLLM([{ error: rejected() }, { error: rejected() }], { provider: "openai.responses", modelId: "fallback-text-only" });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: () => "stub system prompt",
      toolDispatcherForThread: () => DISPATCH,
      llmModel: primary,
      llmForThread: () => ({ model: primary, candidates: [{ model: primary, meta: meta("primary-vision") }, { model: fallback, meta: meta("fallback-text-only") }] }),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE
    });
    await wakeAndWait(thread.id, "user", ask.id);
    const message = (agentStore.getMessages(thread.id).find((m) => m.content.type === "wake_failure")!.content as { message: string }).message;
    expect([message.includes("If fallback-text-only doesn't take images"), message.includes("primary-vision")]).toEqual([true, false]);
  } finally {
    store.db.close();
  }
});

test("a failure before the next request (compression in the pre-call hook) shows no hint, even after an image request failed earlier", async () => {
  const store = new MandateStore(tempDir("md-image-hint-stale-"));
  const agentStore = new AgentStore(store.db);
  try {
    const { thread, ask } = imageThread(agentStore);
    // Step 1: the primary rejects the image request, the fallback answers with a tool call.
    const primary = createMockLLM([{ error: rejected() }, { error: rejected() }], { provider: "openai.responses", modelId: "primary-text-only" });
    const fallback = createMockLLM([{ toolCalls: [{ toolCallId: "c1", toolName: "read", args: { path: "a" } }], finishReason: "tool-calls" }], { provider: "openai.responses", modelId: "fallback-vision" });
    let hookCalls = 0;
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: () => "stub system prompt",
      toolDispatcherForThread: () => DISPATCH,
      llmModel: primary,
      llmForThread: () => ({ model: primary, candidates: [{ model: primary, meta: meta("primary-text-only") }, { model: fallback, meta: meta("fallback-vision") }] }),
      // Step 2's compression (image-free) is rejected before any model request.
      beforeModelCallHook: async () => {
        hookCalls += 1;
        if (hookCalls === 2) throw Object.assign(new Error("Invalid request: compression rejected"), { statusCode: 400 });
        return { historyChanged: false };
      },
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE
    });
    await wakeAndWait(thread.id, "user", ask.id);
    expect(hookCalls).toBe(2);
    const message = (agentStore.getMessages(thread.id).find((m) => m.content.type === "wake_failure")!.content as { message: string }).message;
    expect(message).not.toContain(HINT);
  } finally {
    store.db.close();
  }
});

// What a step sends: an image longer than 2000 px goes at 2000 (a provider
// may refuse a long, narrow screenshot); the stored one is left.
test("a step sends an oversized image at 2000 px on its longer side", async () => {
  const store = new MandateStore(tempDir("md-image-fit-"));
  const agentStore = new AgentStore(store.db);
  try {
    const icon = new Uint8Array(fs.readFileSync("assets/pwa/icon-512.png"));
    const tall = await new Bun.Image(icon).resize(600, 9000).png().bytes();
    const data = Buffer.from(tall).toString("base64");
    const thread = agentStore.getOrCreateThread("worker", "feat-fit");
    const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "look", attachments: [{ type: "image", id: "img-tall", name: "page.png", mediaType: "image/png", data, sizeBytes: tall.length }] } });
    const llm = createMockLLM([{ text: "Seen." }], { provider: "openai.responses", modelId: "vision" });
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: () => "stub system prompt",
      toolDispatcherForThread: () => DISPATCH,
      llmModel: llm,
      llmForThread: () => ({ model: llm, candidates: [{ model: llm, meta: meta("vision") }] }),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE
    });
    await wakeAndWait(thread.id, "user", ask.id);
    const sent = JSON.stringify(llm.streamCalls[0]!.prompt, (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value));
    expect(sent).not.toContain(data.slice(0, 2000));
    const part = (llm.streamCalls[0]!.prompt as Array<{ role: string; content: unknown }>)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p: { type?: string }) => p.type === "file") as { data: Uint8Array | string; mediaType: string };
    const bytes = typeof part.data === "string" ? new Uint8Array(Buffer.from(part.data, "base64")) : new Uint8Array(part.data);
    expect(await new Bun.Image(bytes).metadata()).toMatchObject({ width: 133, height: 2000 });
    expect(JSON.stringify(agentStore.getMessageById(ask.id)!.content)).toContain(data);
  } finally {
    store.db.close();
  }
}, 30_000);

// A compaction on the step's prompt, with no step before it (after a restart,
// or when the image is what pushed the context over): its images are fitted
// too.
test("the step's prompt taken for a compaction carries its images fitted", async () => {
  const store = new MandateStore(tempDir("md-image-fit-compaction-"));
  const agentStore = new AgentStore(store.db);
  try {
    const icon = new Uint8Array(fs.readFileSync("assets/pwa/icon-512.png"));
    const tall = await new Bun.Image(icon).resize(600, 9000).png().bytes();
    const thread = agentStore.getOrCreateThread("worker", "feat-fit-compaction");
    agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "look", attachments: [{ type: "image", id: "img-tall", name: "page.png", mediaType: "image/png", data: Buffer.from(tall).toString("base64"), sizeBytes: tall.length }] } });
    const llm = createMockLLM([], { provider: "openai.responses", modelId: "vision" });
    const { scheduler } = createTestWakeScheduler({
      agentStore, lock: new WakeLock(),
      buildSystemPrompt: () => "stub system prompt",
      toolDispatcherForThread: () => DISPATCH,
      llmModel: llm,
      llmForThread: () => ({ model: llm, candidates: [{ model: llm, meta: meta("vision") }] }),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      modelImages: new ModelImageFitter()
    });
    const prompt = await scheduler.stepPromptFor(thread.id);
    const part = (prompt.messages as Array<{ content: unknown }>).flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((p: { type?: string }) => p.type === "file") as { data: { data: string } };
    expect(await new Bun.Image(new Uint8Array(Buffer.from(part.data.data, "base64"))).metadata()).toMatchObject({ width: 133, height: 2000 });
  } finally {
    store.db.close();
  }
}, 30_000);
