import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createBackgroundJobsStarter, jitteredPollDelayMs } from "../src/server/app/background-jobs.js";
import type { Config } from "../src/server/config.js";
import type { TmuxPoller } from "../src/server/runtime/tmux-poller.js";
import type { MemoryDreamTicker } from "../src/server/modules/memory/dream-runs.js";
import { stub } from "./helpers/typed.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import type { RetentionOutcome, RetentionRequest } from "../src/server/platform/db/retention-away.js";
import { DEFAULT_RUNTIME_CONFIG } from "../src/server/config/runtime-config.js";

/** Runs `start()` against a database that cannot be used without saying so, and counts the
 *  timers it registers. The two facts this yields guard opposite failures -- that the
 *  retention pass never runs on the startup path, and that it is scheduled at all -- so they
 *  are asserted as separate tests below.
 *
 *  The Proxy standing in for the Database needs no fake timers and no seam in `start()`:
 *  `if (db)` tests truthiness, which does not fire the `get` trap, so registration proceeds
 *  normally, while any real retention pass reaches for `db.prepare` and trips it.
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
function startWithTimersCaptured(runtime = DEFAULT_RUNTIME_CONFIG, more: Partial<Parameters<typeof createBackgroundJobsStarter>[0]> = {}): {
  threw: unknown;
  touched: string | null;
  intervalsRegistered: number;
  intervalDelaysMs: unknown[];
  /** What each interval runs, in the order registered. */
  intervalRuns: Array<() => void>;
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

  const config = { pollIntervalMs: 60 * 60 * 1000, runtime } as unknown as Config;
  const poller = { poll: async () => {} } as unknown as TmuxPoller;
  const starter = createBackgroundJobsStarter({ config, poller, db, ...more });

  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const intervals: ReturnType<typeof setInterval>[] = [];
  const intervalDelaysMs: unknown[] = [];
  const intervalRuns: Array<() => void> = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    intervals.push(handle);
    intervalDelaysMs.push(args[1]);
    intervalRuns.push(args[0] as () => void);
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

  return { threw, touched, intervalsRegistered: intervals.length, intervalDelaysMs, intervalRuns };
}

/** A pass with nothing left to do -- the steady state, and so the state every restart after
 *  the first day finds -- is a few hundred ms of synchronous sqlite work, and `start()` is the
 *  startup path. The neighbouring dream job deliberately fires once up front (`tickDream()`
 *  right after its `setInterval`); copying that pattern here is the defect this pins, and a
 *  code-reading only protects against it until the next refactor. */
test("start() does not run a retention pass on the startup path", () => {
  const { threw, touched } = startWithTimersCaptured();
  expect(threw).toBeNull();
  expect(touched).toBeNull();
});

/** Exactly one interval, at the right period. One at all guards the whole `if (db)` block -- the
 *  retention job itself -- which could otherwise be deleted with the suite still green, because
 *  a job that never runs also never touches the database. The period: `retentionEveryMs` sits directly under
 *  `dreamCheckEveryMs` (300,000) in RUNTIME_PACES and is written in the same shape, so an
 *  edit to one that lands on the other -- or a minute-sized value copied down while debugging
 *  -- turns a stall once an hour into a stall once a minute. Nothing else notices: every
 *  other test here passes at any period, and the job logs nothing while it finds nothing. */
test("the retention interval is one hour; the words index merges every ten seconds", () => {
  expect(startWithTimersCaptured().intervalDelaysMs).toStrictEqual([10 * 1000, 60 * 60 * 1000]);
});

// config.json's runtime section sets them, as every other job's pace.
test("the words index merge and retention run at the pace the config gives", () => {
  expect(startWithTimersCaptured({ ...DEFAULT_RUNTIME_CONFIG, historyWordsMergeEveryMs: 1_234, retentionEveryMs: 65_000 }).intervalDelaysMs)
    .toStrictEqual([1_234, 65_000]);
});

