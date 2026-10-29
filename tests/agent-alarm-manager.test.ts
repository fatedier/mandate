import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import {
  AgentAlarmManager,
  type AgentAlarmTimerHandle,
  type AgentAlarmTimers
} from "../src/server/modules/agent/agent-alarm-manager.js";
import { buildAlarmTools } from "../src/server/modules/agent/tools/alarm-tools.js";
import { mailboxWakeReason } from "../src/server/runtime/mailbox-wake-reason.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { stub, toolContext } from "./helpers/typed.js";

interface FakeAlarmTimerHandle {
  callback: () => void;
  fireAt: number;
  ms: number;
  cleared: boolean;
}

class FakeAlarmTimers implements AgentAlarmTimers {
  nowMs = Date.parse("2026-05-15T00:00:00.000Z");
  handles: FakeAlarmTimerHandle[] = [];

  now() {
    return this.nowMs;
  }

  setTimeout(callback: () => void, ms: number): AgentAlarmTimerHandle {
    const handle = { callback, fireAt: this.nowMs + ms, ms, cleared: false };
    this.handles.push(handle);
    return handle;
  }

  clearTimeout(timer: AgentAlarmTimerHandle): void {
    (timer as FakeAlarmTimerHandle).cleared = true;
  }

  advance(ms: number): void {
    this.nowMs += ms;
    this.fireDueTimers();
  }

  private fireDueTimers(): void {
    while (true) {
      const next = this.handles
        .filter((handle) => !handle.cleared && handle.fireAt <= this.nowMs)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!next) return;
      next.cleared = true;
      next.callback();
    }
  }
}

function setup(opts: { onPendingChanged?: (threadId: string) => void; timeZone?: string } = {}) {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  const thread = agentStore.getOrCreateThread("manager", null);
  const timers = new FakeAlarmTimers();
  const wakeCalls: Array<[string, string, string | null]> = [];
  const sseEmissions: Array<{ event: string; data: unknown }> = [];
  const manager: AgentAlarmManager = new AgentAlarmManager({
    ...(opts.onPendingChanged ? { onPendingChanged: opts.onPendingChanged } : {}),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    db,
    agentStore,
    sse: stub<AgentSseEmitter>({
      emit: (event, data) => sseEmissions.push({ event, data })
    }),
    onWake: (threadId, reason, triggerMessageId) => {
      wakeCalls.push([threadId, reason, triggerMessageId ?? null]);
      return "wake-" + wakeCalls.length;
    },
    timers
  });
  return { db, agentStore, thread, wakeCalls, sseEmissions, manager, timers };
}

test("schedule_wake by relative when persists + can be listed", () => {
  const { thread, manager, timers } = setup();
  const result = manager.schedule({
    threadId: thread.id,
    when: "60s",
    note: "follow up in 1m"
  });
  expect(result.status).toBe("pending");
  expect(result.threadId).toBe(thread.id);
  expect(result.note).toBe("follow up in 1m");
  expect(Date.parse(result.fireAt) - timers.now()).toBeGreaterThan(50_000);

  const pending = manager.list(thread.id);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.id).toBe(result.id);
  manager.dispose();
});

test("schedule_wake by absolute ISO when persists + can be listed", () => {
  const { thread, manager, timers } = setup();
  const when = new Date(timers.now() + 60_000).toISOString();
  const result = manager.schedule({
    threadId: thread.id,
    when,
    note: "follow up at a specific time"
  });
  expect(result.status).toBe("pending");
  expect(result.threadId).toBe(thread.id);
  expect(result.note).toBe("follow up at a specific time");
  expect(Date.parse(result.fireAt)).toBe(Date.parse(when));
  manager.dispose();
});

test("schedule_wake rejects too-soon and too-far times", () => {
  const { thread, manager } = setup();
  expect(() => manager.schedule({
    threadId: thread.id, when: "500ms", note: "too soon"
  })).toThrow(/at least/);
  expect(() => manager.schedule({
    threadId: thread.id, when: "31d", note: "too far"
  })).toThrow(/30 days/);
  manager.dispose();
});

