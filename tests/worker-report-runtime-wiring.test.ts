import { expect, spyOn, test } from "bun:test";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import type { PostWakeInfo, WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { workerReportOf } from "../src/shared/worker-report.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { stub, toolContext } from "./helpers/typed.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { waitUntil } from "./helpers/wait.js";
import { featureMessageRequestMetadata } from "../src/shared/feature-message.js";

// The runtime, not the reporter: a worker's wake end reaches its owner thread
// through the scheduler's post-wake hook the runtime installs.
test("the runtime reports a worker's wake end to its owner — a finished plan as done, an error as failed with the wake's own message", async () => {
  const env = freshStoresEnv("md-report-runtime-wiring-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, {
      workStore
    });
    // The report's own wake of the owner is recorded, not run.
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_report";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const reports = () => (env.store.db
      // Insertion order: two reports in one millisecond tie on created_at, and ids are random.
      .prepare("select thread_id, content from agent_mailbox where source = 'worker-report' order by rowid")
      .all() as Array<{ thread_id: string; content: string }>)
      .map((r) => ({ thread: r.thread_id, ...workerReportOf(JSON.parse(r.content)) }));

    new PlanStore(env.store.db).update(featureId, { conclusion: "EvictHook wired; tests pass", steps: [{ title: "Wire", status: "done", note: "ok" }] });
    const finished = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(finished.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: finished.id, status: "finished" }));
    expect(reports()).toMatchObject([{ thread: owner.id, featureId, key: "done" }]);
    expect(woken).toStrictEqual([[owner.id, "worker-report"]]);

    const failed = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(failed.id, "error", "provider 500: overloaded");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: failed.id, status: "error" }));
    expect(workStore.getByFeature(featureId)!.failedMessage).toBe("provider 500: overloaded");
    expect(reports().at(-1)).toMatchObject({ thread: owner.id, key: "failed" });
    expect(reports().at(-1)!.line).toContain("provider 500: overloaded");
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// The runtime, not the plan tool or the reporter: a question a worker writes
// into its plan reaches its owner thread while the worker's turn still runs.
test("the runtime reports a worker's question to its owner the moment the plan gets it, and not again when that turn ends", async () => {
  const env = freshStoresEnv("md-report-runtime-question-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, {
      workStore
    });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_report";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const reports = () => (env.store.db
      .prepare("select thread_id, content from agent_mailbox where source = 'worker-report' order by rowid")
      .all() as Array<{ thread_id: string; content: string }>)
      .map((r) => ({ thread: r.thread_id, ...workerReportOf(JSON.parse(r.content)) }));

    const update = runtime.scopes.worker.toolDefinitions.find((tool) => tool.name === "update_plan")!;
    const ctx = toolContext({
      threadId: worker.id, wakeId: "w",
      scope: { kind: "worker", feature: { workingDir: null }, project: { workingDir: "/tmp" } },
      feature: env.features.getById(featureId) ?? undefined
    });
    const turn = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    await update.handler({ steps: [{ title: "Wire", status: "in_progress" }], openQuestions: ["Keep the old flag as an alias?"] }, ctx);
    expect(reports()).toMatchObject([{ thread: owner.id, featureId, key: "input", line: "Keep the old flag as an alias?" }]);
    expect(woken).toStrictEqual([[owner.id, "worker-report"]]);
    // It works on, and asks a second thing: that one is what the manager is told now.
    await update.handler({ steps: [{ id: 1, note: "half way" }], openQuestions: ["Keep the old flag as an alias?", "Ship behind a flag?"] }, ctx);
    expect(reports().map((r) => r.line)).toStrictEqual(["Keep the old flag as an alias?", "Ship behind a flag?"]);
    woken.length = 1;
    env.agentStore.finishWake(turn.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: turn.id, status: "finished" }));
    // Its turn ends with both still open: nothing is said again.
    expect(reports().length).toBe(2);
    expect(woken.length).toBe(1);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// After a worker's turn its reply went to whoever asked, then its report to
