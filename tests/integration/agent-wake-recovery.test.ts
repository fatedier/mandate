import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { initializeAgentSchema } from "../../src/server/modules/agent/schema.js";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import { WakeScheduler } from "../../src/server/modules/agent/wake-loop.js";
import { createMockLLM } from "../helpers/mock-llm.js";
import { freshAgentEnv } from "../helpers/fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const scope of ["manager", "worker"] as const) {
  test(`${scope} recovers a persisted partial tool step after readiness without replaying tools`, async () => {
    const db = new Database(":memory:");
    initializeAgentSchema(db);
    const store = new AgentStore(db);
    const thread = store.getOrCreateThread(scope, scope === "worker" ? "feature" : null);
    const original = store.createWake({ threadId: thread.id, reason: "alarm", triggerMessageId: null });
    store.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: original.id,
      content: { type: "assistant", toolCalls: [{ toolCallId: "command", toolName: "send_command", args: {} }] } });
    store.recoverInterruptedWakes("restart");
    const ready = deferred();
    const finished = deferred();
    const model = createMockLLM([{ text: "The task is already complete." }]);
    let dispatches = 0;
    const events: Array<{ event: string; data: any }> = [];
    const scheduler = new WakeScheduler({
      agentStore: store, lock: new WakeLock(), ready: ready.promise, llmModel: model, maxStepsPerWake: 3,
      buildSystemPrompt: () => "Follow the user instructions.",
      buildToolScope: () => ({ kind: "worker", feature: { workingDir: "/tmp" }, project: { workingDir: "/tmp" } }),
      toolDispatcherForThread: () => ({ registry: { tools: {} }, dispatch: async () => { dispatches++; return { result: "unexpected" }; } }),
      preWakeHook: (threadId, info) => { store.drainMailboxToMessages(threadId, info.wakeId); },
      sse: { emit: (event, data) => { events.push({ event, data }); } },
      wakeFinishedHook: () => { finished.resolve(); }
    });
    try {
      for (const threadId of store.listThreadIdsWithQueuedMailboxMessages()) scheduler.wake(threadId, "user", null);
      const wakeId = store.getRunningWakeForThread(thread.id)!.id;
      expect(model.callsMade).toBe(0);
      expect(scheduler.wake(thread.id, "alarm", null)).toBeNull();
      ready.resolve();
      await finished.promise;
      expect(model.callsMade).toBe(1);
      expect(dispatches).toBe(0);
      const prompt = JSON.stringify(model.streamCalls[0]!.prompt);
      expect(prompt).toContain("may or may not have completed");
      expect(prompt).toContain("latest user instructions");
      expect(prompt).toContain("tool-call");
      expect(prompt).toContain("tool-result");
      expect(events.find((event) => event.event === "agentWakeStarted")?.data).toMatchObject({
        reason: "alarm", metadata: { recovery: { wakeIds: [original.id] } }
      });
      expect(store.getWakeById(wakeId)?.status).toBe("finished");
      expect(store.listThreadIdsWithQueuedMailboxMessages()).toEqual([]);
    } finally { ready.resolve(); db.close(); }
  });
}

test("stopping a wake waiting for startup is durable and never reaches the model", async () => {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const store = new AgentStore(db);
  const thread = store.getOrCreateThread("manager", null);
  const ready = deferred();
  const finished = deferred();
  const model = createMockLLM([{ text: "unexpected" }]);
  const scheduler = new WakeScheduler({
    agentStore: store, lock: new WakeLock(), ready: ready.promise, llmModel: model, maxStepsPerWake: 1,
    buildSystemPrompt: () => "test", buildToolScope: () => ({ kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }),
    toolDispatcherForThread: () => ({ registry: { tools: {} }, dispatch: async () => ({ result: "unexpected" }) }),
    sse: { emit: () => {} }, wakeFinishedHook: () => { finished.resolve(); }
  });
  try {
    const wakeId = scheduler.wake(thread.id, "user", null)!;
    expect(scheduler.cancelWake(wakeId).ok).toBe(true);
    expect(db.prepare("select cancel_requested_at from agent_wakes where id = ?").get(wakeId)).toMatchObject({
      cancel_requested_at: expect.any(String)
    });
    ready.resolve();
    await finished.promise;
    expect(store.getWakeById(wakeId)?.status).toBe("canceled");
    expect(model.callsMade).toBe(0);
    expect(store.recoverInterruptedWakes("restart")).toBe(0);
  } finally { ready.resolve(); db.close(); }
});

test("a new process recovers the prior process's running wake and queued request survives another exit", async () => {
  const env = freshAgentEnv("md-wake-process-recovery-");
  const dbPath = env.store.db.filename;
  const storeUrl = new URL("../../src/server/modules/agent/agent-store.ts", import.meta.url).href;
  const run = async (body: string) => {
    const processHandle = Bun.spawn([process.execPath, "--eval", `
      import { Database } from "bun:sqlite";
      import { AgentStore } from ${JSON.stringify(storeUrl)};
      const db = new Database(${JSON.stringify(dbPath)});
      const store = new AgentStore(db);
      ${body}
      db.close();
    `], { stdout: "pipe", stderr: "pipe" });
    const [code, error] = await Promise.all([processHandle.exited, new Response(processHandle.stderr).text()]);
    expect(error).toBe("");
    expect(code).toBe(0);
  };
  try {
    await run(`const thread = store.getOrCreateThread("worker", "feature");
      store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });`);
    const thread = env.agentStore.getThreadByScope("worker", "feature")!;
    const oldWake = env.agentStore.getRunningWakeForThread(thread.id)!;
    await run('store.recoverInterruptedWakes("restart");');
    expect(env.agentStore.getWakeById(oldWake.id)?.status).toBe("error");
    await run('store.recoverInterruptedWakes("restart again");');
    const wake = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    expect(env.agentStore.drainMailboxToMessages(thread.id, wake.id)).toHaveLength(1);
    expect(wake.metadata?.recovery?.wakeIds).toEqual([oldWake.id]);
  } finally { env.cleanup(); }
});

test("archiving while startup waits cannot repeatedly re-wake the queued recovery", async () => {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const store = new AgentStore(db);
  const thread = store.getOrCreateThread("manager", null);
  store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  store.recoverInterruptedWakes("restart");
  const ready = deferred();
  const released = deferred();
  const model = createMockLLM([{ text: "unexpected" }]);
  let followup: string | null | undefined;
  const scheduler = new WakeScheduler({
    agentStore: store, lock: new WakeLock(), ready: ready.promise, llmModel: model, maxStepsPerWake: 1,
    buildSystemPrompt: () => "test", buildToolScope: () => ({ kind: "manager", managerDir: "/tmp", projectWorkingDirs: [] }),
    toolDispatcherForThread: () => ({ registry: { tools: {} }, dispatch: async () => ({ result: "unexpected" }) }),
    sse: { emit: () => {} },
    afterWakeReleasedHook: (threadId) => {
      followup = scheduler.wake(threadId, "user", null);
      released.resolve();
    }
  });
  try {
    scheduler.wake(thread.id, "user", null);
    store.archiveThread(thread.id);
    ready.resolve();
    await released.promise;
    expect(followup).toBeNull();
    expect(model.callsMade).toBe(0);
    expect(store.getRunningWakeForThread(thread.id)).toBeNull();
    expect(scheduler.wake("missing-thread", "user", null)).toBeNull();
    expect(scheduler.wake(thread.id, "user", null)).toBeNull();
  } finally { ready.resolve(); db.close(); }
});
