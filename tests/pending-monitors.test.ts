import { expect, test } from "bun:test";
import { WindowWatchManager } from "../src/server/modules/agent/window-watch-manager.js";
import { CommandMonitorManager, type MonitorRunResult } from "../src/server/modules/agent/command-monitor-manager.js";
import { createPendingMonitorFeed } from "../src/server/modules/agent/pending-monitors.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import type { AgentPendingMonitorDto } from "../src/shared/api/agents.js";
import type { StoredWatch } from "../src/server/modules/agent/window-watch-manager.js";
import type { CommandMonitorRecord } from "../src/server/modules/agent/command-monitor-manager.js";
import type { BackgroundTaskDto } from "../src/shared/api/background-tasks.js";
import { freshStoresEnv } from "./helpers/fixtures.js";

// What a thread's agent is still waiting on: a pane watch or a
// command monitor from registration until it fires, times out or is
// cancelled. The chat shows it as a waiting line; the managers say when the
// set changes, and the feed sends the thread's current set.

const MIN = 60_000;
const quietSince = () => new Date(Date.now() - 60 * MIN).toISOString();

interface Delivery {
  /** Whether the thread is mid-turn: a fired monitor then waits for it. */
  busy?: () => boolean;
  /** The threads woken, in order. */
  wakes?: string[];
}

/** Each change as the feed would see it: the thread's live watch ids, read
 *  from the manager itself when it says the set changed. */
function paneWatches(env: ReturnType<typeof freshStoresEnv>, changes: string[][], told: string[], delivery: Delivery = {}) {
  const start = Date.now();
  let now = start;
  const manager: WindowWatchManager = new WindowWatchManager({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: { emit: () => {} } as unknown as AgentSseEmitter,
    onWake: (threadId) => { delivery.wakes?.push(threadId); return "wake-1"; },
    isThreadBusy: () => delivery.busy?.() ?? false,
    getPaneState: () => ({ status: "ok", changedAt: quietSince() }),
    capturePaneTail: async () => "",
    now: () => now,
    // An update keeps the id: its parameters say whether it was told after.
    onPendingChanged: (threadId) => {
      told.push(threadId);
      changes.push(manager.list(threadId).map((watch) => `${watch.id}:${watch.stableMs}:${watch.timeoutAtMs - start}`));
    }
  });
  return { manager, advance: (ms: number) => { now += ms; } };
}

test("a pane watch says the thread's waiting changed when it is registered, changed, fired or cancelled, and not for the same request again", async () => {
  const env = freshStoresEnv("md-pending-pane-");
  const changes: string[][] = [];
  const told: string[] = [];
  const { manager, advance } = paneWatches(env, changes, told);
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const watch = (paneId: string, stableMs = 45_000) =>
      manager.register({ ownerThreadId: thread.id, windowKey: "md-project-1:pr_48", paneId, stableMs, timeoutMs: 30 * MIN, note: "read the review" });
    // Each watch as told: id, quiet window, and its deadline from the start.
    const first = watch("%103").watchId;
    expect(changes).toStrictEqual([[`${first}:45000:${30 * MIN}`]]);
    watch("%103");
    expect(changes).toHaveLength(1);
    // A second later with a longer quiet window: the deadline moves with it.
    advance(1000);
    watch("%103", 60_000);
    expect(changes).toStrictEqual([[`${first}:45000:${30 * MIN}`], [`${first}:60000:${30 * MIN + 1000}`]]);
    advance(60_000);
    await (manager as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(changes.at(-1)).toEqual([]);
    expect(changes).toHaveLength(3);

    const second = watch("%104").watchId;
    manager.cancel(second, thread.id);
    expect(changes.slice(3)).toEqual([[`${second}:45000:${30 * MIN + 61_000}`], []]);
    const third = watch("%105").watchId;
    manager.cancelThread(thread.id);
    expect(changes.slice(5)).toEqual([[`${third}:45000:${30 * MIN + 61_000}`], []]);
    // Nothing left to cancel: nothing changed.
    manager.cancelThread(thread.id);
    expect(changes).toHaveLength(7);
    // Every one named the thread whose set it was: an empty set alone
    // would not show a wrong one.
    expect(told).toStrictEqual(Array(7).fill(thread.id));
  } finally {
    manager.dispose();
    env.cleanup();
  }
});

