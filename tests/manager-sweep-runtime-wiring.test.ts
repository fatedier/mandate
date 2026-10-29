import { expect, test } from "bun:test";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import type { PostWakeInfo, WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS } from "../src/server/runtime/manager-work-item-heartbeat.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// A worker's turn that ends with steps left and nothing set to wake it writes
// no work item: the runtime still sets its manager's sweep going, and the
// sweep, finding the worker stuck, wakes the manager.
test("a worker's turn that leaves it stuck tells its manager at once, and the sweep keeps its interval", async () => {
  const env = freshStoresEnv("md-sweep-runtime-wiring-");
  const armed: Array<{ ms: number; cb: () => void }> = [];
  const timers = {
    setTimeout: (cb: () => void, ms: number) => { const t = { ms, cb, unref() {} }; armed.push(t); return t; },
    clearTimeout: () => {}
  };
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "importer" });
    const owner = env.agentStore.createManagerThread("Importer rewrite");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    new PlanStore(env.store.db).update(featureId, { steps: [{ title: "Port the CSV reader" }] });
    runtime = testAgentRuntime(env, { managerSweep: { timers: timers as never } });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return `wk_${woken.length}`;
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;

    const before = armed.length;
    const turn = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(turn.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: turn.id, status: "finished" }));
    // Stuck the moment the turn ended: its manager is told now, and the
    // sweep is not made due beside it: the manager is woken once.
    expect(woken).toStrictEqual([[owner.id, "worker-report"]]);
    expect(armed.slice(before).map((t) => t.ms)).toStrictEqual([DEFAULT_MANAGER_WORK_ITEM_HEARTBEAT_MS]);

    // The worker's next turn finishes the plan, so when the sweep falls due
    // it finds nothing stuck and wakes no one.
    const plans = new PlanStore(env.store.db);
    plans.update(featureId, { steps: [{ id: plans.get(featureId).steps[0]!.id, status: "done", note: "ported" }] });
    const next = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(next.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: next.id, status: "finished" }));
    armed.at(-1)!.cb();
    expect(woken.filter(([, reason]) => reason === "work-item-heartbeat")).toStrictEqual([]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});
