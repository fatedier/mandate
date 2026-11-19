import { expect, test } from "bun:test";
import { Hono } from "hono";
import { mountAgentsRoutes } from "../src/server/modules/agent/agents-api.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import type { ScopeRuntime } from "../src/server/runtime/scope.js";
import { stub } from "./helpers/typed.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { createTestWakeScheduler, MANAGER_SCOPE } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import { testStore } from "./helpers/test-store.js";

// A step reads the thread's models once its pre-call work is done: a model
// switched while a compaction ran is the one the step calls.


test("a model switched while a step's pre-call work runs is the one the step calls", async () => {
  const store = testStore(tempDir("md-thread-model-wake-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("Release notes");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  const before = createMockLLM([{ text: "From the old model.", finishReason: "stop" }], { modelId: "main/gpt-5.5" });
  const after = createMockLLM([{ text: "From the new model.", finishReason: "stop" }], { modelId: "main/gpt-5.5-mini" });
  let current = { llm: before, model: "gpt-5.5" };
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore,
    llmModel: before,
    llmForThread: () => ({
      model: current.llm,
      candidates: [{ model: current.llm, meta: { provider: "openai", providerName: "main", model: current.model } }]
    }),
    // The user switches the thread while its compaction runs.
    beforeModelCallHook: async () => {
      current = { llm: after, model: "gpt-5.5-mini" };
      return { historyChanged: false };
    },
    buildToolScope: MANAGER_SCOPE
  });
  await wakeAndWait(thread.id, "user", ask.id);
  expect([before.calls.length, after.calls.length]).toEqual([0, 1]);
});

test("each model a turn calls is announced as its call starts — a fallback's after the primary failed — and only when it changes", async () => {
  const store = testStore(tempDir("md-thread-model-live-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("Release notes");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Draft the notes" } });
  // A second step on the same model, then a timeout moves on.
  const primary = createMockLLM([
    { toolCalls: [{ toolCallId: "c1", toolName: "read", args: { path: "/notes.md" } }], finishReason: "tool-calls" },
    { error: "The operation timed out." }
  ], { modelId: "anthropic/claude-opus-5-5" });
  const fallback = createMockLLM([{ text: "Drafted.", finishReason: "stop" }], { modelId: "anthropic/claude-opus-5.5" });
  const events: Array<{ event: string; data: unknown }> = [];
  // What a read of the thread would say at each announcement.
  const inFlight: unknown[] = [];
  let read: () => unknown = () => null;
  const { scheduler, wakeAndWait } = createTestWakeScheduler({
    agentStore,
    llmModel: primary,
    llmForThread: () => ({
      model: primary,
      candidates: [
        { model: primary, meta: { provider: "anthropic", providerName: "provider-1", model: "anthropic/claude-opus-5-5" } },
        { model: fallback, meta: { provider: "openai-compatible", providerName: "kilo", model: "anthropic/claude-opus-5.5" } }
      ]
    }),
    sse: { emit: (event, data) => { events.push({ event, data }); if (event === "agentWakeModel") inFlight.push(read()); } },
    buildToolScope: MANAGER_SCOPE
  });
  read = () => scheduler.modelInFlight(thread.id)?.ref ?? null;
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  expect(primary.calls.length).toBe(2);
  expect(inFlight).toStrictEqual(["provider-1/anthropic/claude-opus-5-5", "kilo/anthropic/claude-opus-5.5"]);
  const announced = events.filter((e) => e.event === "agentWakeModel").map((e) => e.data);
  expect(announced).toStrictEqual([
    { threadId: thread.id, wakeId, model: { ref: "provider-1/anthropic/claude-opus-5-5", providerName: "provider-1", model: "anthropic/claude-opus-5-5" } },
    { threadId: thread.id, wakeId, model: { ref: "kilo/anthropic/claude-opus-5.5", providerName: "kilo", model: "anthropic/claude-opus-5.5" } }
  ]);
  // Over: no model in flight.
  expect(scheduler.modelInFlight(thread.id)).toBeNull();
});

test("a thread read mid-turn says which model its turn is on", async () => {
  const store = testStore(tempDir("md-thread-model-read-"));
  onCleanup(() => store.db.close());
  const agentStore = new AgentStore(store.db);
  const thread = agentStore.createManagerThread("Release notes");
  const wake = agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  const model = { ref: "kilo/anthropic/claude-opus-5.5", providerName: "kilo", model: "anthropic/claude-opus-5.5" };
  const hono = new Hono();
  mountAgentsRoutes(hono, {
    agentStore,
    wakeScheduler: { wake: () => "wake-1", modelInFlight: (threadId) => (threadId === thread.id ? model : null) },
    userMessageQueue: new AgentUserMessageQueue({ agentStore, wakeScheduler: { wake: () => "wake-1" } }),
    scopes: { worker: stub<ScopeRuntime>({ verifyScopeId: () => null }) }
  });
  const read = await (await hono.request(`/api/agents/threads/${thread.id}`)).json() as { activeWake?: unknown };
  expect(read.activeWake).toEqual({ wakeId: wake.id, startedAt: wake.startedAt, model });
});