/** As the feed would see it: the pending ids and labels when told. The
 *  command's output is the test's. */
function commandMonitors(env: ReturnType<typeof freshStoresEnv>, changes: string[][], told: string[], delivery: Delivery = {}) {
  const clock = { now: Date.parse("2026-10-08T12:00:00.000Z") };
  const run = { output: "pending\n" };
  const manager: CommandMonitorManager = new CommandMonitorManager({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: { emit: () => {} } as unknown as AgentSseEmitter,
    onWake: (threadId) => { delivery.wakes?.push(threadId); return "wake-1"; },
    isThreadBusy: () => delivery.busy?.() ?? false,
    runner: { run: async (): Promise<MonitorRunResult> => ({ stdout: run.output, stderr: "", exitCode: 0, timedOut: false }) },
    clock: { now: () => clock.now, sleep: async (ms) => { clock.now += ms; }, setInterval: () => 0, clearInterval: () => {} },
    onPendingChanged: (threadId) => {
      told.push(threadId);
      changes.push(manager.list(threadId).map((monitor) => `${monitor.id}:${monitor.description ?? ""}:${monitor.everyMs}`));
    }
  });
  return { manager, clock, run };
}

test("a command monitor says the thread's waiting changed when it is registered, relabelled, fired or cancelled, and not for the same request again", async () => {
  const env = freshStoresEnv("md-pending-cmd-");
  const changes: string[][] = [];
  const told: string[] = [];
  const { manager, clock, run } = commandMonitors(env, changes, told);
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const monitor = (command: string, description: string | null = null) => manager.register({
      ownerThreadId: thread.id, command, cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "changed",
      timeoutMs: 60 * MIN, note: "report the CI result", description
    });
    const first = (await monitor("gh pr checks 48") as { monitorId: string }).monitorId;
    expect(changes).toStrictEqual([[`${first}::300000`]]);
    await monitor("gh pr checks 48");
    expect(changes).toHaveLength(1);
    await monitor("gh pr checks 48", "project-1 CI on PR 48");
    expect(changes.at(-1)).toEqual([`${first}:project-1 CI on PR 48:300000`]);
    run.output = "passed\n";
    clock.now += 5 * MIN;
    await manager.runDue();
    expect(changes.at(-1)).toEqual([]);
    expect(changes).toHaveLength(3);

    // Registered again with another interval: the same monitor, changed.
    run.output = "pending\n";
    const again = (await monitor("gh pr checks 48") as { monitorId: string }).monitorId;
    await manager.register({
      ownerThreadId: thread.id, command: "gh pr checks 48", cwd: "/tmp", everyMs: 10 * MIN, wakeWhen: "changed",
      timeoutMs: 60 * MIN, note: "report the CI result"
    });
    expect(changes.slice(3)).toEqual([[`${again}::300000`], [`${again}::600000`]]);
    // Asked to wait for success that already holds: it waits on nothing now.
    await manager.register({
      ownerThreadId: thread.id, command: "gh pr checks 48", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "succeeds",
      timeoutMs: 60 * MIN, note: "report the CI result"
    });
    expect(changes.at(-1)).toEqual([]);
    expect(changes).toHaveLength(6);

    const second = (await monitor("gh run list") as { monitorId: string }).monitorId;
    manager.cancel(second, thread.id);
    expect(changes.slice(6)).toEqual([[`${second}::300000`], []]);
    const third = (await monitor("gh run view") as { monitorId: string }).monitorId;
    manager.cancelThread(thread.id);
    expect(changes.slice(8)).toEqual([[`${third}::300000`], []]);
    manager.cancelThread(thread.id);
    expect(changes).toHaveLength(10);
    expect(told).toStrictEqual(Array(10).fill(thread.id));
  } finally {
    manager.dispose();
    env.cleanup();
  }
});

