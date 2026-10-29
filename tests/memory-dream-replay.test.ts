import { expect, jest, test } from "bun:test";
import { fakeClock } from "./helpers/fake-clock.js";
import { pacedModel } from "./helpers/paced-model.js";
import { LLM_STREAM_IDLE_TIMEOUT_MS } from "../src/server/modules/llm/timeouts.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { freshStoresEnv, seedProject } from "./helpers/fixtures.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { MemoryManager } from "../src/server/modules/memory/manager.js";
import { MemoryDreamer } from "../src/server/modules/memory/dream.js";
import { ANTHROPIC_CACHE_CONTROL } from "../src/server/modules/llm/anthropic-cache.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";

// A dream's steps go to the model as an agent's do: each step's own record
// (its reasoning, kept encrypted) goes back to the model id that wrote it, and
// another model gets the visible step; the provider keeps nothing.

type Call = { toolName: string; args: Record<string, unknown> };
const step = (calls: Call[], extra: Record<string, unknown> = {}) => ({
  toolCalls: calls.map((call, i) => ({ toolCallId: `c${i}`, toolName: call.toolName, args: call.args })),
  finishReason: "tool-calls" as const,
  ...extra
});

type Prompt = Array<{ role: string; content?: unknown; providerOptions?: Record<string, Record<string, unknown>> }>;
const promptOf = (model: ReturnType<typeof createMockLLM>, index: number) => model.streamCalls[index]!.prompt as unknown as Prompt;
const assistantParts = (prompt: Prompt) => prompt
  .filter((message) => message.role === "assistant")
  .flatMap((message) => (Array.isArray(message.content) ? message.content : [])) as Array<{ type: string; providerOptions?: Record<string, Record<string, unknown>>; toolName?: string }>;

async function setup() {
  const env = freshStoresEnv("md-dream-replay-");
  const memory = new MemoryManager(new LocalMemoryProvider(env.store.db));
  const project1 = seedProject(env.projects, { name: "project-1", tmuxSessionName: "md-project-1" });
  const entry = await memory.remember({ scope: "project", projectId: project1, type: "knowledge", source: "agent", content: "project-1 releases go out on Tuesdays." });
  const base = { db: env.store.db, records: new FeatureRecordStore(env.store.db), memory, agentStore: env.agentStore, projectsStore: env.projects, contextLimitTokens: 200_000 };
  return { env, memory, project1, entry, base };
}

const reread = (id: string): Call => ({ toolName: "read_entry", args: { memoryId: id } });
const brief: Call = { toolName: "write_brief", args: { content: "project-1: releases go out on Tuesdays.", summary: "kept one" } };

test("a dream step sends back the reasoning its model returned on the step before, encrypted content and all", async () => {
  const t = await setup();
  try {
    const model = createMockLLM([
      step([reread(t.entry.id)], { reasoning: ["Reading the one memory first."] }),
      step([brief])
    ], { provider: "openai.responses", modelId: "gpt-6.1-sol" });
    const dreamer = new MemoryDreamer({ ...t.base, model, provider: "openai-compatible", modelName: "openai/gpt-6.1-sol", maxSteps: 2 });
    const result = await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "succeeded" });
    const reasoning = assistantParts(promptOf(model, 1)).filter((part) => part.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.providerOptions?.openai).toMatchObject({ itemId: "rs_mock", reasoningEncryptedContent: "enc-mock" });
  } finally {
    t.env.cleanup();
  }
});

test("a dream step asks the provider to keep nothing, keys its prompt cache by the run, and asks for no summary", async () => {
  const t = await setup();
  try {
    const model = createMockLLM([step([brief])], { provider: "openai.responses", modelId: "gpt-6.1-sol" });
    const dreamer = new MemoryDreamer({ ...t.base, model, provider: "openai-compatible", modelName: "openai/gpt-6.1-sol", maxSteps: 1 });
    const result = await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    expect(model.streamCalls[0]!.providerOptions?.openai).toMatchObject({ store: false, promptCacheKey: result.runId, reasoningSummary: null });
  } finally {
    t.env.cleanup();
  }
});

