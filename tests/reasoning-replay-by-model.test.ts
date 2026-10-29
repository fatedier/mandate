import { expect, test } from "bun:test";
import * as os from "node:os";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";

// Each candidate model gets the history it can take: a step's stored provider
// state goes to the model id that wrote it, the visible step to any other.
// A fallback taking over mid-thread is the case that matters.

const SCOPE = (_t: string): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });
const NO_TOOLS: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };

function setup(fallbackModel: string, fallbackProvider: string, fallbackSdk = "openai.responses") {
  const store = new MandateStore(tempDir("md-replay-by-model-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("project-1 3.22 release");
  agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  agentStore.appendMessage({
    threadId: thread.id, role: "assistant", source: "self",
    content: {
      type: "assistant", text: "Looked at the changelog.",
      writtenBy: { provider: "provider-1", model: "openai/gpt-6.1-sol" },
      sdkAssistantMessages: [{ role: "assistant", content: [
        { type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_a", reasoningEncryptedContent: "enc-by-gpt" } } },
        { type: "text", text: "Looked at the changelog." }
      ] }]
    }
  });
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Go on" } });
  const primary = createMockLLM([{ error: "The operation timed out." }], { provider: "openai.responses", modelId: "gpt-6.1-sol" });
  const fallback = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }], { provider: fallbackSdk, modelId: fallbackModel });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => NO_TOOLS,
    llmModel: primary,
    llmForThread: () => ({
      model: primary,
      candidates: [
        { model: primary, meta: { provider: "openai-compatible", providerName: "provider-1", model: "openai/gpt-6.1-sol" } },
        { model: fallback, meta: { provider: "openai-compatible", providerName: fallbackProvider, model: fallbackModel, reasoningEffort: "medium" as const } }
      ]
    }),
    sse: { emit: () => {} },
    buildToolScope: SCOPE
  });
  return { agentStore, thread, primary, fallback, wake: () => wakeAndWait(thread.id, "user", ask.id) };
}

const sent = (llm: ReturnType<typeof createMockLLM>) => JSON.stringify(llm.calls[0]!.options.prompt);

test("a fallback of another model id gets the earlier step without the primary's reasoning; the primary got it", async () => {
  const s = setup("x-ai/grok-4.7", "provider-1");
  await s.wake();
  expect(sent(s.primary)).toContain("enc-by-gpt");
  expect(sent(s.fallback)).not.toContain("enc-by-gpt");
  expect(sent(s.fallback)).toContain("Looked at the changelog.");
  // The step the fallback wrote says so.
  const last = s.agentStore.getMessages(s.thread.id).filter((m) => m.role === "assistant").at(-1)!;
  expect(last.content).toMatchObject({ text: "Here is the draft.", writtenBy: { provider: "provider-1", model: "x-ai/grok-4.7" } });
});

test("a fallback of the same model id through another provider gets the reasoning as it was", async () => {
  const s = setup("openai/gpt-6.1-sol", "kilo");
  await s.wake();
  expect(sent(s.fallback)).toContain("enc-by-gpt");
  const last = s.agentStore.getMessages(s.thread.id).filter((m) => m.role === "assistant").at(-1)!;
  expect(last.content).toMatchObject({ writtenBy: { provider: "kilo", model: "openai/gpt-6.1-sol" } });
});

// A fallback that needs its reasoning back (DeepSeek on the Open Responses
// package) gets the earlier GPT step with a one-space reasoning placeholder,
// which DeepSeek takes where it refuses a step with none; the GPT primary
// got the step as it was.
test("a DeepSeek fallback gets another model's step with the reasoning placeholder", async () => {
  const s = setup("deepseek/deepseek-flash", "provider-1", "openResponses.responses");
  await s.wake();
  const step = (llm: ReturnType<typeof createMockLLM>) => llm.calls[0]!.options.prompt.find((m: { role: string }) => m.role === "assistant") as { content: unknown[] };
  expect(step(s.fallback).content[0]).toEqual({ type: "reasoning", text: " " });
  expect(JSON.stringify(step(s.primary).content)).not.toContain('"text":" "');
});

