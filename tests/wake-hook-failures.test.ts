import { expect, spyOn, test } from "bun:test";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { stub } from "./helpers/typed.js";
import { waitUntil } from "./helpers/wait.js";
import type { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";

// The hooks that run after a wake used to fail into `.catch(() => {})`. The
// release hook is the one that starts whatever was queued behind the wake — a
// user message, mailbox, task or window-watch wake — so a failure there left
// the agent idle with no trace. A failed hook must still never fail the wake.

const STUB_SCOPE = (): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const STUB_DISPATCHER = stub<ToolDispatcher>({ registry: stub<ToolRegistry>({ tools: {} }), async dispatch() { return { result: {} }; } });

async function wakeWithHooks(hooks: Pick<
  Parameters<typeof createTestWakeScheduler>[0],
  "postWakeHook" | "afterWakeReleasedHook"
>) {
  const env = freshAgentEnv("md-wake-hooks-");
  const logged: string[] = [];
  const originalError = console.error;
  const oldLevel = process.env.MANDATE_LOG_LEVEL;
  process.env.MANDATE_LOG_LEVEL = "error";
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-hooks");
    const trigger = env.agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: "hi" }
    });
    const llm = createMockLLM([{ text: "done", finishReason: "stop" }]);
    const { wakeAndWait } = createTestWakeScheduler({
      agentStore: env.agentStore,
      lock: new WakeLock(),
      buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      // No retries here: a hook that always fails would keep trying after the test.
      releaseRetryDelaysMs: [],
      ...hooks
    });
    const wakeId = await wakeAndWait(thread.id, "user", trigger.id);
    // The hook rejections are caught in later microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { wakeId, status: env.agentStore.getWakeById(wakeId)?.status, logged };
  } finally {
    console.error = originalError;
    if (oldLevel === undefined) delete process.env.MANDATE_LOG_LEVEL;
    else process.env.MANDATE_LOG_LEVEL = oldLevel;
    env.cleanup();
  }
}

test("a rejected hook after a wake is logged, naming the hook and the wake", async () => {
  const r = await wakeWithHooks({
    postWakeHook: () => Promise.reject(new Error("post boom")),
    afterWakeReleasedHook: () => Promise.reject(new Error("release boom"))
  });
  expect(r.status).toBe("finished");
  expect(r.logged).toContain(`[mandate] agent wake ${r.wakeId} post-wake hook: post boom`);
  expect(r.logged).toContain(`[mandate] agent wake ${r.wakeId} queued follow-up wake: release boom`);
});

test("a post-wake hook that throws synchronously is logged and does not fail the wake", async () => {
  const r = await wakeWithHooks({
    postWakeHook: () => { throw new Error("sync boom"); }
  });
  expect(r.status).toBe("finished");
  expect(r.logged).toContain(`[mandate] agent wake ${r.wakeId} post-wake hook: sync boom`);
});