test("a fallback of another model id gets the earlier step without the primary's reasoning, with its tool call", async () => {
  const t = await setup();
  try {
    const primary = createMockLLM([
      step([reread(t.entry.id)], { reasoning: ["Reading the one memory first."] }),
      { error: "The operation timed out." },
      { error: "The operation timed out." }
    ], { provider: "openai.responses", modelId: "gpt-6.1-sol" });
    const fallback = createMockLLM([step([brief])], { provider: "openai.responses", modelId: "gpt-6-luna" });
    const dreamer = new MemoryDreamer({
      ...t.base, model: primary, provider: "openai-compatible", modelName: "openai/gpt-6.1-sol", maxSteps: 2,
      candidates: [
        { model: primary, provider: "openai-compatible", modelName: "openai/gpt-6.1-sol" },
        { model: fallback, provider: "openai-compatible", modelName: "openai/gpt-6-luna" }
      ]
    });
    const result = await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "succeeded" });
    const parts = assistantParts(promptOf(fallback, 0));
    expect(parts.filter((part) => part.type === "reasoning")).toEqual([]);
    expect(parts.filter((part) => part.type === "tool-call").map((part) => part.toolName)).toEqual(["read_entry"]);
    // The primary's own retry of that step got its reasoning back.
    expect(assistantParts(promptOf(primary, 1)).filter((part) => part.type === "reasoning")).toHaveLength(1);
  } finally {
    t.env.cleanup();
  }
}, 20_000);

test("each attempt of a dream step records the history it sent: the primary's with its reasoning, the fallback's without", async () => {
  const t = await setup();
  try {
    const recorder = (model: string) => new AgentLlmCallRecorder({ store: t.env.store, logRequests: "full", provider: "openai-compatible", model, baseURL: "", apiMode: "streamText" });
    const primary = createMockLLM([
      step([reread(t.entry.id)], { reasoning: ["Reading the one memory first."] }),
      { error: "The operation timed out." },
      { error: "The operation timed out." }
    ], { provider: "openai.responses", modelId: "gpt-6.1-sol" });
    const fallback = createMockLLM([step([brief])], { provider: "openai.responses", modelId: "gpt-6-luna" });
    const dreamer = new MemoryDreamer({
      ...t.base, model: primary, provider: "openai-compatible", modelName: "openai/gpt-6.1-sol", maxSteps: 2,
      candidates: [
        { model: primary, provider: "openai-compatible", modelName: "openai/gpt-6.1-sol", recorder: recorder("openai/gpt-6.1-sol") },
        { model: fallback, provider: "openai-compatible", modelName: "openai/gpt-6-luna", recorder: recorder("openai/gpt-6-luna") }
      ]
    });
    await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    const recorded = (t.env.store.db.prepare("select request_json from llm_calls where purpose = 'memory_dream' order by rowid").all() as Array<{ request_json: string }>)
      .map((row) => row.request_json.includes("rs_mock"));
    // Step 1; step 2 on the primary (a timeout moves on at once), then on the
    // fallback. (The log keeps the item, its encrypted content omitted.)
    expect(recorded).toEqual([false, true, false]);
  } finally {
    t.env.cleanup();
  }
}, 20_000);

test("an Anthropic model's dream steps carry the agent's hour-long cache marks: the instruction and the step's history", async () => {
  const t = await setup();
  try {
    const model = createMockLLM([step([reread(t.entry.id)]), step([brief])], { provider: "anthropic.messages", modelId: "claude-sonnet-5-5" });
    const dreamer = new MemoryDreamer({ ...t.base, model, provider: "anthropic", modelName: "anthropic/claude-sonnet-5-5", maxSteps: 2 });
    await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    const prompt = promptOf(model, 1);
    expect(prompt[0]!.role).toBe("system");
    expect(prompt[0]!.providerOptions?.anthropic?.cacheControl).toEqual(ANTHROPIC_CACHE_CONTROL);
    expect(prompt.at(-1)!.providerOptions?.anthropic?.cacheControl).toEqual(ANTHROPIC_CACHE_CONTROL);
  } finally {
    t.env.cleanup();
  }
});

