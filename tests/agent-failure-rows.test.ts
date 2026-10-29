import { expect, test } from "bun:test";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { AgentHistoryStore, GLOBAL_HISTORY_PROJECT } from "../src/server/modules/agent/history-store.js";
import { prepareAiSdkMessages } from "../src/server/modules/agent/wake-message-adapter.js";
import { relayFeatureMessageReply } from "../src/server/runtime/feature-message-relay.js";
import { featureMessageRequestMetadata } from "../src/shared/feature-message.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";
import type { FeatureRow, FeaturesStore } from "../src/server/modules/features/features-store.js";
import { stub } from "./helpers/typed.js";
import { recordingInbox } from "./helpers/upward-inbox.js";

// A failed turn is a row in its thread's log, where it stopped: the page reads
// it like any message. Only people see it.

function fresh() {
  const store = new MandateStore(tempDir("md-failure-rows-"));
  onCleanup(() => store.db.close());
  return { store, agentStore: new AgentStore(store.db) };
}
const STUB_SCOPE = (_t: string): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const DISPATCH: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };

async function runWake(agentStore: AgentStore, turns: Parameters<typeof createMockLLM>[0]) {
  const thread = agentStore.getOrCreateThread("worker", `feat-${Math.random().toString(36).slice(2)}`);
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const events: Array<{ name: string; data: any }> = [];
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(), 
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => DISPATCH,
    llmModel: createMockLLM(turns),
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE
  });
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  return { thread, wakeId, events };
}

test("a wake that fails leaves one failure row after everything it wrote, sent before the wake's end", async () => {
  const { agentStore } = fresh();
  const { thread, wakeId, events } = await runWake(agentStore, [{ error: "primary unavailable" }]);
  const rows = agentStore.getMessages(thread.id);
  const last = rows.at(-1)!;
  expect(last).toMatchObject({ role: "system", source: "wake-failure", wakeId, content: { type: "wake_failure", status: "error", stepCount: expect.any(Number) } });
  expect(typeof (last.content as { message: unknown }).message).toBe("string");
  expect(rows.filter((m) => m.content.type === "wake_failure")).toHaveLength(1);
  const appended = events.findIndex((e) => e.name === "agentMessageAppended" && e.data.message.id === last.id);
  const finished = events.findIndex((e) => e.name === "agentWakeFinished");
  expect(appended).toBeGreaterThanOrEqual(0);
  expect(finished).toBeGreaterThan(appended);
});

test("a wake that finishes leaves no failure row", async () => {
  const { agentStore } = fresh();
  const { thread } = await runWake(agentStore, [{ text: "Done.", finishReason: "stop" }]);
  expect(agentStore.getMessages(thread.id).some((m) => m.content.type === "wake_failure")).toBe(false);
});

test("only people see it: not the model, not compression's window, not search", async () => {
  const { store, agentStore } = fresh();
  const { thread } = await runWake(agentStore, [{ error: "zzquokka unavailable" }]);
  // The fixture holds: the thread has its failure row.
  expect(agentStore.getMessages(thread.id).some((m) => m.content.type === "wake_failure")).toBe(true);
  const active = agentStore.getActiveMessages(thread.id);
  expect(active.some((m) => m.content.type === "wake_failure")).toBe(false);
  const all = agentStore.getMessages(thread.id);
  const forModel = JSON.stringify(prepareAiSdkMessages(all, { includeImages: false }));
  expect(forModel).not.toContain("wake_failure");
  // Search, on a manager thread (a plain scope for the search filters): the
  // same word in a user message is found, in a failure row it is not.
  const manager = agentStore.createManagerThread("m");
  agentStore.appendMessage({ threadId: manager.id, role: "system", source: "wake-failure", wakeId: null, content: { type: "wake_failure", status: "error", message: "zzquokka unavailable", stepCount: 1 } });
  agentStore.appendMessage({ threadId: manager.id, role: "user", source: "user", content: { type: "text", text: "zzquokka mentioned by the user" } });
  const history = new AgentHistoryStore(store.db);
  const found = history.search({ callerThreadId: manager.id, projectId: GLOBAL_HISTORY_PROJECT, query: "zzquokka", includeCurrentLineage: true }) as { results: unknown[] };
  expect(found.results).toHaveLength(1);
  expect(JSON.stringify(found.results)).toContain("mentioned by the user");
});

test("the system prompt lookup never takes a failure row", async () => {
  const { agentStore } = fresh();
  const { thread } = await runWake(agentStore, [{ error: "boom" }]);
  const failure = agentStore.getMessages(thread.id).at(-1)!;
  expect(failure.content.type).toBe("wake_failure");
  agentStore.ensureSystemMessage(thread.id, "a changed system prompt");
  expect(agentStore.getSystemMessage(thread.id)?.source).toBe("self");
  expect(agentStore.getMessages(thread.id).find((m) => m.id === failure.id)?.content).toEqual(failure.content);
});

test("a turn that failed before its prompt was written does not stand in for the prompt next turn", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-promptless");
  let builds = 0;
  const llm = createMockLLM([{ text: "Done.", finishReason: "stop" }]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(), 
    buildSystemPrompt: () => {
      builds += 1;
      if (builds === 1) throw new Error("prompt template unreadable");
      return "the real system prompt";
    },
    toolDispatcherForThread: () => DISPATCH,
    llmModel: llm,
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE
  });
  const first = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  await wakeAndWait(thread.id, "user", first.id);
  const failure = agentStore.getMessages(thread.id).find((m) => m.content.type === "wake_failure")!;
  expect(failure).toBeDefined();
  expect(agentStore.getMessages(thread.id).filter((m) => m.role === "system")).toHaveLength(1);

  const second = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "again" } });
  await wakeAndWait(thread.id, "user", second.id);
  const system = llm.calls[0]!.options.prompt.find((m) => m.role === "system");
  expect(system?.content).toBe("the real system prompt");
  expect(agentStore.getMessages(thread.id).find((m) => m.id === failure.id)?.content).toEqual(failure.content);
});

test("the reply relay does not read a failure row as the worker's reply", async () => {
  const { store, agentStore } = fresh();
  const { thread, wakeId } = await runWake(agentStore, [{ error: "boom" }]);
  expect(agentStore.getMessages(thread.id).some((m) => m.content.type === "wake_failure" && m.wakeId === wakeId)).toBe(true);
  const manager = agentStore.createManagerThread("m");
  // A manager's request delivered to that wake.
  agentStore.enqueueMailboxMessage({ threadId: thread.id, role: "user", source: "feature-message", sourceThreadId: manager.id, content: { type: "text", text: "status?", metadata: featureMessageRequestMetadata() } });
  store.db.prepare("update agent_mailbox set status = 'delivered', wake_id = ? where thread_id = ?").run(wakeId, thread.id);
  const replies = relayFeatureMessageReply(
    { agentStore, featuresStore: stub<FeaturesStore>({ getById: () => stub<FeatureRow>({ name: "w" }) }), inbox: recordingInbox(agentStore).inbox },
    { threadId: thread.id, wakeId, status: "error" }
  );
  expect(replies).toHaveLength(1);
  const text = (replies[0]!.content as { text: string }).text;
  expect(text).toContain("The worker's turn failed:");
  expect(text).not.toContain("wake_failure");
});
