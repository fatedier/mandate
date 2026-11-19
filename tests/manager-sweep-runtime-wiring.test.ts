import { expect, test } from "bun:test";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import type { PostWakeInfo, WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { DEFAULT_MANAGER_SWEEP_MS } from "../src/server/runtime/manager-sweep.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
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
    const workerId = seedWorker(env.workers, projectId, { name: "importer" });
    const owner = env.agentStore.createManagerThread("Importer rewrite");
    env.workers.setOwner(workerId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", workerId);
    new PlanStore(env.store.db).update(workerId, { steps: [{ title: "Port the CSV reader" }] });
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
    expect(armed.slice(before).map((t) => t.ms)).toStrictEqual([DEFAULT_MANAGER_SWEEP_MS]);

    // The worker's next turn finishes the plan, so when the sweep falls due
    // it finds nothing stuck and wakes no one.
    const plans = new PlanStore(env.store.db);
    plans.update(workerId, { steps: [{ id: plans.get(workerId).steps[0]!.id, status: "done", note: "ported" }] });
    const next = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(next.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: next.id, status: "finished" }));
    armed.at(-1)!.cb();
    expect(woken.filter(([, reason]) => reason === "sweep")).toStrictEqual([]);
  } finally {
    runtime?.dispose();
  }
});