// its manager, in one go: a write the database refused in the reply skipped
// the report, and neither was tried again. The manager never heard the
// worker had finished.
test("a worker's reply and report reach its manager though the database refuses the first write: each tried again, sent once", async () => {
  const env = freshStoresEnv("md-report-runtime-refused-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, { workStore, stepRetryDelaysMs: [5, 5, 5] });
    (runtime.wakeScheduler as unknown as { wake: () => string }).wake = () => "wk_recorded";
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    // The manager asked; the worker's turn answered and finished its plan.
    env.agentStore.enqueueMailboxMessage({
      threadId: worker.id, role: "user", source: "manager", sourceThreadId: owner.id,
      content: { type: "text", text: "Is the hook wired?", metadata: featureMessageRequestMetadata() }
    });
    const wake = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.drainMailboxToMessages(worker.id, wake.id);
    env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Wired; tests pass." } });
    new PlanStore(env.store.db).update(featureId, { conclusion: "EvictHook wired", steps: [{ title: "Wire", status: "done", note: "ok" }] });
    env.agentStore.finishWake(wake.id, "finished");
    const real = env.agentStore.enqueueMailboxMessage.bind(env.agentStore);
    let refuse = true;
    env.agentStore.enqueueMailboxMessage = (input) => {
      if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      return real(input);
    };
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: wake.id, status: "finished" }));
    const toOwner = () => (env.store.db.prepare("select source from agent_mailbox where thread_id = ? order by rowid").all(owner.id) as Array<{ source: string }>).map((r) => r.source).sort();
    await waitUntil(() => toOwner().length === 2, { label: "the reply and the report", timeout: 2_000 });
    expect(toOwner()).toEqual(["feature-message", "worker-report"]);
    expect(workStore.getReportedState(featureId)).toBe("done");
  } finally {
    logged.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});

// A report tried again after a newer turn of the worker ended would replay
// the older turn's state over the newer one (a failure after a finished plan).
test("a report tried again after a newer turn of its worker ended is dropped: the newer turn reported its own state", async () => {
  const env = freshStoresEnv("md-report-runtime-stale-retry-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, { workStore, stepRetryDelaysMs: [80, 80] });
    (runtime.wakeScheduler as unknown as { wake: () => string }).wake = () => "wk_recorded";
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const real = env.agentStore.enqueueMailboxMessage.bind(env.agentStore);
    let refuse = true;
    env.agentStore.enqueueMailboxMessage = (input) => {
      if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      return real(input);
    };
    // Turn 1 fails; its report is refused and waits for a try again.
    const failed = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(failed.id, "error", "provider 500: overloaded");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: failed.id, status: "error" }));
    // Turn 2 finishes the plan and reports done.
    new PlanStore(env.store.db).update(featureId, { conclusion: "EvictHook wired", steps: [{ title: "Wire", status: "done", note: "ok" }] });
    const finished = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(finished.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: finished.id, status: "finished" }));
    const reports = () => (env.store.db.prepare("select content from agent_mailbox where source = 'worker-report' order by rowid").all() as Array<{ content: string }>).map((r) => workerReportOf(JSON.parse(r.content))?.key);
    expect(reports()).toStrictEqual(["done"]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(reports()).toStrictEqual(["done"]);
    expect(workStore.getByFeature(featureId)!.failedMessage).toBeNull();
    expect(workStore.getReportedState(featureId)).toBe("done");
  } finally {
    logged.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});

// A worker's turn that stops with steps left, nothing set to wake it and
// nothing said to its manager: the manager's sweep looks now, not in its
// interval. A turn that told the manager (a report, a reply), or that set
// something to wake the worker, leaves the sweep to its interval.
test("a worker that stops quietly with steps left tells its manager so, with its last reply, and the sweep keeps its interval", async () => {
  const env = freshStoresEnv("md-report-runtime-quiet-stop-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    // The sweep's own interval never runs here: only a sweep asked for now wakes.
    runtime = testAgentRuntime(env, { workStore, managerSweep: { delayMs: 3_600_000, timers: { setTimeout: () => ({}), clearTimeout: () => {} } as never } });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_recorded";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const plans = new PlanStore(env.store.db);
    const endTurn = async () => {
      const wake = env.agentStore.createWake({ threadId: worker.id, reason: "alarm", triggerMessageId: null });
      env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Report half written." } });
      env.agentStore.finishWake(wake.id, "finished");
      await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: wake.id, status: "finished" }));
      return wake;
    };
    const silent = () => (env.store.db.prepare("select content from agent_mailbox where source = 'worker-report'").all() as Array<{ content: string }>)
      .map((row) => JSON.parse(row.content) as { text: string })
      .filter((content) => workerReportOf(content as never)?.key === "silent");

    // Its last step still in progress, nothing set to wake it: a silent stop
    // tells the manager at once, in place of making the sweep due.
    plans.update(featureId, { steps: [{ title: "Wire", status: "done", note: "ok" }, { title: "Report", status: "in_progress" }] });
    await endTurn();
    expect(woken).toStrictEqual([[owner.id, "worker-report"]]);
    expect(silent().map((content) => content.text.endsWith("\n\nLast reply:\nReport half written."))).toEqual([true]);

    // An alarm set for itself: it will move again, nothing to look at.
    woken.length = 0;
    env.store.db.prepare(
      `insert into agent_alarms (id, thread_id, fire_at, note, status, created_at)
       values ('al_q', ?, '2099-01-01T00:00:00.000Z', 'later', 'pending', '2026-08-06T00:00:00.000Z')`
    ).run(worker.id);
    await endTurn();
    expect(woken).toStrictEqual([]);
    expect(silent()).toHaveLength(1);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