// The release hook starts what queued behind the wake. A write the database
// refused there (another writer held it: agents write it, and that is
// normal) left the mail waiting for some later wake; it is tried again.
test("a release follow-up the database refused is tried again: the wake for what queued starts", async () => {
  const env = freshAgentEnv("md-wake-release-retry-");
  const originalError = console.error;
  console.error = () => {};
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-release");
    const trigger = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
    const llm = createMockLLM([{ text: "first", finishReason: "stop" }, { text: "second", finishReason: "stop" }]);
    // Refuses the second wake's row once, as a locked database does.
    const createWake = env.agentStore.createWake.bind(env.agentStore);
    let rows = 0;
    env.agentStore.createWake = ((input: Parameters<typeof createWake>[0]) => {
      rows++;
      if (rows === 2) throw new Error("database is locked");
      return createWake(input);
    }) as typeof env.agentStore.createWake;
    let followUps = 0;
    let scheduler!: ReturnType<typeof createTestWakeScheduler>["scheduler"];
    const made = createTestWakeScheduler({
      agentStore: env.agentStore,
      lock: new WakeLock(),
      buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [20],
      // As the runtime's: a worker's report queued while it ran wakes it once it is free.
      afterWakeReleasedHook: async (threadId) => {
        followUps++;
        if (followUps <= 2 && !scheduler.isThreadBusy(threadId)) scheduler.wake(threadId, "worker-report", null);
      }
    });
    scheduler = made.scheduler;
    await made.wakeAndWait(thread.id, "user", trigger.id);
    for (let i = 0; i < 100 && llm.streamCalls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(llm.streamCalls.length).toBe(2);
    expect(rows).toBe(3);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

test("a refused release follow-up is not tried again while the thread is busy: its own release runs it then", async () => {
  const env = freshAgentEnv("md-wake-release-busy-");
  const originalError = console.error;
  console.error = () => {};
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-release-busy");
    const trigger = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
    let followUps = 0;
    let scheduler!: ReturnType<typeof createTestWakeScheduler>["scheduler"];
    let held: (() => void) | null = null;
    const made = createTestWakeScheduler({
      agentStore: env.agentStore,
      lock: new WakeLock(),
      buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER,
      llmModel: createMockLLM([{ text: "done", finishReason: "stop" }]),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [30],
      afterWakeReleasedHook: async (threadId) => {
        followUps++;
        if (followUps === 1) {
          // Refused; and before it is tried again, the thread is held (a compaction by hand).
          held = scheduler.holdThread(threadId);
          throw new Error("database is locked");
        }
      }
    });
    scheduler = made.scheduler;
    await made.wakeAndWait(thread.id, "user", trigger.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(followUps).toBe(1);
    held!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(followUps).toBe(2);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

test("a release follow-up that keeps failing is tried as often as its waits allow, then left as before", async () => {
  const env = freshAgentEnv("md-wake-release-giveup-");
  const originalError = console.error;
  console.error = () => {};
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-release-giveup");
    const trigger = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
    let followUps = 0;
    const made = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([{ text: "done", finishReason: "stop" }]),
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [10, 10],
      afterWakeReleasedHook: async () => { followUps++; throw new Error("database is locked"); }
    });
    await made.wakeAndWait(thread.id, "user", trigger.id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(followUps).toBe(3);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

test("a follow-up after a held thread is let go (a compaction by hand) is tried again when it fails, too", async () => {
  const env = freshAgentEnv("md-wake-release-hold-");
  const originalError = console.error;
  console.error = () => {};
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-release-hold");
    let followUps = 0;
    const made = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([]),
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [10],
      afterWakeReleasedHook: async () => { followUps++; if (followUps === 1) throw new Error("database is locked"); }
    });
    made.scheduler.holdThread(thread.id)!();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(followUps).toBe(2);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

test("a thread released again and again while its follow-up keeps failing has one retry waiting, not one per release", async () => {
  const env = freshAgentEnv("md-wake-release-coalesce-");
  const originalError = console.error;
  console.error = () => {};
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-release-coalesce");
    let followUps = 0;
    const made = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([]),
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [40, 40],
      afterWakeReleasedHook: async () => { followUps++; throw new Error("database is locked"); }
    });
    for (let i = 0; i < 10; i++) {
      made.scheduler.holdThread(thread.id)!();
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(followUps).toBe(10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Ten releases, then the one chain's two retries.
    expect(followUps).toBe(12);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

function holdingScheduler(prefix: string, hook: () => Promise<void>, delays: number[]) {
  const env = freshAgentEnv(prefix);
  const thread = env.agentStore.getOrCreateThread("worker", `feat-${prefix}`);
  const made = createTestWakeScheduler({
    agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
    toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([]),
    sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
    releaseRetryDelaysMs: delays,
    afterWakeReleasedHook: hook
  });
  return { env, release: () => made.scheduler.holdThread(thread.id)!() };
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a release whose follow-up goes through drops the retry that was waiting: it is not run again", async () => {
  const originalError = console.error;
  console.error = () => {};
  let followUps = 0;
  const s = holdingScheduler("md-wake-release-drop-", async () => { followUps++; if (followUps === 1) throw new Error("database is locked"); }, [60]);
  try {
    s.release();
    await pause(5);
    s.release();
    await pause(150);
    expect(followUps).toBe(2);
  } finally {
    console.error = originalError;
    s.env.cleanup();
  }
});

test("two follow-ups that fail late leave one retry waiting, not two", async () => {
  const originalError = console.error;
  console.error = () => {};
  let followUps = 0;
  const s = holdingScheduler("md-wake-release-late-", async () => { followUps++; await pause(20); throw new Error("database is locked"); }, [50]);
  try {
    s.release();
    await pause(2);
    s.release();
    await pause(250);
    // Two releases, then one retry.
    expect(followUps).toBe(3);
  } finally {
    console.error = originalError;
    s.env.cleanup();
  }
});

// A watch or monitor firing on an idle thread, whose delivery the database
// refused: no release comes to start what it left queued. The thread's
// follow-up is tried again as a refused release's is.
test("a delivery refused outside a release has the thread's follow-up tried after the first wait, and on through the waits", async () => {
  const originalError = console.error;
  console.error = () => {};
  let followUps = 0;
  const env = freshAgentEnv("md-wake-retry-outside-");
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-retry-outside");
    const made = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([]),
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [30, 30],
      afterWakeReleasedHook: async () => { followUps++; if (followUps === 1) throw new Error("database is locked"); }
    });
    made.scheduler.retryFollowUp(thread.id, "monitor w1", new Error("database is locked"));
    // Not at once: it was just refused.
    expect(followUps).toBe(0);
    await pause(45);
    expect(followUps).toBe(1);
    await pause(60);
    expect(followUps).toBe(2);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

test("many deliveries refused outside a release leave one retry of the thread's follow-up waiting", async () => {
  const originalError = console.error;
  console.error = () => {};
  let followUps = 0;
  const env = freshAgentEnv("md-wake-retry-outside-one-");
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-retry-outside-one");
    const made = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([]),
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [20],
      afterWakeReleasedHook: async () => { followUps++; }
    });
    for (let i = 0; i < 5; i++) made.scheduler.retryFollowUp(thread.id, `monitor w${i}`, new Error("database is locked"));
    await pause(80);
    expect(followUps).toBe(1);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

// Mail put in an idle thread's mailbox by a sender outside its release (a
// report, a notice, a reply): a wake the database refuses leaves the mail
// there, and the thread's follow-up, which wakes for it, is tried again.
test("a wake for mail the database refuses returns null, and the thread's follow-up is tried after the first wait", async () => {
  const originalError = console.error;
  console.error = () => {};
  let followUps = 0;
  const env = freshAgentEnv("md-wake-for-mail-refused-");
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-mail-refused");
    const made = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([]),
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [20],
      afterWakeReleasedHook: async () => { followUps++; }
    });
    const create = spyOn(env.agentStore, "createWake").mockImplementationOnce(() => { throw new Error("database is locked"); });
    try {
      expect(made.scheduler.wakeForMail(thread.id, "worker-report")).toBe(null);
    } finally {
      create.mockRestore();
    }
    // The lock was let go: the thread is not left busy.
    expect(made.scheduler.isThreadBusy(thread.id)).toBe(false);
    expect(followUps).toBe(0);
    await pause(60);
    expect(followUps).toBe(1);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

test("a wake for mail that goes through returns its wake", async () => {
  const env = freshAgentEnv("md-wake-for-mail-ok-");
  const thread = env.agentStore.getOrCreateThread("worker", "feat-mail-ok");
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  const made = createTestWakeScheduler({
    agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
    toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([{ text: "done", finishReason: "stop" }]),
    sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
    releaseRetryDelaysMs: []
  });
  const wakeId = made.scheduler.wakeForMail(thread.id, "worker-report");
  expect(wakeId).toBe(env.agentStore.getLatestWakeForThread(thread.id)!.id);
  await waitUntil(() => env.agentStore.getWakeById(wakeId!)?.status !== "running");
});

test("a thread has its follow-up due while a retry of it waits, and not once that retry has run", async () => {
  const originalError = console.error;
  console.error = () => {};
  const env = freshAgentEnv("md-wake-follow-up-due-");
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-follow-up-due");
    const made = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([]),
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [20],
      afterWakeReleasedHook: async () => {}
    });
    expect(made.scheduler.hasFollowUpDue(thread.id)).toBe(false);
    made.scheduler.retryFollowUp(thread.id, "monitor w1", new Error("database is locked"));
    expect(made.scheduler.hasFollowUpDue(thread.id)).toBe(true);
    await pause(60);
    expect(made.scheduler.hasFollowUpDue(thread.id)).toBe(false);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

test("a follow-up given up after its last try is reported once; a try that fails with tries left is not", async () => {
  const originalError = console.error;
  console.error = () => {};
  const abandoned: string[] = [];
  const env = freshAgentEnv("md-wake-follow-up-abandoned-");
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-follow-up-abandoned");
    const made = createTestWakeScheduler({
      agentStore: env.agentStore, lock: new WakeLock(), buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER, llmModel: createMockLLM([]),
      sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [30],
      afterWakeReleasedHook: async () => { throw new Error("database is locked"); },
      onFollowUpAbandoned: (threadId) => { abandoned.push(threadId); }
    });
    made.scheduler.holdThread(thread.id)!();
    await pause(10);
    expect(abandoned).toStrictEqual([]);
    await pause(80);
    expect(abandoned).toStrictEqual([thread.id]);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});

// A scheduler left to fire after its server (or its test) is done reads a
// database that is gone.
test("disposed while a refused follow-up waits to be tried again, the scheduler tries it no more and asks for no other", async () => {
  const env = freshAgentEnv("md-wake-release-dispose-");
  const originalError = console.error;
  console.error = () => {};
  try {
    const thread = env.agentStore.getOrCreateThread("worker", "feat-release-dispose");
    let followUps = 0;
    const { scheduler } = createTestWakeScheduler({
      agentStore: env.agentStore,
      lock: new WakeLock(),
      buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER,
      llmModel: createMockLLM([]),
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      releaseRetryDelaysMs: [20],
      afterWakeReleasedHook: async () => { followUps++; }
    });
    scheduler.retryFollowUp(thread.id, "a watch", new Error("database is locked"));
    expect(scheduler.hasFollowUpDue(thread.id)).toBe(true);
    scheduler.dispose();
    expect(scheduler.hasFollowUpDue(thread.id)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(followUps).toBe(0);
    scheduler.retryFollowUp(thread.id, "a watch", new Error("database is locked"));
    expect(scheduler.hasFollowUpDue(thread.id)).toBe(false);
  } finally {
    console.error = originalError;
    env.cleanup();
  }
});