test("schedule_wake tool returns only the useful scheduling fields", async () => {
  const { thread, manager, timers } = setup();
  const tool = buildAlarmTools(manager).find((candidate) => candidate.name === "schedule_wake");
  expect(tool).toBeTruthy();

  const result = await tool!.handler({
    when: "60s",
    note: "follow up"
  }, {
    threadId: thread.id,
    wakeId: "wake-test",
    scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] }
  });

  expect(Object.keys(result as Record<string, unknown>).sort()).toEqual(["alarmId", "fireAt"]);
  expect((result as { alarmId: string }).alarmId).toStartWith("alm_");
  expect(Date.parse((result as { fireAt: string }).fireAt) - timers.now()).toBeGreaterThan(50_000);
  manager.dispose();
});

test("schedule_wake points a wait-for-change at monitor", () => {
  const { manager } = setup();
  const scheduleWake = buildAlarmTools(manager).find((t) => t.name === "schedule_wake")!;
  expect(scheduleWake.description).toContain("use monitor instead of scheduling wakes to check");
  manager.dispose();
});

test("alarm list and cancel tools return compact summaries", async () => {
  const { thread, manager } = setup();
  const tools = buildAlarmTools(manager);
  const listTool = tools.find((candidate) => candidate.name === "list_my_alarms");
  const cancelTool = tools.find((candidate) => candidate.name === "cancel_alarm");
  expect(listTool).toBeTruthy();
  expect(cancelTool).toBeTruthy();
  const created = manager.schedule({
    threadId: thread.id,
    when: "60s",
    note: "compact output"
  });
  const ctx = toolContext({
    threadId: thread.id,
    wakeId: "wake-test"
  });

  const listed = await listTool!.handler({}, ctx);
  const alarm = (listed as { alarms: Array<Record<string, unknown>> }).alarms[0]!;
  expect(Object.keys(alarm).sort()).toEqual(["alarmId", "fireAt", "note", "status"]);
  expect(alarm.alarmId).toBe(created.id);

  const canceled = await cancelTool!.handler({ alarmId: created.id }, ctx);
  expect(canceled).toEqual({
    ok: true,
    alarmId: created.id,
    status: "canceled"
  });
  manager.dispose();
});

test("cancel returns null for unknown alarm ids", () => {
  const { thread, manager } = setup();
  expect(manager.cancel("alm_missing", thread.id)).toBeNull();
  manager.dispose();
});

test("fire puts the alarm's message in the thread's mailbox and wakes the thread for it", () => {
  const { thread, manager, agentStore, wakeCalls, sseEmissions, timers } = setup();
  manager.schedule({ threadId: thread.id, when: "1s", note: "wake me" });
  timers.advance(1000);
  expect(wakeCalls).toStrictEqual([[thread.id, "alarm", null]]);
  // The wake takes it in; nothing is in the conversation before that.
  expect(agentStore.getMessages(thread.id)).toEqual([]);
  expect(sseEmissions.some((e) => e.event === "agentMessageAppended")).toBe(false);
  const mail = agentStore.drainMailboxToMessages(thread.id, "wake_alarm");
  expect(mail.map((m) => [m.role, m.source, m.content.type])).toEqual([["user", "alarm", "text"]]);
  const text = (mail[0]!.content as { type: "text"; text: string }).text;
  expect(text).toContain("[Mandate alarm fired]");
  expect(text).toContain("wake me");
  manager.dispose();
});

test("a fired alarm's message says when it was set and when it fired as the agent's messages say times", () => {
  const { thread, manager, agentStore, timers } = setup({ timeZone: "Asia/Shanghai" });
  manager.schedule({ threadId: thread.id, when: "90m", note: "check the deploy" });
  timers.advance(90 * 60_000);
  const [mail] = agentStore.drainMailboxToMessages(thread.id, "wake_alarm_times");
  const text = (mail!.content as { type: "text"; text: string }).text;
  expect(text).toContain("scheduled at: Fri 2026-05-15 08:00 +08:00\nfired at: Fri 2026-05-15 09:30 +08:00");
  manager.dispose();
});

