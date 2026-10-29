import { expect, test } from "bun:test";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { WindowWatchManager } from "../src/server/modules/agent/window-watch-manager.js";
import { AgentAlarmManager } from "../src/server/modules/agent/agent-alarm-manager.js";
import { CommandMonitorManager } from "../src/server/modules/agent/command-monitor-manager.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import { freshStoresEnv, NOOP_WAKE, seedFeature, seedProject } from "./helpers/fixtures.js";
import { buildAgentsTestApp, buildTestScopes, getJson } from "./helpers/test-app.js";
import { stub, toolContext } from "./helpers/typed.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { SUBAGENT_LIMITS } from "../src/shared/api/background-tasks.js";
import { waitUntil } from "./helpers/wait.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import type { TmuxSnapshot } from "../src/server/platform/tmux/tmux-types.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

const MIN = 60_000;

// The runtime, not a test's own callbacks: what a thread waits on reaches its
// page through the managers the runtime builds, the feed it wires them to,
// and the read it hands the HTTP service.
test("the runtime tells each change to a thread's waiting, with a revision its reads share, and reads carry the set", async () => {
  const env = freshStoresEnv("md-pending-runtime-wiring-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const thread = env.agentStore.createManagerThread("PR 48 review");
    // Waits left by the previous process: a watch, then a monitor.
    const quiet = { emit: () => {} } as unknown as AgentSseEmitter;
    const panes = new WindowWatchManager({
      db: env.store.db, agentStore: env.agentStore, sse: quiet, onWake: () => null, isThreadBusy: () => false,
      getPaneState: () => ({ status: "ok", changedAt: new Date().toISOString() }), capturePaneTail: async () => ""
    });
    const commands = new CommandMonitorManager({
      db: env.store.db, agentStore: env.agentStore, sse: quiet, onWake: () => null, isThreadBusy: () => false,
      runner: { run: async () => ({ stdout: "pending\n", stderr: "", exitCode: 0, timedOut: false }) },
      // Registration's second probe waits a gap first: not here.
      clock: { now: () => Date.now(), sleep: async () => {}, setInterval: () => 0, clearInterval: () => {} }
    });
    const watchId = panes.register({ ownerThreadId: thread.id, windowKey: "md-project-1:pr_48", paneId: "%103", stableMs: 45_000, timeoutMs: 30 * MIN, note: "read the review" }).watchId;
    const monitorId = (await commands.register({
      ownerThreadId: thread.id, command: "gh pr checks 48", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "changed",
      timeoutMs: 60 * MIN, note: "report the CI result"
    }) as { monitorId: string }).monitorId;
    // A worker's thread that waits on a pane alone and a thread that waits on
    // a command alone: each manager's list of waiting threads, and whose
    // thread each is, has to reach the page.
    const devThread = env.agentStore.getOrCreateThread("worker", "feat_dispatcher");
    const devWatchId = panes.register({ ownerThreadId: devThread.id, windowKey: "md-project-1:dispatcher", paneId: "%112", stableMs: 30_000, timeoutMs: 30 * MIN, note: "review the diff" }).watchId;
    const ciThread = env.agentStore.createManagerThread("project-1 CI");
    const ciMonitorId = (await commands.register({
      ownerThreadId: ciThread.id, command: "gh pr checks 56", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "changed",
      timeoutMs: 60 * MIN, note: "report when the checks move"
    }) as { monitorId: string }).monitorId;
    panes.dispose();
    commands.dispose();

    const events: Array<{ threadId: string; scope: string | null; monitors: Array<{ id: string }>; revision: { boot: number; seq: number } }> = [];
    runtime = testAgentRuntime(env, {
      sse: stub<AgentSseEmitter>({
        addSink: () => () => {},
        emit: (event: string, data: unknown) => { if (event === SSE_EVENTS.agentMonitorsChanged) events.push(data as typeof events[number]); }
      })
    });
    const app = buildAgentsTestApp({
      agentStore: env.agentStore, wakeScheduler: NOOP_WAKE, scopes: buildTestScopes(env.features),
      pendingMonitors: runtime.pendingMonitors, allPendingMonitors: runtime.allPendingMonitors
    });
    // Every waiting thread, for the sidebar.
    const readAll = async () => {
      const { status, body } = await getJson(app, "/api/agents/pending-monitors");
      expect(status).toBe(200);
      const threads = body.threads as Array<{ threadId: string; scope: string; scopeId: string | null; monitors: Array<{ id: string }> }>;
      return { threads: threads.map((t) => [t.threadId, t.scope, t.scopeId, t.monitors.map((m) => m.id)]), revision: body.revision };
    };
    // The list's order is the server's: by thread id, code unit by code unit.
    const byThread = <T extends unknown[]>(rows: T[]) => [...rows].sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
    const read = async () => {
      const { body } = await getJson(app, `/api/agents/threads/${thread.id}`);
      return { ids: (body.monitors as Array<{ id: string }>).map((m) => m.id), revision: body.monitorsRevision };
    };

    // Starting over the stored waits changes nothing.
    expect(events).toStrictEqual([]);
    const boot = runtime.pendingMonitors(thread.id).revision.boot;
    expect(await read()).toEqual({ ids: [watchId, monitorId], revision: { boot, seq: 0 } });
    expect(await readAll()).toEqual({
      threads: byThread([
        [thread.id, "manager", null, [watchId, monitorId]],
        [devThread.id, "worker", "feat_dispatcher", [devWatchId]],
        [ciThread.id, "manager", null, [ciMonitorId]]
      ]),
      revision: { boot, seq: 0 }
    });

    // Archiving the thread ends both: each manager tells it, and the read
    // after has the last change's revision.
    runtime.releaseThreadResources(thread.id);
    expect(events.map((e) => [e.threadId, e.scope, e.monitors.map((m) => m.id), e.revision])).toStrictEqual([
      [thread.id, "manager", [monitorId], { boot, seq: 1 }],
      [thread.id, "manager", [], { boot, seq: 2 }]
    ]);
    expect(await read()).toEqual({ ids: [], revision: { boot, seq: 2 } });
    expect(await readAll()).toEqual({
      threads: byThread([
        [devThread.id, "worker", "feat_dispatcher", [devWatchId]],
        [ciThread.id, "manager", null, [ciMonitorId]]
      ]),
      revision: { boot, seq: 2 }
    });
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// A subagent the conversation started will wake it with its result: while one
// is queued or running the conversation has not stopped. One source says so,
// the pending-monitor feed, so its page, the sidebar's list and what the
// global agent is told all agree.
test("a conversation waits on its subagents while they are queued or running: its page, the sidebar's list and the global agent's waiting_on_you follow", async () => {
  const env = freshStoresEnv("md-pending-runtime-subagents-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const events: Array<{ threadId: string; monitors: Array<{ kind: string; id: string }> }> = [];
    // Not ready until let go: until then no wake runs; let go, a cancelled
    // one ends at once (its end step records the stop).
    let letGo!: () => void;
    const ready = new Promise<void>((resolve) => { letGo = resolve; });
    runtime = testAgentRuntime(env, {
      ready,
      sse: stub<AgentSseEmitter>({
        addSink: () => () => {},
        emit: (event: string, data: unknown) => { if (event === SSE_EVENTS.agentMonitorsChanged) events.push(data as typeof events[number]); }
      })
    });
    const thread = env.agentStore.createManagerThread("project-1 release");
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "Release notes", tmuxWindowName: "release-notes", ownerThreadId: thread.id });
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    // A question in its plan nobody above it took up: the user's once nothing
    // in its thread runs or will wake by itself.
    new PlanStore(env.store.db).update(featureId, { openQuestions: ["Ship 0.72 today?"] });
    const waitingTool = runtime.scopes.global.toolDefinitions.find((tool) => tool.name === "waiting_on_you")!;
    const waitingWorkers = async () => {
      const result = await waitingTool.handler({}, toolContext({ threadId: env.agentStore.getOrCreateGlobalThread().id })) as { items: Array<{ kind: string; featureId?: string }> };
      return result.items.filter((item) => item.kind === "worker").map((item) => item.featureId);
    };
    expect(await waitingWorkers()).toStrictEqual([featureId]);

    const started = Array.from({ length: SUBAGENT_LIMITS.perThread + 1 }, (_, i) =>
      runtime!.subagents.start({ parentThreadId: worker.id, title: `project-1 job ${i + 1}`, task: `Do job ${i + 1}.` }));
    // Tasks asked for in one millisecond have no order of their own: compared by id.
    const asked = Object.fromEntries(started.map((s, i) => [s.task.id, i < SUBAGENT_LIMITS.perThread ? "running" : "queued"]));
    const statusById = (monitors: ReadonlyArray<{ kind: string; id: string; status?: string }>) =>
      Object.fromEntries(monitors.map((m) => [m.id, m.kind === "subagent" ? m.status : m.kind]));
    // Its page.
    expect(statusById(runtime.pendingMonitors(worker.id).monitors)).toEqual(asked);
    // The sidebar's list, with whose thread it is; and the last change told carries the whole set.
    expect(runtime.allPendingMonitors().threads.map((t) => [t.threadId, t.scope, t.scopeId, statusById(t.monitors)])).toEqual([[worker.id, "worker", featureId, asked]]);
    expect(statusById(events.filter((e) => e.threadId === worker.id).at(-1)!.monitors)).toEqual(asked);
    // It will wake by itself: its question is not yet the user's.
    expect(await waitingWorkers()).toStrictEqual([]);

    for (const s of started) runtime.subagents.stop(s.task.id, "agent", worker.id);
    // The queued one ended at once; the running ones end with their wakes.
    letGo();
    const live = runtime;
    await waitUntil(() => live.pendingMonitors(worker.id).monitors.length === 0, { label: "the stopped subagents to end" });
    expect(runtime.pendingMonitors(worker.id).monitors).toEqual([]);
    expect(events.filter((e) => e.threadId === worker.id).at(-1)!.monitors).toEqual([]);
    expect(runtime.allPendingMonitors().threads).toEqual([]);
    expect(await waitingWorkers()).toStrictEqual([featureId]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// The runtime, not a test's own callbacks: a monitor left fired before a
// restart, and a pane watch firing on an idle thread, whose first wake the
// database refuses, are woken by the scheduler's retry of the thread's
// follow-up — no release of those idle threads comes to do it.
test("the runtime retries a refused delivery outside a release: a monitor found fired at start and a watch firing on an idle thread are woken", async () => {
  const env = freshStoresEnv("md-refused-outside-release-wiring-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const originalError = console.error;
  console.error = () => {};
  try {
    const monitorThread = env.agentStore.createManagerThread("CI");
    const watchThread = env.agentStore.createManagerThread("Deploy");
    const quiet = { emit: () => {} } as unknown as AgentSseEmitter;
    let now = Date.now();
    let out = "1";
    // Fired while its thread was busy, then the server stopped.
    const commands = new CommandMonitorManager({
      db: env.store.db, agentStore: env.agentStore, sse: quiet, onWake: () => null, isThreadBusy: () => true,
      runner: { run: async () => ({ stdout: out, stderr: "", exitCode: 0, timedOut: false }) },
      clock: { now: () => now, sleep: async () => {}, setInterval: () => 0, clearInterval: () => {} }
    });
    await commands.register({
      ownerThreadId: monitorThread.id, command: "true", cwd: "/tmp", everyMs: 5 * MIN, wakeWhen: "changed",
      timeoutMs: 60 * MIN, note: "report the CI result"
    });
    out = "2";
    now += 5 * MIN;
    await commands.runDue();
    commands.dispose();
    // A watch on a pane the next process will not find: it fires at its first tick.
    const panes = new WindowWatchManager({
      db: env.store.db, agentStore: env.agentStore, sse: quiet, onWake: () => null, isThreadBusy: () => false,
      getPaneState: () => ({ status: "ok", changedAt: new Date().toISOString() }), capturePaneTail: async () => ""
    });
    panes.register({ ownerThreadId: watchThread.id, windowKey: "md-project-1:deploy", paneId: "%7", stableMs: 45_000, timeoutMs: 30 * MIN });
    panes.dispose();

    runtime = testAgentRuntime(env, {
      getSnapshot: () => stub<TmuxSnapshot>({ sessions: [] })
    });
    // Each source's first wake is refused; the next is recorded, not run.
    const refused = new Set<string>();
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      if (!refused.has(reason)) {
        refused.add(reason);
        throw new Error("database is locked");
      }
      woken.push([threadId, reason]);
      return `wk_${reason}`;
    };
    await waitUntil(() => woken.length === 2, { timeout: 8000, label: () => `woken ${JSON.stringify(woken)}` });
    expect(new Map(woken)).toEqual(new Map([[monitorThread.id, "monitor"], [watchThread.id, "watch"]]));
    expect(env.agentStore.getMessages(monitorThread.id).filter((m) => m.source === "monitor")).toHaveLength(1);
    expect(env.agentStore.getMessages(watchThread.id).filter((m) => m.source === "watch")).toHaveLength(1);
  } finally {
    console.error = originalError;
    runtime?.dispose();
    env.cleanup();
  }
}, 15_000);

// An alarm the agent set (schedule_wake) wakes it by itself, as a monitor
// does: its page and the sidebar's list show it. It keeps the thread open
// for the global agent only while the worker is still at work (a plan step in
// progress) and asks nothing: one that asked leaves the next move to the user.
test("a pending alarm is waited on: its page and the sidebar's list follow, it holds a still-working worker's thread open, and an archive tells its end", async () => {
  const env = freshStoresEnv("md-pending-runtime-alarms-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const thread = env.agentStore.createManagerThread("project-1 release");
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "Release notes", tmuxWindowName: "release-notes", ownerThreadId: thread.id });
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    new PlanStore(env.store.db).update(featureId, { openQuestions: ["Ship 0.72 today?"] });
    // An alarm set before a restart.
    const earlier = new AgentAlarmManager({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as unknown as AgentSseEmitter, onWake: () => null });
    const alarm = earlier.schedule({ threadId: worker.id, when: "2h", note: "check the release build" });
    earlier.dispose();

    const events: Array<{ threadId: string; monitors: Array<{ kind: string; id: string }> }> = [];
    runtime = testAgentRuntime(env, {
      sse: stub<AgentSseEmitter>({
        addSink: () => () => {},
        emit: (event: string, data: unknown) => { if (event === SSE_EVENTS.agentMonitorsChanged) events.push(data as typeof events[number]); }
      })
    });
    expect(runtime.pendingMonitors(worker.id).monitors).toEqual([{ kind: "alarm", id: alarm.id, fireAt: alarm.fireAt, note: "check the release build", createdAt: alarm.createdAt }]);
    expect(runtime.allPendingMonitors().threads.map((t) => [t.threadId, t.scope, t.scopeId, t.monitors.map((m) => m.kind)])).toEqual([[worker.id, "worker", featureId, ["alarm"]]]);
    // Its alarm is no wait for a worker that asked: the question is the user's.
    const globalCtx = toolContext({ threadId: env.agentStore.getOrCreateGlobalThread().id });
    const waitingTool = runtime.scopes.global.toolDefinitions.find((tool) => tool.name === "waiting_on_you")!;
    const waitingWorkers = async () => {
      const result = await waitingTool.handler({}, globalCtx) as { items: Array<{ kind: string; featureId?: string }> };
      return result.items.filter((item) => item.kind === "worker").map((item) => item.featureId);
    };
    expect(await waitingWorkers()).toStrictEqual([featureId]);
    // Still at work and asking nothing, its alarm brings it back: the global
    // agent that waits on it is not told it stopped.
    new PlanStore(env.store.db).update(featureId, { openQuestions: [], steps: [{ title: "Check the release build", status: "in_progress" }] });
    const awaitTool = runtime.scopes.global.toolDefinitions.find((tool) => tool.name === "await_stop")!;
    expect(await awaitTool.handler({ featureId }, globalCtx)).toMatchObject({ waiting: true });
    // Its thread released (archived), the alarm goes, and the page is told.
    runtime.releaseThreadResources(worker.id);
    expect(events.filter((e) => e.threadId === worker.id).at(-1)!.monitors).toEqual([]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

/** A clock 1 s behind for the manager that sets an alarm: its "1s" alarm is
 *  already due when the runtime takes it up, so no test waits a real second. */
const secondBehind = { now: () => Date.now() - 1000, setTimeout: () => 0, clearTimeout: () => {} };

// A fired alarm whose wake is still to be tried again (the runtime not ready,
// or the database refused it) wakes the thread by itself as soon as it can:
// the thread has not stopped meanwhile.
test("a fired alarm whose wake is still to come keeps its thread from reading stopped", async () => {
  const env = freshStoresEnv("md-pending-runtime-alarm-due-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const thread = env.agentStore.createManagerThread("project-1 release");
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "Release notes", tmuxWindowName: "release-notes", ownerThreadId: thread.id });
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    new PlanStore(env.store.db).update(featureId, { steps: [{ title: "Check the release build", status: "in_progress" }] });
    const earlier = new AgentAlarmManager({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as unknown as AgentSseEmitter, onWake: () => null, timers: secondBehind });
    earlier.schedule({ threadId: worker.id, when: "1s", note: "check the release build" });
    earlier.dispose();
    // Every wake refused, as by a database another writer holds.
    env.agentStore.createWake = () => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); };
    runtime = testAgentRuntime(env, {
      ready: Promise.resolve()
    });
    const awaitTool = runtime.scopes.global.toolDefinitions.find((tool) => tool.name === "await_stop")!;
    await waitUntil(() => env.agentStore.queuedMailboxSources(worker.id).includes("alarm"), { timeout: 5_000, interval: 20, label: "the alarm to fire" });
    // Still waited on, for the page and the sidebar too, until its wake starts.
    expect(runtime.pendingMonitors(worker.id).monitors.map((m) => m.kind)).toEqual(["alarm"]);
    expect(runtime.allPendingMonitors().threads.map((t) => t.threadId)).toEqual([worker.id]);
    expect(await awaitTool.handler({ featureId }, toolContext({ threadId: env.agentStore.getOrCreateGlobalThread().id }))).toMatchObject({ waiting: true });
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// A worker whose work is done kept a reminder alarm
// hours ahead: its thread had to read stopped for the global agent then, not
// when the reminder fired.
test("a worker that finished its plan, with a reminder alarm, leaves its thread stopped for the global agent", async () => {
  const env = freshStoresEnv("md-pending-runtime-alarm-reminder-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const thread = env.agentStore.createManagerThread("project-1 release");
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "Release notes", tmuxWindowName: "release-notes", ownerThreadId: thread.id });
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const plans = new PlanStore(env.store.db);
    plans.update(featureId, { steps: [{ title: "Rebase the release branch", status: "in_progress" }] });
    expect(plans.update(featureId, { steps: [{ id: 1, status: "done", note: "Rebased; CI green" }] }).ok).toBe(true);
    const earlier = new AgentAlarmManager({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as unknown as AgentSseEmitter, onWake: () => null });
    earlier.schedule({ threadId: worker.id, when: "6h", note: "if the merge notice has not come, remind myself" });
    earlier.dispose();
    runtime = testAgentRuntime(env);
    expect(runtime.pendingMonitors(worker.id).monitors.map((m) => m.kind)).toEqual(["alarm"]);
    const awaitTool = runtime.scopes.global.toolDefinitions.find((tool) => tool.name === "await_stop")!;
    expect(await awaitTool.handler({ threadId: thread.id }, toolContext({ threadId: env.agentStore.getOrCreateGlobalThread().id }))).toMatchObject({ waiting: false, stopped: "stopped" });
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// An alarm that fires while a turn (or a compaction) holds its thread waits in
// the mailbox, however long that runs, and the thread's release wakes it for
// the alarm.
test("an alarm that fires while its thread is held is woken for at the release, as an alarm", async () => {
  const env = freshStoresEnv("md-pending-runtime-alarm-held-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const thread = env.agentStore.createManagerThread("project-1 release");
    const earlier = new AgentAlarmManager({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as unknown as AgentSseEmitter, onWake: () => null, timers: secondBehind });
    earlier.schedule({ threadId: thread.id, when: "1s", note: "check the release build" });
    earlier.dispose();
    runtime = testAgentRuntime(env, { ready: Promise.resolve() });
    const release = runtime.wakeScheduler.holdThread(thread.id)!;
    await waitUntil(() => env.agentStore.queuedMailboxSources(thread.id).includes("alarm"), { timeout: 5_000, interval: 20, label: "the alarm to fire" });
    // Held: nothing in the conversation yet, no wake, and no tries against
    // the held thread (the alarm is no longer waited on: its mail is).
    expect(env.agentStore.getMessages(thread.id).map((m) => m.source)).toEqual([]);
    expect(env.agentStore.getLatestWakeForThread(thread.id)).toBeNull();
    expect(runtime.pendingMonitors(thread.id).monitors).toEqual([]);
    release();
    await waitUntil(() => env.agentStore.getLatestWakeForThread(thread.id)?.reason === "alarm", { timeout: 5_000, interval: 20, label: "the alarm's wake" });
    await waitUntil(() => env.agentStore.getMessages(thread.id).some((m) => m.source === "alarm"), { timeout: 5_000, interval: 20, label: "the alarm taken in" });
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});