// A monitor that fires while its thread is mid-turn is no longer waited on
// then: its wake waits for the turn to end, and says nothing more when it is
// delivered.
test("a pane watch or a command monitor that fires while its thread is busy says so when it fires, not when its wake is delivered", async () => {
  const env = freshStoresEnv("md-pending-busy-");
  const changes: string[][] = [];
  const told: string[] = [];
  const wakes: string[] = [];
  let busy = true;
  const panes = paneWatches(env, changes, told, { busy: () => busy, wakes });
  const commands = commandMonitors(env, changes, told, { busy: () => busy, wakes });
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    panes.manager.register({ ownerThreadId: thread.id, windowKey: "md-project-1:pr_48", paneId: "%103", stableMs: 45_000, timeoutMs: 30 * MIN, note: "read the review" });
    await commands.manager.register({
      ownerThreadId: thread.id, command: "gh pr checks 48", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "changed",
      timeoutMs: 60 * MIN, note: "report the CI result"
    });
    expect(changes).toHaveLength(2);

    panes.advance(60_000);
    await (panes.manager as unknown as { checkAll(): Promise<void> }).checkAll();
    expect(changes.slice(2)).toEqual([[]]);
    commands.run.output = "passed\n";
    commands.clock.now += 5 * MIN;
    await commands.manager.runDue();
    expect(changes.slice(3)).toEqual([[]]);
    expect(wakes).toEqual([]);

    busy = false;
    await panes.manager.flushPendingWake(thread.id);
    await commands.manager.flushPendingWake(thread.id);
    expect(wakes).toEqual([thread.id, thread.id]);
    expect(changes).toHaveLength(4);
    expect(told).toStrictEqual(Array(4).fill(thread.id));
  } finally {
    panes.manager.dispose();
    commands.manager.dispose();
    env.cleanup();
  }
});

// A restart changes nothing the thread waits on: stopping the managers and
// starting them again over the same rows says nothing, and the monitors are
// there, live, after.
test("a live pane watch and command monitor are kept across a restart without a change being told", async () => {
  const env = freshStoresEnv("md-pending-restart-");
  const changes: string[][] = [];
  const told: string[] = [];
  let panes = paneWatches(env, changes, told);
  let commands = commandMonitors(env, changes, told);
  try {
    const thread = env.agentStore.getOrCreateThread("manager", null);
    const watchId = panes.manager.register({ ownerThreadId: thread.id, windowKey: "md-project-1:pr_48", paneId: "%103", stableMs: 45_000, timeoutMs: 30 * MIN, note: "read the review" }).watchId;
    const monitorId = (await commands.manager.register({
      ownerThreadId: thread.id, command: "gh pr checks 48", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "changed",
      timeoutMs: 60 * MIN, note: "report the CI result"
    }) as { monitorId: string }).monitorId;
    expect(changes).toHaveLength(2);

    panes.manager.dispose();
    commands.manager.dispose();
    panes = paneWatches(env, changes, told);
    commands = commandMonitors(env, changes, told);
    expect(changes).toHaveLength(2);
    expect(panes.manager.list(thread.id).map((watch) => watch.id)).toEqual([watchId]);
    expect(commands.manager.list(thread.id).map((monitor) => monitor.id)).toEqual([monitorId]);

    // Live: ending the thread's waits is told, as before the restart.
    panes.manager.cancelThread(thread.id);
    commands.manager.cancelThread(thread.id);
    expect(changes.slice(2)).toEqual([[], []]);
    expect(told).toStrictEqual(Array(4).fill(thread.id));
  } finally {
    panes.manager.dispose();
    commands.manager.dispose();
    env.cleanup();
  }
});