// The SDK's chunk timer resets only on parts it emits, and the Open Responses
// package emits none while a tool call's arguments stream. As an agent's step
// does, a dream step on it leaves a stall to the idle guard, which counts the
// provider's deltas; a stream gone quiet is still cut.
function openResponsesModel(argumentGaps: number[], streamed: "arguments" | "reasoning" = "arguments") {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const args = JSON.stringify(brief.args);
  return {
    specificationVersion: "v4" as const, provider: "openResponses.responses", modelId: "deepseek/deepseek-flash", supportedUrls: {},
    doGenerate: async () => { throw new Error("streams only"); },
    doStream: async ({ abortSignal }: { abortSignal?: AbortSignal }) => ({
      stream: new ReadableStream({
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "reasoning-start", id: "r" });
          controller.enqueue({ type: "reasoning-delta", id: "r", delta: "Writing the brief." });
          // Argument deltas the package holds back, or more reasoning it
          // passes on, each after its gap.
          for (const gap of argumentGaps) {
            await sleep(gap);
            if (abortSignal?.aborted) { controller.error(abortSignal.reason); return; }
            controller.enqueue(streamed === "arguments"
              ? { type: "raw", rawValue: { type: "response.function_call_arguments.delta", delta: "x" } }
              : { type: "reasoning-delta", id: "r", delta: " More." });
          }
          controller.enqueue({ type: "reasoning-end", id: "r" });
          controller.enqueue({ type: "tool-input-start", id: "c0", toolName: brief.toolName });
          controller.enqueue({ type: "tool-input-delta", id: "c0", delta: args });
          controller.enqueue({ type: "tool-input-end", id: "c0" });
          controller.enqueue({ type: "tool-call", toolCallId: "c0", toolName: brief.toolName, input: args });
          controller.enqueue({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: { inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
          controller.close();
        }
      })
    })
  };
}

test("a dream step on the Open Responses package outlives the SDK's chunk timer while a tool call's arguments stream", async () => {
  const t = await setup();
  try {
    // 300 ms of argument deltas, 30 ms apart: past a 50 ms chunk timer and
    // past the 200 ms idle guard's window, each delta well inside it.
    const model = openResponsesModel(Array.from({ length: 10 }, () => 30));
    const dreamer = new MemoryDreamer({
      ...t.base, model: model as never, provider: "openai-compatible", modelName: "deepseek/deepseek-flash", maxSteps: 1,
      llmTimeout: { totalMs: 5_000, chunkMs: 50 }, streamIdleTimeoutMs: 200
    });
    const result = await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "succeeded" });
  } finally {
    t.env.cleanup();
  }
});

test("a dream step whose model goes on thinking past the idle guard's window is not cut", async () => {
  const t = await setup();
  try {
    const model = openResponsesModel(Array.from({ length: 10 }, () => 30), "reasoning");
    const dreamer = new MemoryDreamer({
      ...t.base, model: model as never, provider: "openai-compatible", modelName: "deepseek/deepseek-flash", maxSteps: 1,
      llmTimeout: { totalMs: 5_000, chunkMs: 50 }, streamIdleTimeoutMs: 200
    });
    const result = await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "succeeded" });
  } finally {
    t.env.cleanup();
  }
});

test("a dream step whose stream goes quiet past the idle guard is cut", async () => {
  const t = await setup();
  try {
    const model = openResponsesModel([300]);
    const dreamer = new MemoryDreamer({
      ...t.base, model: model as never, provider: "openai-compatible", modelName: "deepseek/deepseek-flash", maxSteps: 1,
      llmTimeout: { totalMs: 5_000, chunkMs: 50 }, streamIdleTimeoutMs: 100
    });
    const result = await dreamer.run("manual", { kind: "project", projectId: t.project1 });
    expect(result).toMatchObject({ status: "failed" });
  } finally {
    t.env.cleanup();
  }
}, 20_000);

// A dream step is a background read too; by default its stream may go quiet
// 2 minutes, as extraction's and a compaction summary's may, before it is cut.
test("by default a dream step's quiet stream is cut at 2 minutes, not before", async () => {
  const t = await setup();
  try {
    fakeClock();
    const model = pacedModel({ gaps: [Infinity], text: "" });
    const dreamer = new MemoryDreamer({ ...t.base, model: model as never, provider: "openai-compatible", modelName: "deepseek/deepseek-v4-flash", maxSteps: 1 });
    let out: unknown = "pending";
    void dreamer.run("manual", { kind: "project", projectId: t.project1 }).then((result) => { out = result; }, (error) => { out = error; });
    const moveOn = async (ms: number) => {
      for (let i = 0; i < 100; i++) await Promise.resolve();
      jest.advanceTimersByTime(ms);
      for (let i = 0; i < 100; i++) await Promise.resolve();
    };
    for (let i = 0; i < 20 && model.calls.length === 0; i++) await moveOn(0);
    // A second short of the window it is alive; at the window it is cut.
    await moveOn(LLM_STREAM_IDLE_TIMEOUT_MS - 1_000);
    expect(model.seen.aborted).toBe(false);
    await moveOn(1_000);
    expect(model.seen.aborted).toBe(true);
    for (let i = 0; i < 50 && out === "pending"; i++) await moveOn(0);
    expect(out).toMatchObject({ status: "failed" });
  } finally {
    t.env.cleanup();
  }
});
