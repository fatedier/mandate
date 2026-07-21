import { WakeScheduler } from "../../src/server/modules/agent/wake-loop.js";

/** Run the production wake entry point and wait for its completion hook. */
export function createTestWakeScheduler(deps: ConstructorParameters<typeof WakeScheduler>[0]) {
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
    wakeFinishedHook(event) {
      const result = deps.wakeFinishedHook?.(event);
      completion(event.wakeId).resolve();
      return result;
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