test("a worker that stops quietly after answering its manager leaves the sweep alone: the reply says where it is", async () => {
  const env = freshStoresEnv("md-report-runtime-quiet-reply-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, { workStore, managerSweep: { delayMs: 3_600_000, timers: { setTimeout: () => ({}), clearTimeout: () => {} } as never } });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_recorded";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    new PlanStore(env.store.db).update(featureId, { steps: [{ title: "Wire", status: "in_progress" }] });
    env.agentStore.enqueueMailboxMessage({
      threadId: worker.id, role: "user", source: "manager", sourceThreadId: owner.id,
      content: { type: "text", text: "Where is the hook?", metadata: featureMessageRequestMetadata() }
    });
    const wake = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.drainMailboxToMessages(worker.id, wake.id);
    env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Half wired." } });
    env.agentStore.finishWake(wake.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: wake.id, status: "finished" }));
    expect(woken.filter(([, reason]) => reason === "work-item-heartbeat")).toStrictEqual([]);
    expect(woken.some(([thread]) => thread === owner.id)).toBe(true);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

test("a turn that reported a new state, or that a person stopped, leaves the sweep to its interval", async () => {
  const env = freshStoresEnv("md-report-runtime-quiet-told-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, { workStore, managerSweep: { delayMs: 3_600_000, timers: { setTimeout: () => ({}), clearTimeout: () => {} } as never } });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_recorded";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const heartbeats = () => woken.filter(([, reason]) => reason === "work-item-heartbeat");
    // A blocked step and one still to do: the turn's report says it is blocked.
    new PlanStore(env.store.db).update(featureId, { steps: [{ title: "Get access", status: "blocked", note: "no dev login" }, { title: "Deploy" }] });
    const blocked = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(blocked.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: blocked.id, status: "finished" }));
    expect(woken).toStrictEqual([[owner.id, "worker-report"]]);

    // A person stopped the turn: they know; the sweep keeps its interval.
    const canceled = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(canceled.id, "canceled");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: canceled.id, status: "canceled" }));
    expect(heartbeats()).toStrictEqual([]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

test("a turn that leaves its own worker moving does not sweep now for another worker the manager has stuck", async () => {
  const env = freshStoresEnv("md-report-runtime-quiet-other-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    const moving = seedFeature(env.features, projectId, { name: "moving", tmuxWindowName: "moving" });
    const stuck = seedFeature(env.features, projectId, { name: "stuck", tmuxWindowName: "stuck" });
    env.features.setOwner(moving, owner.id);
    env.features.setOwner(stuck, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", moving);
    env.agentStore.getOrCreateThread("worker", stuck);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, { workStore, managerSweep: { delayMs: 3_600_000, timers: { setTimeout: () => ({}), clearTimeout: () => {} } as never } });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_recorded";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const plans = new PlanStore(env.store.db);
    plans.update(stuck, { steps: [{ title: "Left behind", status: "in_progress" }] });
    plans.update(moving, { steps: [{ title: "Wait for CI", status: "in_progress" }] });
    env.store.db.prepare(
      `insert into agent_alarms (id, thread_id, fire_at, note, status, created_at)
       values ('al_m', ?, '2099-01-01T00:00:00.000Z', 'later', 'pending', '2026-08-06T00:00:00.000Z')`
    ).run(worker.id);
    const turn = env.agentStore.createWake({ threadId: worker.id, reason: "alarm", triggerMessageId: null });
    env.agentStore.finishWake(turn.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: turn.id, status: "finished" }));
    // The other one is the interval's to find.
    expect(woken).toStrictEqual([]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

test("a reply refused once and tried again is still the manager being told: no sweep now beside it", async () => {
  const env = freshStoresEnv("md-report-runtime-quiet-refused-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, { workStore, stepRetryDelaysMs: [5, 5, 5], managerSweep: { delayMs: 3_600_000, timers: { setTimeout: () => ({}), clearTimeout: () => {} } as never } });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_recorded";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    new PlanStore(env.store.db).update(featureId, { steps: [{ title: "Wire", status: "in_progress" }] });
    env.agentStore.enqueueMailboxMessage({
      threadId: worker.id, role: "user", source: "manager", sourceThreadId: owner.id,
      content: { type: "text", text: "Where is the hook?", metadata: featureMessageRequestMetadata() }
    });
    const wake = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.drainMailboxToMessages(worker.id, wake.id);
    env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "Half wired." } });
    env.agentStore.finishWake(wake.id, "finished");
    const real = env.agentStore.enqueueMailboxMessage.bind(env.agentStore);
    let refuse = true;
    env.agentStore.enqueueMailboxMessage = (input) => {
      if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      return real(input);
    };
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: wake.id, status: "finished" }));
    const toOwner = () => (env.store.db.prepare("select source from agent_mailbox where thread_id = ?").all(owner.id) as Array<{ source: string }>).map((r) => r.source);
    await waitUntil(() => toOwner().includes("feature-message"), { label: "the reply", timeout: 2_000 });
    expect(woken.filter(([, reason]) => reason === "work-item-heartbeat")).toStrictEqual([]);
  } finally {
    logged.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});