// The Activity slices: looked at every thirty seconds, never on the start path.
test("the Activity slices are checked at the pace the config gives, not as the jobs start", () => {
  let checks = 0;
  const activityFill = { check: () => { checks += 1; } };
  const usual = startWithTimersCaptured(DEFAULT_RUNTIME_CONFIG, { activityFill });
  expect(usual.threw).toBeNull();
  expect(checks).toBe(0);
  expect(usual.intervalDelaysMs).toStrictEqual([30 * 1000, 10 * 1000, 60 * 60 * 1000]);
  usual.intervalRuns[0]!();
  usual.intervalRuns[0]!();
  expect(checks).toBe(2);
  expect(startWithTimersCaptured({ ...DEFAULT_RUNTIME_CONFIG, activitySlicesCheckEveryMs: 4_321 }, { activityFill }).intervalDelaysMs[0]).toBe(4_321);
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
      config: { pollIntervalMs: 3_600_000, runtime: DEFAULT_RUNTIME_CONFIG } as Config,
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

test("stop() clears the poll timer, the words index fill, the task records' re-read and every interval", () => {
  const timers = recordTimers();
  try {
    const starter = createBackgroundJobsStarter({
      config: { pollIntervalMs: 60 * 60 * 1000, runtime: DEFAULT_RUNTIME_CONFIG } as unknown as Config,
      poller: { poll: async () => {} } as unknown as TmuxPoller,
      db: {} as Database,
      memoryDreamJob: stub<MemoryDreamTicker>({ tick: async () => ({ skipped: true, reason: "not under test" }) })
    });
    starter.start();
    // The dream check, the words index merge, the retention pass.
    expect(timers.intervals.size).toBe(3);
    expect(timers.timeouts).toHaveLength(3);
    starter.stop();
    expect([...timers.intervals].every((handle) => timers.cleared.has(handle))).toBe(true);
    expect(timers.timeouts.every((handle) => timers.cleared.has(handle))).toBe(true);
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
      config: { pollIntervalMs: 500, runtime: DEFAULT_RUNTIME_CONFIG } as unknown as Config,
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

test("jitteredPollDelayMs spreads background polling around the base interval", () => {
  expect(jitteredPollDelayMs(2000, () => 0.5)).toBe(2000);
  expect(jitteredPollDelayMs(2000, () => 0)).toBe(1760);
  expect(jitteredPollDelayMs(2000, () => 1)).toBe(2240);
  expect(jitteredPollDelayMs(500, () => 0)).toBe(500);
});

// The chat history words index is filled after start-up, in batches, without
// touching the database during start() itself.
test("start() schedules the words index fill, which makes it ready", async () => {
  const { historyEnv } = await import("./helpers/history-env.js");
  const { historyWordsReady } = await import("../src/server/modules/agent/history-words.js");
  const env = historyEnv();
  const config = { pollIntervalMs: 60 * 60 * 1000, runtime: DEFAULT_RUNTIME_CONFIG } as unknown as Config;
  const poller = { poll: async () => {} } as unknown as TmuxPoller;
  const starter = createBackgroundJobsStarter({ config, poller, db: env.store.db });
  try {
    env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "database note" } });
    env.store.db.exec("delete from agent_message_search_words; delete from agent_message_search_word_keys; delete from agent_message_search_words_state");
    starter.start();
    expect(historyWordsReady(env.store.db)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(historyWordsReady(env.store.db)).toBe(true);
  } finally {
    starter.stop();
  }
});

// Workers' task records are read again by word after every start-up (a
// VACUUM may have renumbered them, another ICU split them differently),
// without touching the database during start() itself.
test("start() schedules the task records' words re-read", async () => {
  const { freshStoresEnv, seedWorker, seedProject } = await import("./helpers/fixtures.js");
  const { WorkerRecordStore } = await import("../src/server/modules/plans/record-store.js");
  const env = freshStoresEnv("md-jobs-records-");
  const projectId = seedProject(env.projects);
  const workerId = seedWorker(env.workers, projectId);
  const records = new WorkerRecordStore(env.store.db);
  records.write({ workerId, projectId, content: "数据库备份"});
  // The ICU is the same: the words are read again all the same.
  env.store.db.exec("delete from worker_record_words");
  const config = { pollIntervalMs: 60 * 60 * 1000, runtime: DEFAULT_RUNTIME_CONFIG } as unknown as Config;
  const poller = { poll: async () => {} } as unknown as TmuxPoller;
  const starter = createBackgroundJobsStarter({ config, poller, db: env.store.db });
  try {
    starter.start();
    expect(records.search({ query: "备份", projectIds: [projectId], limit: 5 })).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(records.search({ query: "备份", projectIds: [projectId], limit: 5 }).map((hit) => hit.workerId)).toEqual([workerId]);
  } finally {
    starter.stop();
  }
});

/** The hourly pass scans the chat table: seconds once it is large. It runs on
 *  a thread of its own; one still at work (a slow disk, a backlog) is left to
 *  finish rather than raced by the next tick, and a shutdown ends it. */
test("each hour one retention pass runs off the main thread: never two at once, and stop ends the one at work", async () => {
  const env = freshStoresEnv("md-background-retention-");
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const hourly: Array<() => void> = [];
  const handles: Array<ReturnType<typeof setInterval>> = [];
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    if (ms === 60 * 60 * 1000) hourly.push(fn);
    const handle = realSetInterval(() => {}, 1 << 30);
    handles.push(handle);
    return handle;
  }) as typeof setInterval;
  // Start-up's own one-off steps (the words index) are not this test's.
  globalThis.setTimeout = ((() => realSetTimeout(() => {}, 0)) as unknown) as typeof setTimeout;
  const runs: RetentionRequest[] = [];
  const finishers: Array<(outcome: RetentionOutcome) => void> = [];
  let stops = 0;
  const starter = createBackgroundJobsStarter({
    config: stub<Config>({ pollIntervalMs: 3_600_000, retention: { chatRetentionDays: 90, chatMaxTableBytes: 1, chatToolResultHeadChars: 2000 }, runtime: DEFAULT_RUNTIME_CONFIG }),
    poller: stub<TmuxPoller>({ poll: async () => {} }),
    db: env.store.db,
    runRetention: (request) => {
      runs.push(request);
      return { done: new Promise<RetentionOutcome>((resolve) => { finishers.push(resolve); }), stop: () => { stops += 1; } };
    }
  });
  try {
    starter.start();
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    expect(hourly).toHaveLength(1);
    hourly[0]!();
    hourly[0]!();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ dbPath: env.store.db.filename, ceiling: null, runningPaths: [] });
    // Its reading of the table goes to the next pass.
    const ceiling = { checkedAtMs: 1, bytes: 5_000 };
    finishers[0]!({ work: { runtimeContextIds: [], llmPayloadIds: [], toolResults: [], replayStateIds: [], mailboxIds: [], skipMarkerIds: [] }, toolOutputs: { files: [], folders: [] }, ceiling });
    await Bun.sleep(0);
    hourly[0]!();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.ceiling).toEqual(ceiling);
    starter.stop();
    expect(stops).toBe(1);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    for (const handle of handles) clearInterval(handle);
    starter.stop();
  }
});

