import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import {
  AgentAlarmManager,
  type AgentAlarmTimerHandle,
  type AgentAlarmTimers
} from "../src/server/modules/agent/agent-alarm-manager.js";
import { buildAlarmTools } from "../src/server/modules/agent/tools/alarm-tools.js";

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

function setup() {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  const thread = agentStore.getOrCreateThread("manager", null);
  const timers = new FakeAlarmTimers();
  const wakeCalls: Array<[string, string, string | null]> = [];
  const sseEmissions: Array<{ event: string; data: unknown }> = [];
  const manager = new AgentAlarmManager({
    db,
    agentStore,
    sse: {
      emit: (event, data) => sseEmissions.push({ event, data })
    } as any,
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
  const ctx = {
    threadId: thread.id,
    wakeId: "wake-test",
    scope: { kind: "manager", managerDir: "", projectWorkingDirs: [] }
  } as any;

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

test("cancel removes a pending alarm", () => {
  const { thread, manager } = setup();
  const created = manager.schedule({
    threadId: thread.id, when: "60s", note: "test"
  });
  const canceled = manager.cancel(created.id, thread.id);
  expect(canceled?.status).toBe("canceled");
  expect(manager.list(thread.id)).toHaveLength(0);
  manager.dispose();
});

test("cancel returns null for unknown alarm ids", () => {
  const { thread, manager } = setup();
  expect(manager.cancel("alm_missing", thread.id)).toBeNull();
  manager.dispose();
});

test("fire wakes the thread and appends a user message", async () => {
  const { thread, manager, agentStore, wakeCalls, sseEmissions, timers } = setup();
  manager.schedule({ threadId: thread.id, when: "1s", note: "wake me" });
  timers.advance(1000);
  expect(wakeCalls.length).toBe(1);
  expect(wakeCalls[0]![0]).toBe(thread.id);
  expect(wakeCalls[0]![1]).toBe("alarm");

  const messages = agentStore.getMessages(thread.id);
  const last = messages[messages.length - 1];
  expect(last?.role).toBe("user");
  expect((last?.content as { type: string }).type).toBe("text");
  const text = (last?.content as { type: "text"; text: string }).text;
  expect(text).toContain("[Mandate alarm fired]");
  expect(text).toContain("wake me");

  expect(sseEmissions.some((e) => e.event === "agentMessageAppended")).toBe(true);
  manager.dispose();
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
    db, agentStore, sse: { emit: () => {} } as any,
    onWake: (t, r, m) => { wakeCalls1.push([t, r, m ?? null]); return "w"; },
    timers
  });
  m1.schedule({ threadId: thread.id, when: "1500ms", note: "survive" });
  m1.dispose();

  // Second manager picks up the pending row without rescheduling.
  const wakeCalls2: Array<[string, string, string | null]> = [];
  const m2 = new AgentAlarmManager({
    db, agentStore, sse: { emit: () => {} } as any,
    onWake: (t, r, msg) => { wakeCalls2.push([t, r, msg ?? null]); return "w"; },
    timers
  });
  timers.advance(1500);
  expect(wakeCalls1).toHaveLength(0);
  expect(wakeCalls2.length).toBeGreaterThanOrEqual(1);
  expect(wakeCalls2[0]![1]).toBe("alarm");
  m2.dispose();
});