test("the feed lists a thread's pane watches and command monitors in the order they were registered, and sends that list when it changes", () => {
  const emitted: Array<{ event: string; data: unknown }> = [];
  let clock = Date.parse("2026-10-08T12:52:00.000Z");
  let watches: StoredWatch[] = [];
  let commands: CommandMonitorRecord[] = [];
  const feed = createPendingMonitorFeed({
    sse: { emit: (event: string, data: unknown) => { emitted.push({ event, data }); } } as unknown as AgentSseEmitter,
    listWatches: (threadId) => (threadId === "thr_1" ? watches : []),
    listCommands: (threadId) => (threadId === "thr_1" ? commands : []),
    listTasks: () => [],
    threadIds: () => ["thr_1"],
    threadScope: (threadId) => (threadId === "thr_1" ? { scope: "worker", scopeId: "feat_1" } : null),
    now: () => clock
  });
  watches = [{
      id: "ww_1", targetKey: "k", ownerThreadId: "thr_1", windowKey: "md-project-1:pr_48", paneId: "%103", paneName: "Codex PR48", stableMs: 45_000,
      note: "read the review", createdAtMs: Date.parse("2026-10-08T12:51:00.000Z"), timeoutMs: 30 * MIN,
      timeoutAtMs: Date.parse("2026-10-08T13:21:00.000Z"), timeoutTimer: setTimeout(() => {}, 0)
  }];
  commands = [{
      id: "mon_1", threadId: "thr_1", command: "gh pr checks 48", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "succeeds",
      note: "report the CI result", timeoutMs: 60 * MIN, createdAt: "2026-10-08T12:40:00.000Z", timeoutAt: "2026-10-08T13:40:00.000Z",
      nextRunAt: "2026-10-08T12:50:00.000Z", lastRunAt: "2026-10-08T12:45:00.000Z", consecutiveFailures: 0, firedResult: null, description: "project-1 CI on PR 48",
      runCount: 7,
      recentRuns: [{ at: "2026-10-08T12:45:00.000Z", exitCode: 1, timedOut: false, changed: false, line: "2 checks pending" }]
  }];
  const expected: AgentPendingMonitorDto[] = [
    // With its runs, for the chat's card.
    { kind: "command", id: "mon_1", command: "gh pr checks 48", description: "project-1 CI on PR 48", everyMs: 5 * MIN, wakeWhen: "succeeds", timeoutAt: "2026-10-08T13:40:00.000Z", note: "report the CI result", createdAt: "2026-10-08T12:40:00.000Z",
      runCount: 7, lastRunAt: "2026-10-08T12:45:00.000Z", nextRunAt: "2026-10-08T12:50:00.000Z",
      recentRuns: [{ at: "2026-10-08T12:45:00.000Z", exitCode: 1, timedOut: false, changed: false, line: "2 checks pending" }] },
    // The pane's name at registration, for a chat that has not loaded the call
    // that named it; and for both, when the wait began.
    { kind: "pane", id: "ww_1", windowKey: "md-project-1:pr_48", paneId: "%103", paneName: "Codex PR48", stableMs: 45_000, timeoutAt: "2026-10-08T13:21:00.000Z", note: "read the review", createdAt: "2026-10-08T12:51:00.000Z" }
  ];
  // A revision is the server's boot and a count of changes since: a later
  // boot is newer whatever its count, so a restart never reads as older.
  const boot = Date.parse("2026-10-08T12:52:00.000Z");
  expect(feed.snapshot("thr_1")).toEqual({ monitors: expected, revision: { boot, seq: 0 } });
  feed.changed("thr_1");
  feed.changed("thr_1");
  const revisions = emitted.map((e) => (e.data as { revision: unknown }).revision);
  expect(revisions).toStrictEqual([{ boot, seq: 1 }, { boot, seq: 2 }]);
  // Whose thread it is rides along: a page that never read the thread
  // still knows which worker waits.
  expect(emitted[0]).toEqual({ event: SSE_EVENTS.agentMonitorsChanged, data: { threadId: "thr_1", scope: "worker", scopeId: "feat_1", monitors: expected, revision: { boot, seq: 1 } } });
  // A read gives the count as of now; reading changes nothing.
  expect(feed.snapshot("thr_1").revision).toEqual({ boot, seq: 2 });
  expect(feed.snapshot("thr_1").revision).toEqual({ boot, seq: 2 });
  // Its clock moving does not touch the count.
  clock = Date.parse("2026-10-08T13:00:00.000Z");
  // Each change sends the set as it now is: the command fired, then the
  // watch: down to none, in the event and in a read alike.
  commands = [];
  feed.changed("thr_1");
  expect(emitted.at(-1)!.data).toEqual({ threadId: "thr_1", scope: "worker", scopeId: "feat_1", monitors: [expected[1]], revision: { boot, seq: 3 } });
  watches = [];
  feed.changed("thr_1");
  expect(emitted.at(-1)!.data).toEqual({ threadId: "thr_1", scope: "worker", scopeId: "feat_1", monitors: [], revision: { boot, seq: 4 } });
  expect(feed.snapshot("thr_1")).toEqual({ monitors: [], revision: { boot, seq: 4 } });
});