test("the database's checkpoints move off the main thread while the jobs run, and come back when they stop", () => {
  const env = freshStoresEnv("md-bg-checkpoints-");
  const handedTo: unknown[] = [];
  let stopped = 0;
  const starter = createBackgroundJobsStarter({
    config: { pollIntervalMs: 3_600_000, runtime: DEFAULT_RUNTIME_CONFIG } as Config,
    poller: { poll: () => Promise.resolve() } as unknown as TmuxPoller,
    db: env.store.db,
    checkpoints: (db) => { handedTo.push(db); return { stop: () => { stopped += 1; } }; }
  });
  starter.start();
  expect(handedTo).toHaveLength(1);
  expect(handedTo[0] === env.store.db).toBe(true);
  starter.stop();
  expect(stopped).toBe(1);
});

test("the memory vectors are warmed once, twenty seconds after start, never on the start path", async () => {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const scheduled: Array<{ fn: () => unknown; ms: number | undefined; handle: ReturnType<typeof setTimeout> }> = [];
  globalThis.setTimeout = ((fn: () => unknown, ms?: number) => {
    const handle = real.setTimeout(() => {}, 3_600_000);
    scheduled.push({ fn, ms, handle });
    return handle;
  }) as unknown as typeof setTimeout;
  let warms = 0;
  try {
    const starter = createBackgroundJobsStarter({
      config: { pollIntervalMs: 60 * 60 * 1000, runtime: DEFAULT_RUNTIME_CONFIG } as unknown as Config,
      poller: { poll: async () => {} } as unknown as TmuxPoller,
      memoryVectors: { warm: async () => { warms++; } }
    });
    starter.start();
    expect(warms).toBe(0);
    const warm = scheduled.filter((timer) => timer.ms === 20_000);
    expect(warm).toHaveLength(1);
    await warm[0]!.fn();
    expect(warms).toBe(1);
    starter.stop();
  } finally {
    Object.assign(globalThis, real);
    for (const timer of scheduled) real.clearTimeout(timer.handle);
  }
});

test("the 60-day rule on learned skills is checked at start and again on every later check", () => {
  let checks = 0;
  const run = startWithTimersCaptured(DEFAULT_RUNTIME_CONFIG, { unusedSkillsRule: { tick: async () => { checks += 1; } } });
  expect(checks).toBe(1);
  const delays = run.intervalDelaysMs;
  const at = delays.indexOf(60_000);
  expect(at).toBeGreaterThanOrEqual(0);
  run.intervalRuns[at]!();
  expect(checks).toBe(2);
});

test("the user's direct chats are checked at start and again every minute", () => {
  let checks = 0;
  const run = startWithTimersCaptured(DEFAULT_RUNTIME_CONFIG, { directChats: { tick: async () => { checks += 1; } } });
  expect(checks).toBe(1);
  const delays = run.intervalDelaysMs;
  const at = delays.indexOf(60_000);
  expect(at).toBeGreaterThanOrEqual(0);
  run.intervalRuns[at]!();
  expect(checks).toBe(2);
});