test("a sweep step tried again after a newer turn of its worker ended is dropped: the newer turn settled the sweep", async () => {
  const env = freshStoresEnv("md-report-runtime-quiet-superseded-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, { workStore, stepRetryDelaysMs: [60, 60, 60], managerSweep: { delayMs: 3_600_000, timers: { setTimeout: () => ({}), clearTimeout: () => {} } as never } });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_recorded";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    new PlanStore(env.store.db).update(featureId, { steps: [{ title: "Wire", status: "in_progress" }] });
    // The first look at whether it is stalled is refused; the turn's sweep step is tried again later.
    const realStalled = workStore.isStalled.bind(workStore);
    let refuse = true;
    workStore.isStalled = (id: string) => {
      if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      return realStalled(id);
    };
    const quiet = env.agentStore.createWake({ threadId: worker.id, reason: "alarm", triggerMessageId: null });
    env.agentStore.finishWake(quiet.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: quiet.id, status: "finished" }));
    // Before that try, a newer turn ends in an error, and says so.
    const failed = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.finishWake(failed.id, "error", "provider 500: overloaded");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: failed.id, status: "error" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(woken.filter(([, reason]) => reason === "work-item-heartbeat")).toStrictEqual([]);
    expect(woken.filter(([, reason]) => reason === "worker-report")).toStrictEqual([[owner.id, "worker-report"]]);
  } finally {
    logged.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});

test("a report refused once and tried again is still the manager being told: no sweep now beside it", async () => {
  const env = freshStoresEnv("md-report-runtime-quiet-refused-report-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, { workStore, stepRetryDelaysMs: [5, 5, 5], managerSweep: { delayMs: 3_600_000, timers: { setTimeout: () => ({}), clearTimeout: () => {} } as never } });
    const woken: Array<[string, string]> = [];
    (runtime.wakeScheduler as unknown as { wake: (threadId: string, reason: string) => string }).wake = (threadId, reason) => {
      woken.push([threadId, reason]);
      return "wk_recorded";
    };
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    // Blocked on one step with another still to do: stalled, and a report to send.
    new PlanStore(env.store.db).update(featureId, { steps: [{ title: "Get access", status: "blocked", note: "no dev login" }, { title: "Deploy" }] });
    const wake = env.agentStore.createWake({ threadId: worker.id, reason: "alarm", triggerMessageId: null });
    env.agentStore.finishWake(wake.id, "finished");
    const real = env.agentStore.enqueueMailboxMessage.bind(env.agentStore);
    let refuse = true;
    env.agentStore.enqueueMailboxMessage = (input) => {
      if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      return real(input);
    };
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: wake.id, status: "finished" }));
    await waitUntil(() => woken.some(([, reason]) => reason === "worker-report"), { label: "the report", timeout: 2_000 });
    expect(woken.filter(([, reason]) => reason === "work-item-heartbeat")).toStrictEqual([]);
  } finally {
    logged.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});


