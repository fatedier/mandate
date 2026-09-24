import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createBackgroundJobsStarter } from "../src/server/app/background-jobs.js";
import type { Config } from "../src/server/config.js";
import type { TmuxPoller } from "../src/server/runtime/tmux-poller.js";

/** Runs `start()` against a database that cannot be used without saying so, and counts the
 *  timers it registers. The two facts this yields guard opposite failures -- that the
 *  retention pass never runs on the startup path, and that it is scheduled at all -- so they
 *  are asserted as separate tests below.
 *
 *  The Proxy standing in for the Database needs no fake timers and no seam in `start()`:
 *  `if (db)` tests truthiness, which does not fire the `get` trap, so registration proceeds
 *  normally, while any real `runRetentionPass(db)` reaches for `db.prepare` and trips it.
 *
 *  It records the property as well as throwing. Throwing alone is defeated by the likeliest
 *  shape of the regression -- an immediate call wrapped in the same try/catch as the interval
 *  body, which is what someone mirroring `tickDream`'s error handling would write. That
 *  swallows the error and would leave the test green with the startup cost restored. The
 *  recorded name survives it.
 *
 *  `config` and `poller` are cast past their types because this test makes no claims about
 *  them; `start()` reads only `pollIntervalMs` and calls `poll()`. `memoryDreamJob` is
 *  omitted, and that is what makes the interval count unambiguous: with the dream branch out,
 *  retention is the only `setInterval` caller on this path. The poll timer is a `setTimeout`,
 *  so it never enters the count.
 *
 *  Both kinds of handle are released before returning -- an uncleared one-hour timer would
 *  outlive the test and hold the process open. */
function startWithTimersCaptured(): {
  threw: unknown;
  touched: string | null;
  intervalsRegistered: number;
  intervalDelaysMs: unknown[];
} {
  let touched: string | null = null;
  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        touched ??= String(prop);
        throw new Error(`retention touched the database during start(): db.${String(prop)}`);
      }
    }
  ) as unknown as Database;

  const config = { pollIntervalMs: 60 * 60 * 1000 } as unknown as Config;
  const poller = { poll: async () => {} } as unknown as TmuxPoller;
  const starter = createBackgroundJobsStarter({ config, poller, db });

  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const intervals: ReturnType<typeof setInterval>[] = [];
  const intervalDelaysMs: unknown[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    intervals.push(handle);
    intervalDelaysMs.push(args[1]);
    return handle;
  }) as typeof setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    timeouts.push(handle);
    return handle;
  }) as typeof setTimeout;

  let threw: unknown = null;
  try {
    starter.start();
  } catch (e) {
    threw = e;
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    for (const handle of intervals) clearInterval(handle);
    for (const handle of timeouts) clearTimeout(handle);
  }

  return { threw, touched, intervalsRegistered: intervals.length, intervalDelaysMs };
}

/** A pass with nothing left to do -- the steady state, and so the state every restart after
 *  the first day finds -- is 200-280 ms of synchronous sqlite work, and `start()` is the
 *  startup path. The neighbouring dream job deliberately fires once up front (`tickDream()`
 *  right after its `setInterval`); copying that pattern here is the defect this pins, and a
 *  code-reading only protects against it until the next refactor. */
test("start() does not run a retention pass on the startup path", () => {
  const { threw, touched } = startWithTimersCaptured();
  expect(threw).toBeNull();
  expect(touched).toBeNull();
});

/** The complement, and the one that guards more: without it the whole `if (db)` block -- the
 *  point of this branch -- could be deleted with the suite still green, because a job that
 *  never runs also never touches the database. */
test("start() registers the retention interval", () => {
  expect(startWithTimersCaptured().intervalsRegistered).toBe(1);
});

/** The period, not just the registration. `RETENTION_INTERVAL_MS` sits directly under
 *  `MEMORY_DREAM_CHECK_INTERVAL_MS = 5 * 60 * 1000` and is written in the same shape, so an
 *  edit to one that lands on the other -- or a minute-sized value copied down while debugging
 *  -- turns a ~250 ms stall an hour into a ~250 ms stall a minute. Nothing else notices: every
 *  other test here passes at any period, and the job logs nothing while it finds nothing. */
