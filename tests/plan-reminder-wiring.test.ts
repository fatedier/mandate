import { expect, test } from "bun:test";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

test("the runtime's step hook reminds a worker that went quiet on its plan, and only a worker", () => {
  const env = freshStoresEnv("md-plan-reminder-wiring-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects);
    const featureId = seedFeature(env.features, projectId);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const manager = env.agentStore.getOrCreateThread("manager", null);
    for (const thread of [worker, manager]) {
      for (let i = 0; i < 10; i++) {
        env.agentStore.appendMessage({
          threadId: thread.id, role: "assistant", source: "self",
          content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `${thread.id}-${i}`, toolName: "bash", args: {} }] }
        });
      }
    }
    // Ten steps an hour ago: ten steps and ten minutes without the plan.
    env.store.db.prepare("update agent_messages set created_at = ?").run(new Date(Date.now() - 60 * 60_000).toISOString());
    runtime = testAgentRuntime(env);
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const workerWake = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    deps.preStepHook!(worker.id, { wakeId: workerWake.id });
    expect(env.agentStore.getActiveMessages(worker.id).at(-1)?.source).toBe("plan-reminder");
    const managerWake = env.agentStore.createWake({ threadId: manager.id, reason: "user", triggerMessageId: null });
    deps.preStepHook!(manager.id, { wakeId: managerWake.id });
    expect(env.agentStore.getActiveMessages(manager.id).some((m) => m.source === "plan-reminder")).toBe(false);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});