// One model id on two connections, one on Chat and one on the Open Responses
// package: each gets its own history (the placeholder only on the latter).
test("the same model id on Chat and on the Open Responses package each get their own history", async () => {
  const store = new MandateStore(tempDir("md-replay-same-id-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("project-1 notes");
  agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Looked at the changelog.", writtenBy: { provider: "provider-1", model: "openai/gpt-6.1-sol" } } });
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Go on" } });
  const DS = "deepseek/deepseek-flash";
  const onChat = createMockLLM([{ error: "The operation timed out." }], { provider: "kilo.chat", modelId: DS });
  const onOpenResponses = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }], { provider: "openResponses.responses", modelId: DS });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(), buildSystemPrompt: () => "stub system prompt", toolDispatcherForThread: () => NO_TOOLS,
    llmModel: onChat,
    llmForThread: () => ({ model: onChat, candidates: [
      { model: onChat, meta: { provider: "kilo", providerName: "kilo", model: DS, reasoningEffort: "medium" as const } },
      { model: onOpenResponses, meta: { provider: "openai-compatible", providerName: "provider-1", model: DS, reasoningEffort: "medium" as const } }
    ] }),
    sse: { emit: () => {} }, buildToolScope: SCOPE
  });
  await wakeAndWait(thread.id, "user", ask.id);
  const step = (llm: ReturnType<typeof createMockLLM>) => llm.calls[0]!.options.prompt.find((m: { role: string }) => m.role === "assistant") as { content: unknown[] };
  expect(JSON.stringify(step(onChat).content)).not.toContain('"text":" "');
  expect(step(onOpenResponses).content[0]).toEqual({ type: "reasoning", text: " " });
});

// Each attempt's record is the history it sent: a fallback's own (with the
// placeholder here), not the first candidate's.
test("a wake fallback records the history it sent", async () => {
  const store = new MandateStore(tempDir("md-replay-record-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("project-1 notes");
  agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Looked at the changelog.", writtenBy: { provider: "provider-1", model: "openai/gpt-6.1-sol" } } });
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Go on" } });
  const DS = "deepseek/deepseek-flash";
  const recorder = new AgentLlmCallRecorder({ store, logRequests: "full", provider: "openai-compatible", model: DS, baseURL: "", apiMode: "streamText" });
  const onChat = createMockLLM([{ error: "The operation timed out." }], { provider: "kilo.chat", modelId: DS });
  const onOpenResponses = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }], { provider: "openResponses.responses", modelId: DS });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(), buildSystemPrompt: () => "stub system prompt", toolDispatcherForThread: () => NO_TOOLS,
    llmModel: onChat, llmCallRecorder: recorder,
    llmForThread: () => ({ model: onChat, llmCallRecorder: recorder, candidates: [
      { model: onChat, llmCallRecorder: recorder, meta: { provider: "kilo", providerName: "kilo", model: DS, reasoningEffort: "medium" as const } },
      { model: onOpenResponses, llmCallRecorder: recorder, meta: { provider: "openai-compatible", providerName: "provider-1", model: DS, reasoningEffort: "medium" as const } }
    ] }),
    sse: { emit: () => {} }, buildToolScope: SCOPE
  });
  await wakeAndWait(thread.id, "user", ask.id);
  const recorded = (store.db.prepare("select request_json from llm_calls where purpose = 'agent_wake_step' order by rowid").all() as Array<{ request_json: string }>)
    .map((row) => row.request_json.includes('"text":" "'));
  expect(recorded).toEqual([false, true]);
});

// A step stored before the change keeps its reasoning item under the openai
// key; replayed to the same model on the Open Responses package it goes with
// that item's id and encrypted content, as it went before.
test("an older step's reasoning item reaches the Open Responses package with its id", async () => {
  const store = new MandateStore(tempDir("md-replay-old-key-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("project-1 notes");
  const DS = "deepseek/deepseek-flash";
  agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  agentStore.appendMessage({
    threadId: thread.id, role: "assistant", source: "self",
    content: {
      type: "assistant", text: "Looked at the changelog.", writtenBy: { provider: "provider-1", model: DS },
      sdkAssistantMessages: [{ role: "assistant", content: [
        { type: "reasoning", text: "", providerOptions: { openai: { itemId: "rs_old", reasoningEncryptedContent: "enc-old" } } },
        { type: "text", text: "Looked at the changelog." }
      ] }]
    }
  });
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Go on" } });
  const model = createMockLLM([{ text: "Here is the draft.", finishReason: "stop" }], { provider: "openResponses.responses", modelId: DS });
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(), buildSystemPrompt: () => "stub system prompt", toolDispatcherForThread: () => NO_TOOLS,
    llmModel: model,
    llmForThread: () => ({ model, candidates: [{ model, meta: { provider: "openai-compatible", providerName: "provider-1", model: DS, reasoningEffort: "medium" as const } }] }),
    sse: { emit: () => {} }, buildToolScope: SCOPE
  });
  await wakeAndWait(thread.id, "user", ask.id);
  const step = model.calls[0]!.options.prompt.find((m: { role: string }) => m.role === "assistant") as { content: Array<{ type: string; providerOptions?: Record<string, unknown> }> };
  expect(step.content[0]!.providerOptions?.openResponses).toEqual({ itemId: "rs_old", reasoningEncryptedContent: "enc-old" });
});