test("the retention interval is one hour", () => {
  expect(startWithTimersCaptured().intervalDelaysMs).toEqual([60 * 60 * 1000]);
});

test("initial readiness follows the first completed poll and only fires once", async () => {
  let finishPoll!: () => void;
  const firstPoll = new Promise<void>((resolve) => { finishPoll = resolve; });
  let readyCalls = 0;
  let pollCalls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    timer = realSetTimeout(...args);
    return timer;
  }) as typeof setTimeout;
  try {
    const starter = createBackgroundJobsStarter({
      config: { pollIntervalMs: 3_600_000 } as Config,
      poller: { poll: () => { pollCalls++; return firstPoll; } } as unknown as TmuxPoller,
      onInitialPollComplete: () => { readyCalls++; }
    });
    starter.start();
    starter.start();
    expect(readyCalls).toBe(0);
    expect(pollCalls).toBe(1);
    finishPoll();
    await firstPoll;
    expect(readyCalls).toBe(1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    if (timer) clearTimeout(timer);
  }
});

/** Swaps the four timer globals for recording wrappers until `restore()`. */
function recordTimers() {
  const real = {
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
    clearInterval: globalThis.clearInterval,
    clearTimeout: globalThis.clearTimeout
  };
  const intervals = new Set<unknown>();
  const timeouts: unknown[] = [];
  const cleared = new Set<unknown>();
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = real.setInterval(...args);
    intervals.add(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = real.setTimeout(...args);
    timeouts.push(handle);
    return handle;
  }) as typeof setTimeout;
  globalThis.clearInterval = ((handle: Parameters<typeof clearInterval>[0]) => {
    cleared.add(handle);
    real.clearInterval(handle);
  }) as typeof clearInterval;
  globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
    cleared.add(handle);
    real.clearTimeout(handle);
  }) as typeof clearTimeout;
  return {
    real,
    intervals,
    timeouts,
    cleared,
    restore() {
      Object.assign(globalThis, real);
      for (const handle of intervals) real.clearInterval(handle as ReturnType<typeof setInterval>);
      for (const handle of timeouts) real.clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  };
}

test("stop() clears the poll timer and both intervals", () => {
  const timers = recordTimers();
  try {
    const starter = createBackgroundJobsStarter({
      config: { pollIntervalMs: 60 * 60 * 1000 } as unknown as Config,
      poller: { poll: async () => {} } as unknown as TmuxPoller,
      db: {} as Database,
      memoryDreamJob: { tick: async () => {} } as never
    });
    starter.start();
    expect(timers.intervals.size).toBe(2);
    expect(timers.timeouts).toHaveLength(1);
    starter.stop();
    expect([...timers.intervals].every((handle) => timers.cleared.has(handle))).toBe(true);
    expect(timers.cleared.has(timers.timeouts[0])).toBe(true);
  } finally {
    timers.restore();
  }
});

test("a scheduled poll still running when stop() is called does not schedule another", async () => {
  // Uses the real 500 ms minimum interval (plus up to 12% jitter): the path
  // under test is the scheduled poll's own finally, which only a fired poll
  // timer reaches.
  const timers = recordTimers();
  try {
    let finishPoll!: () => void;
    const inFlight = new Promise<void>((resolve) => { finishPoll = resolve; });
    let scheduledPollStarted!: () => void;
    const started = new Promise<void>((resolve) => { scheduledPollStarted = resolve; });
    let polls = 0;
    const poller = {
      poll: () => {
        polls += 1;
        if (polls === 1) return Promise.resolve(); // start()'s own first poll
        scheduledPollStarted();
        return inFlight;
      }
    } as unknown as TmuxPoller;
    const starter = createBackgroundJobsStarter({
      config: { pollIntervalMs: 500 } as unknown as Config,
      poller
    });
    starter.start();
    await started;
    starter.stop();
    const timeoutsAtStop = timers.timeouts.length;
    finishPoll();
    await inFlight;
    await new Promise((resolve) => timers.real.setTimeout(resolve, 0));
    expect(timers.timeouts.length).toBe(timeoutsAtStop);
  } finally {
    timers.restore();
  }
});
