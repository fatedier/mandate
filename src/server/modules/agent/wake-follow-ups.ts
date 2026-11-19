import { logError } from "../../platform/logger.js";

/** A release follow-up that failed is tried again after each of these (about
 *  two minutes in all), unless the thread is held again meanwhile. */
const RELEASE_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 16000, 30000, 60000];

/** The scheduler's deps the follow-ups use. Read at each use, not kept: the
 *  scheduler hands over its own deps object, which a test may change after
 *  the scheduler is built. */
export interface ReleaseFollowUpDeps {
  afterWakeReleasedHook?: (threadId: string) => void | Promise<void>;
  releaseRetryDelaysMs?: readonly number[];
  onFollowUpAbandoned?: (threadId: string) => void;
}

/** What starts behind a released thread (afterWakeReleasedHook), and the
 *  retries of one that failed. */
export class ReleaseFollowUps {
  /** Each thread's one waiting retry of a failed release follow-up, with the try it is. */
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();
  private disposed = false;

  constructor(
    private readonly deps: ReleaseFollowUpDeps,
    /** True while something holds the thread (the scheduler's lock). */
    private readonly isBusy: (threadId: string) => boolean
  ) {}

  /** Starts what queued behind a released thread (afterWakeReleasedHook). One
   *  that fails (a write the database refused: agents write it too) is tried
   *  again (RELEASE_RETRY_DELAYS_MS), while nothing holds the thread: once
   *  something does, its own release runs the follow-up. `who` names it in
   *  the log. */
  run(threadId: string, who: string, attempt = 0): void {
    const hook = this.deps.afterWakeReleasedHook;
    if (!hook) return;
    // One retry waits per thread: a release meanwhile runs it now, its backoff kept.
    const pending = this.retries.get(threadId);
    if (pending) {
      clearTimeout(pending.timer);
      this.retries.delete(threadId);
      attempt = Math.max(attempt, pending.attempt);
    }
    const retry = (err: unknown) => this.retryLater(threadId, who, attempt, err);
    try {
      Promise.resolve(hook(threadId)).catch(retry);
    } catch (err) {
      retry(err);
    }
  }

  /** The retries waiting are dropped, and none is asked for after. */
  dispose(): void {
    this.disposed = true;
    for (const pending of this.retries.values()) clearTimeout(pending.timer);
    this.retries.clear();
  }

  /** A failure outside a release: the thread's follow-up is tried again, as
   *  a refused release's is. */
  retry(threadId: string, who: string, err: unknown): void {
    if (!this.deps.afterWakeReleasedHook) return;
    this.retryLater(threadId, who, 0, err);
  }

  /** A retry of the thread's follow-up waits. */
  isDue(threadId: string): boolean {
    return this.retries.has(threadId);
  }

  private retryLater(threadId: string, who: string, attempt: number, err: unknown): void {
    logError(`${who} queued follow-up wake`, err);
    // Done with (the server stopping): nothing more is asked for.
    if (this.disposed) return;
    const delays = this.deps.releaseRetryDelaysMs ?? RELEASE_RETRY_DELAYS_MS;
    // Another follow-up of the thread already waits: that one tries again.
    if (this.retries.has(threadId)) return;
    if (attempt >= delays.length) {
      // Out of tries: what queued waits for the thread's next wake, as before.
      try {
        this.deps.onFollowUpAbandoned?.(threadId);
      } catch (abandonErr) {
        logError(`${who} follow-up given up`, abandonErr);
      }
      return;
    }
    const timer = setTimeout(() => {
      this.retries.delete(threadId);
      if (this.isBusy(threadId)) return;
      this.run(threadId, `agent thread ${threadId}`, attempt + 1);
    }, delays[attempt]);
    // A retry keeps no process alive.
    timer.unref?.();
    this.retries.set(threadId, { timer, attempt });
  }
}
