import { expect, test } from "bun:test";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";

// The hooks that run after a wake used to fail into `.catch(() => {})`. The
// release hook is the one that starts whatever was queued behind the wake — a
// user message, mailbox, task or window-watch wake — so a failure there left
// the agent idle with no trace. A failed hook must still never fail the wake.

const STUB_SCOPE = (): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
const STUB_DISPATCHER = { registry: { tools: {} as any }, async dispatch() { return { result: {} }; } };

async function wakeWithHooks(hooks: {
  wakeFinishedHook?: () => unknown;
  postWakeHook?: () => unknown;
  afterWakeReleasedHook?: () => unknown;
}) {
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
      maxStepsPerWake: 3,
      buildSystemPrompt: () => "system",
      toolDispatcherForThread: () => STUB_DISPATCHER as any,
      llmModel: llm,
      sse: { emit: () => {} },
      buildToolScope: STUB_SCOPE,
      ...(hooks as any)
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
    wakeFinishedHook: () => Promise.reject(new Error("finished boom")),
    postWakeHook: () => Promise.reject(new Error("post boom")),
    afterWakeReleasedHook: () => Promise.reject(new Error("release boom"))
  });
  expect(r.status).toBe("finished");
  expect(r.logged).toContain(`[mandate] agent wake ${r.wakeId} wake-finished hook: finished boom`);
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