// The alarm was marked fired in its own write, then its message written:
// a message the database refused (an outside writer holding it) left an
// alarm fired with no message and no wake, gone for good.
test("an alarm whose mail the database refuses stays pending and fires again shortly", () => {
  const { db, thread, manager, agentStore, wakeCalls, timers } = setup();
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const alarm = manager.schedule({ threadId: thread.id, when: "1s", note: "wake me" });
  const real = agentStore.enqueueMailboxMessage.bind(agentStore);
  let refuse = true;
  const append = spyOn(agentStore, "enqueueMailboxMessage").mockImplementation((...args: Parameters<typeof agentStore.enqueueMailboxMessage>) => {
    if (refuse) {
      refuse = false;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
    return real(...args);
  });
  try {
    timers.advance(1000);
    const status = () => (db.prepare("select status from agent_alarms where id = ?").get(alarm.id) as { status: string }).status;
    expect(status()).toBe("pending");
    expect(wakeCalls).toStrictEqual([]);
    expect(agentStore.queuedMailboxSources(thread.id)).toEqual([]);
    timers.advance(30_000);
    expect(status()).toBe("fired");
    expect(wakeCalls.length).toBe(1);
    expect(agentStore.queuedMailboxSources(thread.id)).toEqual(["alarm"]);
  } finally {
    append.mockRestore();
    logged.mockRestore();
    manager.dispose();
  }
});

test("enforces per-thread pending limit", () => {
  const { thread, manager } = setup();
  for (let i = 0; i < 20; i++) {
    manager.schedule({ threadId: thread.id, when: `${60 + i}s`, note: `n${i}` });
  }
  expect(() => manager.schedule({
    threadId: thread.id, when: "999999ms", note: "overflow"
  })).toThrow(/too many/);
  manager.dispose();
});

test("rescheduleAllPending: pending alarms survive manager restart", async () => {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  const thread = agentStore.getOrCreateThread("manager", null);
  const timers = new FakeAlarmTimers();
  // First manager schedules then disposes (simulating server restart)
  const wakeCalls1: Array<[string, string, string | null]> = [];
  const m1 = new AgentAlarmManager({
    db, agentStore, sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (t, r, m) => { wakeCalls1.push([t, r, m ?? null]); return "w"; },
    timers
  });
  m1.schedule({ threadId: thread.id, when: "1500ms", note: "survive" });
  m1.dispose();

  // Second manager picks up the pending row without rescheduling.
  const wakeCalls2: Array<[string, string, string | null]> = [];
  const m2 = new AgentAlarmManager({
    db, agentStore, sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (t, r, msg) => { wakeCalls2.push([t, r, msg ?? null]); return "w"; },
    timers
  });
  timers.advance(1500);
  expect(wakeCalls1).toHaveLength(0);
  expect(wakeCalls2.length).toBeGreaterThanOrEqual(1);
  expect(wakeCalls2[0]![1]).toBe("alarm");
  m2.dispose();
});

// Its message written, then its wake's row refused (an outside writer holding
// the database): the throw escaped the timer and, the alarm being fired,
// nothing woke the thread for it. Tried again as a busy thread's wake is.
test("an alarm whose wake the database refuses is woken for its one mail when tried again", () => {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  const thread = agentStore.getOrCreateThread("manager", null);
  const timers = new FakeAlarmTimers();
  let refuse = true;
  const wakes: Array<string | null> = [];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const manager = new AgentAlarmManager({
    db, agentStore, sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (_threadId, _reason, messageId) => {
      if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
      wakes.push(messageId ?? null);
      return "wake-1";
    },
    timers
  });
  try {
    const alarm = manager.schedule({ threadId: thread.id, when: "1s", note: "wake me" });
    expect(() => timers.advance(1000)).not.toThrow();
    expect(agentStore.queuedMailboxSources(thread.id)).toEqual(["alarm"]);
    expect(wakes).toStrictEqual([]);
    // Its wake still to come: the thread still waits on it meanwhile.
    expect(manager.listWaitedOn(thread.id).map((a) => a.id)).toEqual([alarm.id]);
    expect(manager.threadIds()).toEqual([thread.id]);
    timers.advance(1000);
    expect(wakes).toStrictEqual([null]);
    // One mail, written once.
    expect(agentStore.drainMailboxToMessages(thread.id, "wake_alarm")).toHaveLength(1);
    expect(manager.listWaitedOn(thread.id)).toEqual([]);
  } finally {
    logged.mockRestore();
    manager.dispose();
  }
});

test("an alarm wake tried again after a refusal does not run once the manager is disposed", () => {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  const thread = agentStore.getOrCreateThread("manager", null);
  const timers = new FakeAlarmTimers();
  let calls = 0;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const manager = new AgentAlarmManager({
    db, agentStore, sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: () => { calls++; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); },
    timers
  });
  try {
    manager.schedule({ threadId: thread.id, when: "1s", note: "wake me" });
    timers.advance(1000);
    expect(calls).toBe(1);
    manager.dispose();
    timers.advance(5000);
    expect(calls).toBe(1);
  } finally {
    logged.mockRestore();
  }
});