// Through the runtime: a turn's report carries its last reply, unless that
// reply already went up as the answer to the manager's message.
test("the runtime's report of a turn carries its last reply, unless the reply already answered the manager", async () => {
  const env = freshStoresEnv("md-report-runtime-last-reply-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    runtime = testAgentRuntime(env, { workStore: new WorkItemStore(env.store.db) });
    (runtime.wakeScheduler as unknown as { wake: () => string }).wake = () => "wk_recorded";
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const lastReport = () => JSON.parse((env.store.db.prepare("select content from agent_mailbox where source = 'worker-report' order by rowid desc limit 1").get() as { content: string }).content).text as string;
    const plans = new PlanStore(env.store.db);

    plans.update(featureId, { steps: [{ title: "Wire", status: "done", note: "ok" }] });
    const alone = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", wakeId: alone.id, content: { type: "assistant", text: "Hook wired; tests pass." } });
    env.agentStore.finishWake(alone.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: alone.id, status: "finished" }));
    expect(lastReport().endsWith("\n\nLast reply:\nHook wired; tests pass.")).toBe(true);

    plans.update(featureId, { steps: [{ id: 1, status: "blocked", note: "waits on review" }] });
    env.agentStore.enqueueMailboxMessage({
      threadId: worker.id, role: "user", source: "manager", sourceThreadId: owner.id,
      content: { type: "text", text: "Where is it?", metadata: featureMessageRequestMetadata() }
    });
    const asked = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.drainMailboxToMessages(worker.id, asked.id);
    env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", wakeId: asked.id, content: { type: "assistant", text: "Blocked on review." } });
    env.agentStore.finishWake(asked.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: asked.id, status: "finished" }));
    expect(lastReport()).toContain(": blocked — ");
    expect(lastReport()).not.toContain("Last reply:");
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// A question the worker reported mid-turn and then cleared told the manager;
// its turn's end is no silent stop.
test("a turn that reported a question mid-turn, then cleared it, is no silent stop", async () => {
  const env = freshStoresEnv("md-report-runtime-silent-asked-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    runtime = testAgentRuntime(env, { workStore: new WorkItemStore(env.store.db), managerSweep: { delayMs: 3_600_000, timers: { setTimeout: () => ({}), clearTimeout: () => {} } as never } });
    (runtime.wakeScheduler as unknown as { wake: () => string }).wake = () => "wk_recorded";
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    const keys = () => (env.store.db.prepare("select content from agent_mailbox where source = 'worker-report' order by rowid").all() as Array<{ content: string }>)
      .map((row) => workerReportOf(JSON.parse(row.content))?.key);
    const update = runtime.scopes.worker.toolDefinitions.find((tool) => tool.name === "update_plan")!;
    const ctx = toolContext({
      threadId: worker.id, wakeId: "w",
      scope: { kind: "worker", feature: { workingDir: null }, project: { workingDir: "/tmp" } },
      feature: env.features.getById(featureId) ?? undefined
    });
    const turn = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    await update.handler({ steps: [{ title: "Wire", status: "in_progress" }], openQuestions: ["Keep the old flag?"] }, ctx);
    await update.handler({ steps: [{ id: 1, note: "decided myself" }], openQuestions: [] }, ctx);
    env.agentStore.finishWake(turn.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: turn.id, status: "finished" }));
    expect(keys()).toStrictEqual(["input"]);
    // Its next turn told it nothing: that one is.
    const quiet = env.agentStore.createWake({ threadId: worker.id, reason: "alarm", triggerMessageId: null });
    env.agentStore.finishWake(quiet.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: quiet.id, status: "finished" }));
    expect(keys()).toStrictEqual(["input", "silent"]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

// The sweep is the safety net, so it is re-armed even when the silent report
// cannot be written.
test("a silent report the database keeps refusing still leaves the sweep armed", async () => {
  const env = freshStoresEnv("md-report-runtime-silent-refused-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const owner = env.agentStore.createManagerThread("project-2 cache expiry");
    env.features.setOwner(featureId, owner.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const armed: number[] = [];
    runtime = testAgentRuntime(env, {
      workStore: new WorkItemStore(env.store.db),
      stepRetryDelaysMs: [5, 5, 5],
      managerSweep: { delayMs: 3_600_000, timers: { setTimeout: (_cb: () => void, ms: number) => { armed.push(ms); return { unref() {} }; }, clearTimeout: () => {} } as never }
    });
    (runtime.wakeScheduler as unknown as { wake: () => string }).wake = () => "wk_recorded";
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    new PlanStore(env.store.db).update(featureId, { steps: [{ title: "Wire", status: "in_progress" }] });
    const real = env.agentStore.enqueueMailboxMessage.bind(env.agentStore);
    env.agentStore.enqueueMailboxMessage = (input) => {
      if (input.source === "worker-report") throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return real(input);
    };
    const turn = env.agentStore.createWake({ threadId: worker.id, reason: "alarm", triggerMessageId: null });
    env.agentStore.finishWake(turn.id, "finished");
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: turn.id, status: "finished" }));
    await waitUntil(() => armed.includes(3_600_000));
    expect(armed).toContain(3_600_000);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});