// Every thread that waits, for the sidebar: Threads draws a
// thread whose agents all sleep on a monitor as watching, so a page needs
// every thread's set at boot, not only the threads it opened. One revision
// covers them all: the count is the feed's, so an event after the list is
// newer than it for any thread.
test("the feed lists every thread that waits, with whose thread it is, as of one revision", () => {
  const emitted: unknown[] = [];
  const at = Date.parse("2026-10-09T08:00:00.000Z");
  const watch = (id: string, ownerThreadId: string): StoredWatch => ({
    id, targetKey: id, ownerThreadId, windowKey: "md-project-1:dispatcher", paneId: "%112", paneName: "Codex build", stableMs: 30_000,
    note: "review the diff", createdAtMs: at, timeoutMs: 30 * MIN, timeoutAtMs: at + 30 * MIN, timeoutTimer: setTimeout(() => {}, 0)
  });
  const command: CommandMonitorRecord = {
    id: "mon_ci", threadId: "thr_mgr", command: "gh pr checks 56", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "succeeds",
    note: "merge when green", timeoutMs: 60 * MIN, createdAt: "2026-10-09T08:00:00.000Z", timeoutAt: "2026-10-09T09:00:00.000Z",
    nextRunAt: "2026-10-09T08:05:00.000Z", lastRunAt: null, consecutiveFailures: 0, firedResult: null, description: "project-1 CI", runCount: 0, recentRuns: []
  };
  let watches = [watch("ww_dev", "thr_worker")];
  const feed = createPendingMonitorFeed({
    sse: { emit: (_event: string, data: unknown) => { emitted.push(data); } } as unknown as AgentSseEmitter,
    listWatches: (threadId) => watches.filter((w) => w.ownerThreadId === threadId),
    listCommands: (threadId) => (threadId === "thr_mgr" ? [command] : []),
    listTasks: () => [],
    // A thread named twice, and one whose waits all ended, list once / not at all.
    threadIds: () => ["thr_worker", "thr_mgr", "thr_worker", "thr_done"],
    threadScope: (threadId) => (
      threadId === "thr_worker" ? { scope: "worker", scopeId: "feat_dispatcher" }
        : threadId === "thr_mgr" ? { scope: "manager", scopeId: null }
          : null
    ),
    now: () => at
  });
  const ids = () => feed.all().threads.map((t) => [t.threadId, t.scope, t.scopeId, t.monitors.map((m) => m.id)]);
  expect(feed.all().revision).toEqual({ boot: at, seq: 0 });
  expect(ids()).toEqual([
    ["thr_mgr", "manager", null, ["mon_ci"]],
    ["thr_worker", "worker", "feat_dispatcher", ["ww_dev"]]
  ]);
  watches = [];
  feed.changed("thr_worker");
  expect(feed.all().revision).toEqual({ boot: at, seq: 1 });
  expect(ids()).toEqual([["thr_mgr", "manager", null, ["mon_ci"]]]);
  // A thread the store no longer has still lists, by id alone.
  expect(emitted).toStrictEqual([{ threadId: "thr_worker", scope: "worker", scopeId: "feat_dispatcher", monitors: [], revision: { boot: at, seq: 1 } }]);
});

