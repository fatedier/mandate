import { expect, test } from "bun:test";
import { AgentAlarmManager, type AgentAlarmTimerHandle, type AgentAlarmTimers } from "../src/server/modules/agent/agent-alarm-manager.js";
import { createRetiredThreadGuard } from "../src/server/runtime/retired-threads.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { stub } from "./helpers/typed.js";
import type { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";

// An archived worker could go on waking on its own alarms: archiving touched
// neither its worker thread nor the alarms that thread had scheduled. Nothing
// may wake a retired worker's conversation on its own; the user still can.

function setup() {
  const env = freshStoresEnv("md-retired-");
  const projectId = seedProject(env.projects);
  const workerId = seedWorker(env.workers, projectId);
  const otherWorkerId = seedWorker(env.workers, projectId, { name: "G", tmuxWindowName: "g" });
  const worker = env.agentStore.getOrCreateThread("worker", workerId);
  const cancelled: string[] = [];
  const stopped: string[] = [];
  const guard = createRetiredThreadGuard({
    agentStore: env.agentStore,
    workersStore: env.workers,
    backgroundTasks: new BackgroundTaskStore(env.store.db),
    cancelThreadWakeSources: (threadId) => cancelled.push(threadId),
    stopBackgroundTasks: (threadId) => stopped.push(threadId)
  });
  return { env, projectId, workerId, otherWorkerId, worker, guard, cancelled, stopped };
}

test("a worker thread is retired once its worker is archived, and only then", () => {
  const { env, workerId, worker, guard } = setup();
  const manager = env.agentStore.getOrCreateThread("manager", null);
  expect([guard.isThreadRetired(worker.id), guard.isThreadRetired(manager.id)]).toEqual([false, false]);
  env.workers.archive(workerId);
  expect([guard.isThreadRetired(worker.id), guard.isThreadRetired(manager.id)]).toEqual([true, false]);
});

test("archiving the project retires its workers' threads too", () => {
  const { env, projectId, otherWorkerId, worker, guard } = setup();
  const other = env.agentStore.getOrCreateThread("worker", otherWorkerId);
  env.workers.archiveByProjectId(projectId);
  expect([guard.isThreadRetired(worker.id), guard.isThreadRetired(other.id)]).toEqual([true, true]);
});

test("an unknown thread is not treated as retired", () => {
  const { guard } = setup();
  expect(guard.isThreadRetired("thr_missing")).toBe(false);
});

/** A subagent of `parentThreadId` as the service makes one: its thread in the
 *  subagent scope, made for the task's id, then its task naming that thread. */
function subagentOf(env: ReturnType<typeof freshStoresEnv>, parentThreadId: string) {
  const taskId = newId("task");
  const child = env.agentStore.createSubagentThread(taskId);
  const task = new BackgroundTaskStore(env.store.db).create({ id: taskId, parentThreadId, childThreadId: child.id, type: "general", title: "project-1 retry call sites", task: "Find every call site of retryWake in project-1." });
  return { task, child };
}

// A subagent works for the conversation that started it: once that one is
// archived, or retired with its worker, nobody is left to read its result.
test("a subagent's thread is retired with the conversation it works for, and only then", () => {
  const { env, workerId, worker, guard } = setup();
  const manager = env.agentStore.createManagerThread("project-1 release");
  const ofManager = subagentOf(env, manager.id).child;
  const ofWorker = subagentOf(env, worker.id).child;
  expect([guard.isThreadRetired(ofManager.id), guard.isThreadRetired(ofWorker.id)]).toEqual([false, false]);
  env.workers.archive(workerId);
  expect([guard.isThreadRetired(ofManager.id), guard.isThreadRetired(ofWorker.id)]).toEqual([false, true]);
  env.agentStore.archiveThread(manager.id);
  expect([guard.isThreadRetired(ofManager.id), guard.isThreadRetired(ofWorker.id)]).toEqual([true, true]);
});

test("a subagent whose task is gone works for nobody: retired", () => {
  const { env, worker, guard } = setup();
  const { task, child } = subagentOf(env, worker.id);
  expect(guard.isThreadRetired(child.id)).toBe(false);
  env.store.db.prepare("delete from background_tasks where id = ?").run(task.id);
  expect(guard.isThreadRetired(child.id)).toBe(true);
});

// A project archive calls no hook: the first wake refused is where a retired
// worker's subagents stop, whether the wake was the worker's or a subagent's.
test("a refused wake stops the retired conversation's subagents: a subagent's refusal stops its parent's, a worker's its own", () => {
  const { env, workerId, worker, guard, cancelled, stopped } = setup();
  const { child } = subagentOf(env, worker.id);
  env.workers.archive(workerId);
  const { scheduler: wakes } = scheduler(env, guard);
  expect(wakes.wake(child.id, "subagent-task", null)).toBe(null);
  expect(wakes.wake(worker.id, "subagent-result", null)).toBe(null);
  expect(countWakes(env, child.id) + countWakes(env, worker.id)).toBe(0);
  expect(cancelled).toStrictEqual([child.id, worker.id]);
  expect(stopped).toStrictEqual([worker.id, worker.id]);
});

const STUB_DISPATCHER = stub<ToolDispatcher>({ registry: stub<ToolRegistry>({ tools: {} }), async dispatch() { return { result: {} }; } });

function scheduler(env: ReturnType<typeof freshStoresEnv>, guard: ReturnType<typeof createRetiredThreadGuard>, replies = 1) {
  return createTestWakeScheduler({
    agentStore: env.agentStore,
    buildSystemPrompt: () => "system",
    toolDispatcherForThread: () => STUB_DISPATCHER,
    llmModel: createMockLLM(Array.from({ length: replies }, () => ({ text: "done", finishReason: "stop" as const }))),
    isThreadRetired: guard.isThreadRetired,
    onRetiredWakeRefused: guard.onRetiredWakeRefused
  });
}

test("the scheduler refuses an automatic wake on a retired thread and clears what would wake it again", () => {
  const { env, workerId, worker, guard, cancelled } = setup();
  env.workers.archive(workerId);
  const { scheduler: wakes } = scheduler(env, guard);
  for (const reason of ["alarm", "pane-monitor", "command-monitor"] as const) {
    expect([reason, wakes.wake(worker.id, reason, null)]).toEqual([reason, null]);
  }
  expect(countWakes(env, worker.id)).toBe(0);
  expect(cancelled).toStrictEqual([worker.id, worker.id, worker.id]);
});

test("the user can still wake a retired worker's conversation", async () => {
  const { env, workerId, worker, guard, cancelled } = setup();
  env.workers.archive(workerId);
  const { wakeAndWait } = scheduler(env, guard);
  const trigger = env.agentStore.appendMessage({
    threadId: worker.id, role: "user", source: "user", content: { type: "text", text: "one more thing" }
  });
  const wakeId = await wakeAndWait(worker.id, "user", trigger.id);
  expect(env.agentStore.getWakeById(wakeId)?.status).toBe("finished");
  expect(cancelled).toStrictEqual([]);
});

test("an active worker's thread wakes on its own as before", async () => {
  const { env, worker, guard, cancelled } = setup();
  const { wakeAndWait } = scheduler(env, guard);
  const trigger = env.agentStore.appendMessage({
    threadId: worker.id, role: "user", source: "alarm", content: { type: "text", text: "[Mandate alarm] check again" }
  });
  const wakeId = await wakeAndWait(worker.id, "alarm", trigger.id);
  expect(env.agentStore.getWakeById(wakeId)?.status).toBe("finished");
  expect(cancelled).toStrictEqual([]);
});

function countWakes(env: ReturnType<typeof freshStoresEnv>, threadId: string): number {
  return (env.store.db.prepare("select count(*) c from agent_wakes where thread_id = ?").get(threadId) as { c: number }).c;
}

class Timers implements AgentAlarmTimers {
  nowMs = Date.parse("2026-09-25T00:00:00.000Z");
  handles: Array<{ callback: () => void; fireAt: number; cleared: boolean }> = [];
  now() { return this.nowMs; }
  setTimeout(callback: () => void, ms: number): AgentAlarmTimerHandle {
    const handle = { callback, fireAt: this.nowMs + ms, cleared: false };
    this.handles.push(handle);
    return handle;
  }
  clearTimeout(timer: AgentAlarmTimerHandle) { (timer as { cleared: boolean }).cleared = true; }
  advance(ms: number) {
    this.nowMs += ms;
    for (const handle of this.handles) {
      if (!handle.cleared && handle.fireAt <= this.nowMs) { handle.cleared = true; handle.callback(); }
    }
  }
}

test("an alarm set before the archive is cancelled when due, with the thread's later alarms, and writes nothing", () => {
  const { env, workerId, worker } = setup();
  const timers = new Timers();
  let wakes: ReturnType<typeof scheduler>["scheduler"] | null = null;
  const guard = createRetiredThreadGuard({
    agentStore: env.agentStore,
    workersStore: env.workers,
    backgroundTasks: new BackgroundTaskStore(env.store.db),
    cancelThreadWakeSources: (threadId) => { alarms.cancelThread(threadId); },
    stopBackgroundTasks: () => {}
  });
  const alarms = new AgentAlarmManager({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (threadId, reason, triggerMessageId) => wakes!.wake(threadId, reason, triggerMessageId),
    isThreadRetired: guard.isThreadRetired,
    timers
  });
  wakes = scheduler(env, guard).scheduler;
  alarms.schedule({ threadId: worker.id, when: "2h", note: "poll the PR again" });
  alarms.schedule({ threadId: worker.id, when: "4h", note: "and again" });
  env.workers.archive(workerId);

  timers.advance(2 * 60 * 60 * 1000 + 1000);
  expect(countWakes(env, worker.id)).toBe(0);
  const statuses = (env.store.db.prepare("select status from agent_alarms where thread_id = ? order by fire_at").all(worker.id) as Array<{ status: string }>)
    .map((row) => row.status);
  expect(statuses).toEqual(["canceled", "canceled"]);
  // No "alarm fired" message lands in the archived conversation either.
  const alarmMessages = env.store.db.prepare("select count(*) c from agent_messages where thread_id = ? and source = 'alarm'").get(worker.id) as { c: number };
  expect(alarmMessages.c).toBe(0);
  timers.advance(4 * 60 * 60 * 1000);
  expect(countWakes(env, worker.id)).toBe(0);
});

test("an internal wake that borrows the user reason is refused; a person's is not", async () => {
  // Mailbox flushes, task wakes and worker-message replies wake with reason
  // "user" but no triggering message of the user's own.
  const { env, workerId, worker, guard } = setup();
  env.workers.archive(workerId);
  const { scheduler: wakes, waitForWake } = scheduler(env, guard, 2);
  const say = (source: "user" | "voice" | "worker-message" | "manager") => env.agentStore.appendMessage({
    threadId: worker.id, role: "user", source, content: { type: "text", text: `from ${source}` }
  }).id;
  expect(wakes.wake(worker.id, "user", null)).toBe(null);
  expect(wakes.wake(worker.id, "user", say("worker-message"))).toBe(null);
  expect(wakes.wake(worker.id, "user", say("manager"))).toBe(null);
  expect(countWakes(env, worker.id)).toBe(0);

  const voiceWake = wakes.wake(worker.id, "user", say("voice"));
  expect(typeof voiceWake).toBe("string");
  await waitForWake(voiceWake!);
  const chatWake = wakes.wake(worker.id, "user", say("user"));
  expect(typeof chatWake).toBe("string");
  await waitForWake(chatWake!);
  // Allowed means it ran to the end, not merely that a row was created.
  expect([voiceWake, chatWake].map((id) => env.agentStore.getWakeById(id!)?.status)).toEqual(["finished", "finished"]);
});

test("a pane monitor on a retired thread is cleared before it writes anything", async () => {
  const { env, workerId, worker, guard } = setup();
  let nowMs = Date.now();
  const wakes: string[] = [];
  let captures = 0;
  const { PaneMonitorManager } = await import("../src/server/modules/agent/pane-monitor-manager.js");
  const paneMonitors = new PaneMonitorManager({
    db: env.store.db,
    stableMs: 5000,
    agentStore: env.agentStore,
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (threadId) => { wakes.push(threadId); return "wake-1"; },
    isThreadBusy: () => false,
    isThreadRetired: guard.isThreadRetired,
    getPaneState: () => ({ status: "ok", changedAt: new Date(nowMs - 60_000).toISOString() }),
    capturePaneTail: async () => { captures++; return ""; },
    now: () => nowMs
  });
  try {
    paneMonitors.register({ ownerThreadId: worker.id, windowKey: "md-p:f", paneId: "%1", timeoutMs: 60_000 });
    paneMonitors.register({ ownerThreadId: worker.id, windowKey: "md-p:f", paneId: "%2", timeoutMs: 60_000 });
    env.workers.archive(workerId);
    nowMs += 5000;
    await (paneMonitors as any).checkAll();
    expect(wakes).toStrictEqual([]);
    // Refused before the pane is even read, not only before the message.
    expect(captures).toBe(0);
    expect(env.agentStore.getActiveMessages(worker.id).filter((m) => m.source === "pane-monitor")).toHaveLength(0);
    expect(paneMonitors.list(worker.id)).toHaveLength(0);
    // The watch that fired left the live map before the check ran, so clearing
    // the thread alone would have left its target marked as watched.
    expect((paneMonitors as any).currentMonitorByTarget.size).toBe(0);
  } finally {
    paneMonitors.dispose();
  }
});

test("a worker archived while a pane monitor captures its pane gets no monitor message either", async () => {
  const { env, workerId, worker, guard } = setup();
  let nowMs = Date.now();
  const wakes: string[] = [];
  const { PaneMonitorManager } = await import("../src/server/modules/agent/pane-monitor-manager.js");
  const paneMonitors = new PaneMonitorManager({
    db: env.store.db,
    stableMs: 5000,
    agentStore: env.agentStore,
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (threadId) => { wakes.push(threadId); return "wake-1"; },
    isThreadBusy: () => false,
    isThreadRetired: guard.isThreadRetired,
    getPaneState: () => ({ status: "ok", changedAt: new Date(nowMs - 60_000).toISOString() }),
    // The archive lands during the capture's await, after the first check passed.
    capturePaneTail: async () => { env.workers.archive(workerId); return ""; },
    now: () => nowMs
  });
  try {
    paneMonitors.register({ ownerThreadId: worker.id, windowKey: "md-p:f", paneId: "%1", timeoutMs: 60_000 });
    nowMs += 5000;
    await (paneMonitors as any).checkAll();
    expect(wakes).toStrictEqual([]);
    expect(env.agentStore.getActiveMessages(worker.id).filter((m) => m.source === "pane-monitor")).toHaveLength(0);
    expect((paneMonitors as any).currentMonitorByTarget.size).toBe(0);
  } finally {
    paneMonitors.dispose();
  }
});

test("a retired conversation cannot register a pane monitor that would never fire", async () => {
  const { env, workerId, worker, guard } = setup();
  const { PaneMonitorManager } = await import("../src/server/modules/agent/pane-monitor-manager.js");
  const paneMonitors = new PaneMonitorManager({
    db: env.store.db,
    stableMs: 5000,
    agentStore: env.agentStore,
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: () => null,
    isThreadBusy: () => false,
    isThreadRetired: guard.isThreadRetired,
    getPaneState: () => ({ status: "ok", changedAt: new Date().toISOString() }),
    capturePaneTail: async () => ""
  });
  try {
    paneMonitors.register({ ownerThreadId: worker.id, windowKey: "md-p:f", paneId: "%1", timeoutMs: 60_000 });
    env.workers.archive(workerId);
    expect(() => paneMonitors.register({ ownerThreadId: worker.id, windowKey: "md-p:f", paneId: "%2", timeoutMs: 60_000 }))
      .toThrow("this worker is archived, so a monitor here would never fire; restore the worker first");
    expect(paneMonitors.list(worker.id).map((paneMonitor) => paneMonitor.paneId)).toEqual(["%1"]);
  } finally {
    paneMonitors.dispose();
  }
});

test("a retired conversation cannot schedule an alarm that would never fire", () => {
  const { env, workerId, worker, guard } = setup();
  const timers = new Timers();
  const alarms = new AgentAlarmManager({
    db: env.store.db,
    agentStore: env.agentStore,
    sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: () => null,
    isThreadRetired: guard.isThreadRetired,
    timers
  });
  expect(alarms.schedule({ threadId: worker.id, when: "1h", note: "before the archive" }).status).toBe("pending");
  env.workers.archive(workerId);
  expect(() => alarms.schedule({ threadId: worker.id, when: "1h", note: "after the archive" })).toThrow("archived");
  const rows = env.store.db.prepare("select note from agent_alarms where thread_id = ? order by created_at").all(worker.id) as Array<{ note: string }>;
  expect(rows.map((row) => row.note)).toEqual(["before the archive"]);
});