test("an alarm says its thread's waiting changed when it is scheduled, fires, is cancelled or goes with its thread; the threads it waits on are listed", () => {
  const told: string[] = [];
  let manager!: AgentAlarmManager;
  const t = setup({ onPendingChanged: (threadId) => told.push(`${threadId}:${manager.list(threadId).length}`) });
  manager = t.manager;
  const { thread, timers, agentStore } = t;
  const first = manager.schedule({ threadId: thread.id, when: "10m", note: "check the deploy" });
  manager.schedule({ threadId: thread.id, when: "20m", note: "check again" });
  expect(told).toStrictEqual([`${thread.id}:1`, `${thread.id}:2`]);
  expect(manager.threadIds()).toEqual([thread.id]);
  // It fires: told once its wake was asked for, with one alarm left.
  timers.advance(10 * 60_000 + 1);
  expect(told.at(-1)).toBe(`${thread.id}:1`);
  expect(t.wakeCalls).toHaveLength(1);
  // Cancelling one that already fired tells nothing.
  manager.cancel(first.id, thread.id);
  expect(told).toHaveLength(3);
  const other = agentStore.createManagerThread("Other");
  const third = manager.schedule({ threadId: other.id, when: "5m", note: "x" });
  manager.cancel(third.id, other.id);
  expect(told.slice(-2)).toStrictEqual([`${other.id}:1`, `${other.id}:0`]);
  expect(manager.cancelThread(thread.id)).toBe(1);
  expect(told.at(-1)).toBe(`${thread.id}:0`);
  // A thread with nothing pending tells nothing when cancelled.
  manager.cancelThread(thread.id);
  expect(told).toHaveLength(6);
  expect(manager.threadIds()).toEqual([]);
});

test("an alarm due on an archived thread is cancelled, and its thread is told it waits on nothing", () => {
  const told: string[] = [];
  let manager!: AgentAlarmManager;
  const t = setup({ onPendingChanged: (threadId) => told.push(`${threadId}:${manager.list(threadId).length}`) });
  manager = t.manager;
  const other = t.agentStore.createManagerThread("Archived soon");
  manager.schedule({ threadId: other.id, when: "10m", note: "x" });
  t.db.prepare("update agent_threads set archived_at = ? where id = ?").run(new Date().toISOString(), other.id);
  t.timers.advance(10 * 60_000 + 1);
  expect([told.at(-1), t.wakeCalls.length]).toEqual([`${other.id}:0`, 0]);
});