// A subagent the thread started wakes it with its result: one more thing it
// waits on while queued or running, in the order asked for; one that ended
// is not.
test("the feed lists a thread's queued and running subagents among its waits, and not one that ended", () => {
  const at = Date.parse("2026-10-18T09:00:00.000Z");
  const task = (id: string, status: BackgroundTaskDto["status"], createdAt: string): BackgroundTaskDto => ({
    id, kind: "subagent", parentThreadId: "thr_mgr", childThreadId: `thr_child_${id}`, type: "general", title: `project-1 job ${id}`,
    status, stoppedBy: null, error: null, createdAt, startedAt: status === "queued" ? null : createdAt, finishedAt: null, seq: 1, exitCode: null, command: null, outputPath: null
  });
  let tasks = [
    task("task_1", "running", "2026-10-18T08:40:00.000Z"),
    task("task_2", "finished", "2026-10-18T08:41:00.000Z"),
    task("task_3", "queued", "2026-10-18T08:50:00.000Z")
  ];
  const command: CommandMonitorRecord = {
    id: "mon_ci", threadId: "thr_mgr", command: "gh pr checks 56", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "succeeds",
    note: "merge when green", timeoutMs: 60 * MIN, createdAt: "2026-10-18T08:45:00.000Z", timeoutAt: "2026-10-18T09:45:00.000Z",
    nextRunAt: "2026-10-18T08:50:00.000Z", lastRunAt: null, consecutiveFailures: 0, firedResult: null, description: "project-1 CI", runCount: 0, recentRuns: []
  };
  const feed = createPendingMonitorFeed({
    sse: { emit: () => {} } as unknown as AgentSseEmitter,
    listWatches: () => [],
    listCommands: (threadId) => (threadId === "thr_mgr" ? [command] : []),
    listTasks: (threadId) => (threadId === "thr_mgr" ? tasks : []),
    threadIds: () => ["thr_mgr"],
    threadScope: () => ({ scope: "manager", scopeId: null }),
    now: () => at
  });
  const monitors = feed.snapshot("thr_mgr").monitors;
  expect(monitors.map((m) => [m.kind, m.id])).toEqual([["subagent", "task_1"], ["command", "mon_ci"], ["subagent", "task_3"]]);
  expect(monitors[0]).toEqual({ kind: "subagent", id: "task_1", title: "project-1 job task_1", status: "running", createdAt: "2026-10-18T08:40:00.000Z" });
  expect(monitors[2]).toMatchObject({ kind: "subagent", status: "queued" });
  expect(feed.all().threads.map((t) => [t.threadId, t.monitors.length])).toEqual([["thr_mgr", 3]]);
  tasks = tasks.map((t) => ({ ...t, status: "finished" as const }));
  expect(feed.snapshot("thr_mgr").monitors.map((m) => m.id)).toEqual(["mon_ci"]);
});

