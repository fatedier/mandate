import os from "node:os";
import type { AgentScope } from "../../src/server/modules/agent/tool-scope.js";
import { WakeLock } from "../../src/server/modules/agent/wake-lock.js";
import { WakeScheduler, type ToolDispatcher } from "../../src/server/modules/agent/wake-loop.js";

/** A worker whose worker and project are a stub dir: all a wake under test
 *  asks of its scope. */
export const WORKER_SCOPE = (_threadId?: string): AgentScope => ({ kind: "worker", worker: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });

/** A manager whose dir is the machine's temp dir, with no projects. */
export const MANAGER_SCOPE = (_threadId?: string): AgentScope => ({ kind: "manager", managerDir: os.tmpdir(), projectWorkingDirs: [] });

/** Offers no tools; a call it is handed anyway is answered "ok". */
export const NO_TOOLS: ToolDispatcher = { registry: { tools: {} }, dispatch: async () => ({ result: "ok" }) };

type Deps = ConstructorParameters<typeof WakeScheduler>[0];
type Defaulted = "lock" | "buildSystemPrompt" | "toolDispatcherForThread" | "sse" | "buildToolScope";

/** The scheduler's deps, where the five a test rarely cares about may be left
 *  out: a lock of its own, a "stub system prompt", NO_TOOLS, an SSE emitter
 *  that drops what it is given, and WORKER_SCOPE. */
export type TestWakeSchedulerDeps = Omit<Deps, Defaulted> & Partial<Pick<Deps, Defaulted>>;

/** Run the production wake entry point and wait for its completion hook. */
export function createTestWakeScheduler(deps: TestWakeSchedulerDeps) {
  const completions = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  function completion(wakeId: string) {
    let pending = completions.get(wakeId);
    if (!pending) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      pending = { promise, resolve };
      completions.set(wakeId, pending);
    }
    return pending;
  }

  const scheduler = new WakeScheduler({
    ...deps,
    lock: deps.lock ?? new WakeLock(),
    buildSystemPrompt: deps.buildSystemPrompt ?? (() => "stub system prompt"),
    toolDispatcherForThread: deps.toolDispatcherForThread ?? (() => NO_TOOLS),
    sse: deps.sse ?? { emit: () => {} },
    buildToolScope: deps.buildToolScope ?? WORKER_SCOPE,
    // The post-wake hook runs for every wake, just before the lock is
    // released. Resolved in finally: a caller's hook may throw.
    postWakeHook(threadId, info) {
      try {
        return deps.postWakeHook?.(threadId, info);
      } finally {
        completion(info.wakeId).resolve();
      }
    }
  });

  const waitForWake = (wakeId: string) => completion(wakeId).promise;

  async function wakeAndWait(...args: Parameters<WakeScheduler["wake"]>): Promise<string> {
    const wakeId = scheduler.wake(...args);
    if (wakeId === null) throw new Error(`Wake did not start for thread ${args[0]}`);
    // Keep completions so even a synchronous failure or a release-time follow-up
    // can be observed. Await resumes after the synchronous finalizers release the lock.
    await waitForWake(wakeId);
    return wakeId;
  }

  return { scheduler, wakeAndWait, waitForWake };
}