test("an alarm whose wake is refused every time is waited on until it gives up, then says so, again until that is heard", () => {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  const thread = agentStore.getOrCreateThread("manager", null);
  const timers = new FakeAlarmTimers();
  const abandoned: string[] = [];
  const told: string[] = [];
  let refuseAbandon = true;
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const manager: AgentAlarmManager = new AgentAlarmManager({
    db, agentStore, sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: () => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); },
    onPendingChanged: (threadId) => told.push(`${threadId}:${manager.listWaitedOn(threadId).length}`),
    // Judging the thread's waits writes too: refused once, it is tried again.
    onWakeAbandoned: (threadId) => {
      if (refuseAbandon) { refuseAbandon = false; throw new Error("database is locked"); }
      abandoned.push(threadId);
    },
    timers
  });
  try {
    manager.schedule({ threadId: thread.id, when: "1s", note: "wake me" });
    timers.advance(1000);
    expect([manager.listWaitedOn(thread.id).length, abandoned]).toEqual([1, []]);
    for (let i = 0; i < 20; i++) timers.advance(1000);
    expect([manager.listWaitedOn(thread.id).length, told.at(-1), abandoned]).toEqual([0, `${thread.id}:0`, []]);
    timers.advance(30_000);
    expect(abandoned).toStrictEqual([thread.id]);
  } finally {
    logged.mockRestore();
    manager.dispose();
  }
});

test("a thread cancelled while its fired alarm's wake is tried again waits on it no more, and the tries stop", () => {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  const thread = agentStore.getOrCreateThread("manager", null);
  const timers = new FakeAlarmTimers();
  let tries = 0;
  const told: string[] = [];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  const manager: AgentAlarmManager = new AgentAlarmManager({
    db, agentStore, sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: () => { tries += 1; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); },
    onPendingChanged: (threadId) => told.push(`${threadId}:${manager.listWaitedOn(threadId).length}`),
    timers
  });
  try {
    manager.schedule({ threadId: thread.id, when: "1s", note: "wake me" });
    timers.advance(1000);
    expect(tries).toBe(1);
    manager.cancelThread(thread.id);
    expect([manager.listWaitedOn(thread.id), manager.threadIds(), told.at(-1)]).toEqual([[], [], `${thread.id}:0`]);
    for (let i = 0; i < 5; i++) timers.advance(1000);
    expect(tries).toBe(1);
  } finally {
    logged.mockRestore();
    manager.dispose();
  }
});

// A wake asked for while the thread's turn runs was tried ten times, a second
// apart, then given up: an alarm that landed during a turn's last model call,
// or a compaction, never woke anyone. It waits in the mailbox instead: the
// running turn takes it in at its next step, or the thread's release wakes
// for it, however long the turn runs.
test("an alarm that fires while its thread is busy waits in its mailbox, with no tries against the busy thread", () => {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  const thread = agentStore.getOrCreateThread("manager", null);
  const timers = new FakeAlarmTimers();
  const wakes: Array<[string, string | null]> = [];
  const manager = new AgentAlarmManager({
    db, agentStore, sse: stub<AgentSseEmitter>({ emit: () => {} }),
    onWake: (_threadId, reason, messageId) => { wakes.push([reason, messageId ?? null]); return null; },
    isThreadBusy: () => true,
    timers
  });
  try {
    manager.schedule({ threadId: thread.id, when: "1s", note: "check the deploy" });
    timers.advance(1000);
    expect(wakes).toStrictEqual([["alarm", null]]);
    expect(agentStore.queuedMailboxSources(thread.id)).toEqual(["alarm"]);
    // Not waited on any more: the running turn or the release takes it.
    expect(manager.listWaitedOn(thread.id)).toEqual([]);
    timers.advance(60_000);
    expect(wakes).toHaveLength(1);
    expect(agentStore.queuedMailboxSources(thread.id)).toEqual(["alarm"]);
    expect(agentStore.getMessages(thread.id)).toEqual([]);
    // Woken for, it is an alarm's wake.
    expect(mailboxWakeReason(agentStore.queuedMailboxSources(thread.id))).toBe("alarm");
  } finally {
    manager.dispose();
  }
});