// A command bash runs in the background wakes the thread when it ends: a wait
// too, of its own kind, not the command monitor's.
test("the feed lists a thread's running background command as a background-command wait", () => {
  const command: BackgroundTaskDto = {
    id: "task_e2e", kind: "command", parentThreadId: "thr_mgr", childThreadId: null, type: "general", title: "Run the e2e suite",
    status: "running", stoppedBy: null, error: null, createdAt: "2026-10-19T08:40:00.000Z", startedAt: "2026-10-19T08:40:00.000Z",
    finishedAt: null, seq: 1, exitCode: null, command: "make e2e", outputPath: "/tmp/task_e2e.log"
  };
  const feed = createPendingMonitorFeed({
    sse: { emit: () => {} } as unknown as AgentSseEmitter,
    listWatches: () => [],
    listCommands: () => [],
    listTasks: (threadId) => (threadId === "thr_mgr" ? [command] : []),
    threadIds: () => ["thr_mgr"],
    threadScope: () => ({ scope: "manager", scopeId: null }),
    now: () => Date.parse("2026-10-19T09:00:00.000Z")
  });
  expect(feed.snapshot("thr_mgr").monitors).toEqual([
    { kind: "background-command", id: "task_e2e", title: "Run the e2e suite", status: "running", createdAt: "2026-10-19T08:40:00.000Z" }
  ]);
});

test("a pending alarm is something the thread waits on: its time, its note and when it was set", () => {
  const sent: unknown[] = [];
  const alarms = [{ id: "alm_1", threadId: "thr_1", fireAt: "2026-05-15T10:30:00.000Z", note: "check the deploy", status: "pending" as const, createdAt: "2026-05-15T10:00:00.000Z", firedAt: null }];
  const feed = createPendingMonitorFeed({
    sse: { emit: (_event: string, data: unknown) => { sent.push(data); } } as unknown as AgentSseEmitter,
    listWatches: () => [],
    listCommands: () => [],
    listTasks: () => [],
    listAlarms: (threadId) => alarms.filter((a) => a.threadId === threadId),
    threadIds: () => ["thr_1"],
    threadScope: () => ({ scope: "worker", scopeId: "feat_1" })
  });
  expect(feed.snapshot("thr_1").monitors).toEqual([{ kind: "alarm", id: "alm_1", fireAt: "2026-05-15T10:30:00.000Z", note: "check the deploy", createdAt: "2026-05-15T10:00:00.000Z" }]);
  expect(feed.all().threads.map((t) => [t.threadId, t.monitors.length])).toEqual([["thr_1", 1]]);
});

// The record's lastRunAt includes the probes registering ran; the card's
// "last" is its newest check.
test("a command monitor's last run, for the chat, is its newest scheduled check, never a registration probe", () => {
  const record = {
    id: "mon_9", threadId: "thr_9", command: "gh pr checks 9", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "succeeds" as const,
    note: "n", timeoutMs: 60 * MIN, createdAt: "2026-10-08T12:40:00.000Z", timeoutAt: "2026-10-08T13:40:00.000Z",
    nextRunAt: "2026-10-08T12:45:00.000Z", lastRunAt: "2026-10-08T12:40:00.000Z", consecutiveFailures: 0, firedResult: null, description: null,
    runCount: 0, recentRuns: []
  };
  const feed = createPendingMonitorFeed({
    sse: { emit: () => {} }, listWatches: () => [], listCommands: () => [record], listTasks: () => [],
    threadIds: () => ["thr_9"], threadScope: () => ({ scope: "manager", scopeId: null })
  });
  expect(feed.snapshot("thr_9").monitors[0]).toMatchObject({ runCount: 0, lastRunAt: null });
  const checked = { ...record, runCount: 1, recentRuns: [{ at: "2026-10-08T12:45:00.000Z", exitCode: 1, timedOut: false, changed: false, line: "" }] };
  const feed2 = createPendingMonitorFeed({
    sse: { emit: () => {} }, listWatches: () => [], listCommands: () => [checked], listTasks: () => [],
    threadIds: () => ["thr_9"], threadScope: () => ({ scope: "manager", scopeId: null })
  });
  expect(feed2.snapshot("thr_9").monitors[0]).toMatchObject({ runCount: 1, lastRunAt: "2026-10-08T12:45:00.000Z" });
});
