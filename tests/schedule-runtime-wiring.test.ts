import { expect, test } from "bun:test";
import * as fs from "node:fs";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { freshStoresEnv, seedProject, seedWorker, withTempDataDir } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { testShellRunner } from "./helpers/shell-runner.js";
import { tempDir } from "./helpers/temp.js";
import { waitUntil } from "./helpers/wait.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { allMessages } from "./helpers/thread-messages.js";
import type { ScheduleClock, ScheduleRunResult, ScheduleRunner } from "../src/server/modules/schedules/schedule-manager.js";
import { ScheduleStore } from "../src/server/modules/schedules/schedule-store.js";
import { threadNotesDir } from "../src/server/platform/fs/resources.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";
import { SSE_EVENTS } from "../src/shared/api-contracts.js";
import { stub } from "./helpers/typed.js";

const QUIET = '{"wake":false}';

function setup(over: { model?: boolean; disabled?: boolean; gate?: Promise<void> | ((threadId: string) => Promise<void> | null) } = {}) {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-sched-wiring-");
  let now = Date.parse("2026-11-04T08:20:00.000Z");
  const clock: ScheduleClock = {
    now: () => now, setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {}
  };
  let script: () => Partial<ScheduleRunResult> | Promise<Partial<ScheduleRunResult>> = () => ({ stdout: QUIET });
  const scheduleRunner: ScheduleRunner = {
    run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false, ...(await script()) })
  };
  const events: Array<{ event: string; data: unknown }> = [];
  const changed: string[] = [];
  const runtime = testAgentRuntime(env, {
    scheduleRunner, scheduleClock: clock,
    sse: stub<AgentSseEmitter>({ emit: (event, data) => { events.push({ event, data }); }, addSink: () => () => {} }),
    onScheduleChanged: (threadId) => { changed.push(threadId); },
    ...(over.disabled ? { schedulesDisabled: true } : {}),
    commandRunner: testShellRunner(tempDir("shell-home-")),
    ...(over.model ? { ready: Promise.resolve() } : {})
  });
  if (over.model) {
    // Every turn answers in one line, so rounds end and what queued behind them starts.
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    deps.llmForThread = (threadId) => {
      const model = createMockLLM(Array.from({ length: 4 }, () => ({ text: "Noted.", finishReason: "stop" as const })));
      const stream = model.doStream.bind(model);
      // A test may hold a turn open until it says so.
      model.doStream = async (options: Parameters<typeof stream>[0]) => {
        const gate = typeof over.gate === "function" ? over.gate(threadId) : over.gate;
        if (gate) await gate;
        return stream(options);
      };
      return { model };
    };
    deps.llmCallRecorder = undefined;
    deps.buildRuntimeContext = () => null;
    deps.buildInitialContext = () => null;
    deps.beforeModelCallHook = undefined;
    deps.supportsInputForThread = () => true;
    deps.supportsToolResultImagesForThread = () => true;
  }
  const close = () => { runtime.dispose(); data.restore(); };
  return { env, runtime, events, changed, close, script: (fn: typeof script) => { script = fn; }, advance: (ms: number) => { now += ms; } };
}

function wakeReasons(env: ReturnType<typeof freshStoresEnv>, threadId: string): string[] {
  return (env.store.db.prepare("select reason from agent_wakes where thread_id = ? order by rowid").all(threadId) as Array<{ reason: string }>).map((r) => r.reason);
}

test("a schedule's duty thread opens with its brief and its notes folder", async () => {
  const s = setup();
  try {
    const made = await s.runtime.schedules.create({ name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "Watch the greenhouse.", thread: { newTitle: "greenhouse watch" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    expect(s.env.agentStore.getThreadById(threadId)!.title).toBe("greenhouse watch");
    const first = allMessages(s.env.agentStore, threadId)[0]!;
    expect(first.content).toMatchObject({ type: "text", text: "Watch the greenhouse.", relay: { by: "personal" } });
    // Its notes are the thread's own folder, as any thread's.
    expect(fs.existsSync(threadNotesDir(threadId))).toBe(true);
    expect(s.runtime.scheduleStore.dutyThread(threadId)).toMatchObject({ level: "investigate", notesDir: threadNotesDir(threadId) });
  } finally { s.close(); }
});

test("a schedule wake held behind the brief's round reaches the duty thread when it ends", async () => {
  const s = setup({ model: true });
  try {
    const made = await s.runtime.schedules.create({ name: "q", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    s.script(() => ({ stdout: '{"wake":true,"message":"found it"}' }));
    s.advance(5 * 60_000);
    // The brief's round may still hold the thread: the wake waits behind it.
    await s.runtime.schedules.runNow(made.schedule.id);
    await waitUntil(() => wakeReasons(s.env, threadId).includes("schedule"), { timeout: 4000, label: "the schedule wake" });
    expect(allMessages(s.env.agentStore, threadId).some((m) => m.source === "schedule")).toBe(true);
    expect(wakeReasons(s.env, threadId)).toContain("schedule");
  } finally { s.close(); }
});

test("archive mid-run pauses and discards, and tells the personal agent once", async () => {
  const s = setup();
  try {
    const made = await s.runtime.schedules.create({ name: "q", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    let release!: (r: Partial<ScheduleRunResult>) => void;
    s.script(() => new Promise((r) => { release = r; }));
    s.advance(5 * 60_000);
    const running = s.runtime.schedules.runNow(made.schedule.id);
    await Bun.sleep(0);
    s.runtime.releaseThreadResources(threadId);
    release({ stdout: '{"wake":true}' });
    await running;
    expect(allMessages(s.env.agentStore, threadId).some((m) => m.source === "schedule")).toBe(false);
    expect(s.runtime.scheduleStore.get(made.schedule.id)).toMatchObject({ status: "paused", pausedReason: "thread archived" });
    const personal = s.env.agentStore.getOrCreatePersonalThread();
    const told = s.env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'schedule'").all(personal.id) as Array<{ content: string }>;
    const texts = [...told.map((t) => t.content), ...allMessages(s.env.agentStore, personal.id).filter((m) => m.source === "schedule").map((m) => JSON.stringify(m.content))];
    expect(texts.filter((t) => t.includes("archived duty thread"))).toHaveLength(1);
  } finally { s.close(); }
});

test("a pause on the On duty page reaches the personal agent as a note, and wakes nothing", async () => {
  const s = setup();
  try {
    const made = await s.runtime.schedules.create({ name: "greenhouse daily check", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const personal = s.env.agentStore.getOrCreatePersonalThread();
    const wakesBefore = wakeReasons(s.env, personal.id).length;
    expect(s.runtime.schedules.ownerPause(made.schedule.id)).toMatchObject({ schedule: { status: "paused" } });
    await Bun.sleep(0);
    const note = '[Schedule] The user paused "greenhouse daily check" from the On duty page.';
    const mail = s.env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'schedule'").all(personal.id) as Array<{ content: string }>;
    const texts = [...mail.map((m) => m.content), ...allMessages(s.env.agentStore, personal.id).map((m) => JSON.stringify(m.content))];
    expect(texts.some((t) => t.includes(note.replace(/"/g, '\\"')) || t.includes(note))).toBe(true);
    expect(wakeReasons(s.env, personal.id).length).toBe(wakesBefore);
  } finally { s.close(); }
});

// A new schedule an older version was still testing at a restart has no
// thread: it is opened once the runtime is up, and the first run follows.
test("a schedule an older version was testing at a restart gets its duty thread and its first run, without breaking the start", async () => {
  const data = withTempDataDir();
  const env = freshStoresEnv("md-sched-restart-");
  try {
    const store = new ScheduleStore(env.store.db);
    const at = "2026-11-04T08:20:00.000Z";
    const row = store.insert({ threadId: "", name: "half made", cron: "0 9 * * *", timezone: "UTC", checkScript: "c", checkTimeoutMs: 60_000, brief: "Watch it.", status: "active", nextDueAt: null }, at);
    env.store.db.prepare("update agent_schedules set status = 'testing', test_started_at = ?, pending_check_json = ? where id = ?")
      .run(at, JSON.stringify({ kind: "create", target: { newTitle: "half made watch" }, level: null }), row.id);
    const runtime = testAgentRuntime(env, {
      scheduleRunner: { run: async () => ({ stdout: QUIET, stderr: "", exitCode: 0, timedOut: false }) },
      scheduleClock: { now: () => Date.parse("2026-11-04T08:30:00.000Z"), setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
      commandRunner: testShellRunner(tempDir("shell-home-"))
    });
    try {
      const threadId = await waitUntil(() => store.get(row.id)?.threadId || null, { timeout: 2000, label: "its duty thread" });
      expect(env.agentStore.getThreadById(threadId)!.title).toBe("half made watch");
      await runtime.schedules.settled();
      expect(store.get(row.id)).toMatchObject({ status: "active", lastOutcome: "test", firstRunPendingSince: null });
      const personal = env.agentStore.getOrCreatePersonalThread();
      const mail = env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'schedule'").all(personal.id) as Array<{ content: string }>;
      expect(mail.map((m) => (JSON.parse(m.content) as { text: string }).text).join("\n")).toContain('"half made" ran its first check and is active.');
    } finally { runtime.dispose(); }
  } finally { data.restore(); }
});

test("a duty round woken by its schedule reaches the personal agent as its report", async () => {
  const s = setup({ model: true });
  try {
    const made = await s.runtime.schedules.create({ name: "q", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    const personal = s.env.agentStore.getOrCreatePersonalThread();
    // The brief's round answers the personal agent's wait (while a wait is open, it
    // carries the reply itself); once it has, the schedule's round reports.
    await waitUntil(() => s.runtime.handoffs.waitsOn(threadId) === 0 && !s.runtime.threadActivity.isBusy(threadId), { timeout: 4000, label: "the brief's round" });
    s.script(() => ({ stdout: '{"wake":true,"message":"found it"}' }));
    s.advance(5 * 60_000);
    await s.runtime.schedules.runNow(made.schedule.id);
    const republished = () => s.changed.filter((id) => id === threadId).length;
    const beforeReport = republished();
    const reported = () => {
      const mail = (s.env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'thread-notice'").all(personal.id) as Array<{ content: string }>)
        .map((m) => (JSON.parse(m.content) as { text: string }).text);
      const messages = s.env.agentStore.getActiveMessages(personal.id).filter((m) => m.source === "thread-notice").map((m) => (m.content as { text: string }).text);
      // Mail stays in the mailbox after it is delivered: one notice, counted once.
      return [...new Set([...mail, ...messages])].filter((t) => t.startsWith(`[Thread notice] Duty thread "t" (${threadId}): reports.`));
    };
    await waitUntil(() => reported().length > 0, { timeout: 4000, label: "the duty report" });
    expect(reported()).toHaveLength(1);
    const marks = s.runtime.scheduleStore.reportsFor(allMessages(s.env.agentStore, threadId).map((m) => m.id));
    expect([...marks.values()].sort()).toEqual(["sent", "told_by_wait"]);
    // Each one recorded is announced, so an open chat marks it as it happens.
    const announced = s.events.filter((e) => e.event === SSE_EVENTS.dutyReportRecorded).map((e) => e.data as { threadId: string; messageId: string; outcome: string });
    expect(announced.map((e) => [e.threadId, e.outcome]).sort()).toEqual([[threadId, "sent"], [threadId, "told_by_wait"]]);
    expect(announced.every((e) => marks.get(e.messageId) === e.outcome)).toBe(true);
    // Its row is published again: the page sees the report waiting unread.
    expect(republished()).toBeGreaterThan(beforeReport);
  } finally { s.close(); }
});

test("the owner's own round is told before a schedule wake queued behind it starts", async () => {
  let held: Promise<void> | null = null;
  const s = setup({ model: true, gate: () => held });
  try {
    const made = await s.runtime.schedules.create({ name: "q", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    await waitUntil(() => s.runtime.handoffs.waitsOn(threadId) === 0 && !s.runtime.threadActivity.isBusy(threadId), { timeout: 4000, label: "the brief's round" });
    let open!: () => void;
    held = new Promise<void>((resolve) => { open = resolve; });
    s.runtime.userMessageQueue.submitThreadUserMessage({ threadId, content: "What are you keeping track of right now?", source: "user" });
    await waitUntil(() => s.runtime.threadActivity.isBusy(threadId), { timeout: 2000, label: "the owner's round" });
    s.script(() => ({ stdout: '{"wake":true,"message":"found it"}' }));
    s.advance(5 * 60_000);
    await s.runtime.schedules.runNow(made.schedule.id);
    held = null;
    open();
    const personal = s.env.agentStore.getOrCreatePersonalThread();
    const notices = () => [...new Set([
      ...(s.env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'thread-notice'").all(personal.id) as Array<{ content: string }>).map((m) => (JSON.parse(m.content) as { text: string }).text),
      ...s.env.agentStore.getActiveMessages(personal.id).filter((m) => m.source === "thread-notice").map((m) => (m.content as { text: string }).text)
    ])];
    await waitUntil(() => notices().some((t) => t.includes("): reports.")), { timeout: 4000, label: "the schedule round's report" });
    expect(notices().filter((t) => t.includes("the user wrote to it directly"))).toHaveLength(1);
  } finally { s.close(); }
});

test("a wait open on a duty round ends with that round, though a schedule wake waits behind it", async () => {
  const s = setup({ model: true });
  try {
    const made = await s.runtime.schedules.create({ name: "q", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    // Queued behind the brief's round, which the personal agent waits on.
    s.script(() => ({ stdout: '{"wake":true,"message":"found it"}' }));
    s.advance(5 * 60_000);
    await s.runtime.schedules.runNow(made.schedule.id);
    const personal = s.env.agentStore.getOrCreatePersonalThread();
    const notices = () => [...new Set([
      ...(s.env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'thread-notice'").all(personal.id) as Array<{ content: string }>).map((m) => (JSON.parse(m.content) as { text: string }).text),
      ...s.env.agentStore.getActiveMessages(personal.id).filter((m) => m.source === "thread-notice").map((m) => (m.content as { text: string }).text)
    ])];
    await waitUntil(() => notices().some((t) => t.includes("): reports.")), { timeout: 4000, label: "the schedule round's report" });
    expect(notices().filter((t) => t.startsWith(`[Thread notice] Thread "t" (${threadId}): stopped.`))).toHaveLength(1);
    const marks = s.runtime.scheduleStore.reportsFor(allMessages(s.env.agentStore, threadId).map((m) => m.id));
    expect([...marks.values()].sort()).toEqual(["sent", "told_by_wait"]);
    // Each one recorded is announced, so an open chat marks it as it happens.
    const announced = s.events.filter((e) => e.event === SSE_EVENTS.dutyReportRecorded).map((e) => e.data as { threadId: string; messageId: string; outcome: string });
    expect(announced.map((e) => [e.threadId, e.outcome]).sort()).toEqual([[threadId, "sent"], [threadId, "told_by_wait"]]);
    expect(announced.every((e) => marks.get(e.messageId) === e.outcome)).toBe(true);
  } finally { s.close(); }
});

/** A worker of the duty thread, its turn held open until the test releases it. */
async function workingWorker(s: ReturnType<typeof setup>, dutyThreadId: string, hold: (workerThreadId: string) => void): Promise<string> {
  const projectId = seedProject(s.env.projects);
  const workerId = seedWorker(s.env.workers, projectId, { ownerThreadId: dutyThreadId } as never);
  const workerThreadId = s.env.agentStore.getOrCreateThread("worker", workerId).id;
  hold(workerThreadId);
  s.runtime.userMessageQueue.submitThreadUserMessage({ threadId: workerThreadId, content: "Look into the dry bed.", source: "user" });
  await waitUntil(() => s.runtime.threadActivity.isBusy(workerThreadId), { timeout: 2000, label: "the worker's turn" });
  return workerThreadId;
}

function noticesTo(s: ReturnType<typeof setup>): string[] {
  const personal = s.env.agentStore.getOrCreatePersonalThread();
  return [...new Set([
    ...(s.env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'thread-notice'").all(personal.id) as Array<{ content: string }>).map((m) => (JSON.parse(m.content) as { text: string }).text),
    ...s.env.agentStore.getActiveMessages(personal.id).filter((m) => m.source === "thread-notice").map((m) => (m.content as { text: string }).text)
  ])];
}

test("a duty thread's reply reaches the personal agent at the end of its turn, while a worker of its still works", async () => {
  let workerThreadId = "";
  let held: Promise<void> | null = null;
  let release = () => {};
  const s = setup({ model: true, gate: (threadId) => (threadId === workerThreadId ? held : null) });
  try {
    const made = await s.runtime.schedules.create({ name: "q", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    await waitUntil(() => s.runtime.handoffs.waitsOn(threadId) === 0 && !s.runtime.threadActivity.isBusy(threadId), { timeout: 4000, label: "the brief's round" });
    await workingWorker(s, threadId, (id) => {
      workerThreadId = id;
      held = new Promise<void>((resolve) => { release = resolve; });
    });
    s.script(() => ({ stdout: '{"wake":true,"message":"found it"}' }));
    s.advance(5 * 60_000);
    await s.runtime.schedules.runNow(made.schedule.id);
    await waitUntil(() => noticesTo(s).some((t) => t.startsWith(`[Thread notice] Duty thread "t" (${threadId}): reports.`)), { timeout: 4000, label: "the duty report" });
    expect(s.runtime.threadActivity.isBusy(workerThreadId)).toBe(true);
  } finally { release(); s.close(); }
});

test("the personal agent's wait on a duty thread ends with the thread's reply, while a worker of its still works", async () => {
  let workerThreadId = "";
  let held: Promise<void> | null = null;
  let release = () => {};
  const s = setup({ model: true, gate: (threadId) => (threadId === workerThreadId ? held : null) });
  try {
    const made = await s.runtime.schedules.create({ name: "q", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    await waitUntil(() => s.runtime.handoffs.waitsOn(threadId) === 0 && !s.runtime.threadActivity.isBusy(threadId), { timeout: 4000, label: "the brief's round" });
    await workingWorker(s, threadId, (id) => {
      workerThreadId = id;
      held = new Promise<void>((resolve) => { release = resolve; });
    });
    const personal = s.env.agentStore.getOrCreatePersonalThread();
    // Counted as posted: the brief's wait ended with the same words.
    const stopped = () => (s.env.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'thread-notice'").all(personal.id) as Array<{ content: string }>)
      .map((m) => (JSON.parse(m.content) as { text: string }).text)
      .filter((t) => t.startsWith(`[Thread notice] Thread "t" (${threadId}): stopped.`));
    const before = stopped().length;
    s.runtime.handoffs.sendToThread({ personalThreadId: personal.id, threadId, text: "What changed since the last check?", spoken: false });
    await waitUntil(() => s.runtime.handoffs.waitsOn(threadId) === 0, { timeout: 4000, label: "the wait's end" });
    expect(s.runtime.threadActivity.isBusy(workerThreadId)).toBe(true);
    // Its notice carries the reply; the reply is told by it alone.
    expect(stopped()).toHaveLength(before + 1);
    expect(stopped().at(-1)).toContain("Noted.");
    const marks = s.runtime.scheduleStore.reportsFor(allMessages(s.env.agentStore, threadId).map((m) => m.id));
    expect([...marks.values()].filter((o) => o === "sent")).toEqual([]);
  } finally { release(); s.close(); }
});

test("a schedule change announces its duty thread, whose summary reads the change", async () => {
  const s = setup();
  try {
    const made = await s.runtime.schedules.create({ name: "q", cron: "0 9 * * *", timezone: "UTC", check: "c", brief: "b", thread: { newTitle: "t" } });
    if (!("schedule" in made)) throw new Error(JSON.stringify(made));
    await s.runtime.schedules.settled();
    const threadId = made.schedule.threadId;
    expect(s.changed).toContain(threadId);
    const before = s.changed.length;
    s.runtime.schedules.pause({ id: made.schedule.id }, "the user");
    expect(s.changed.length).toBeGreaterThan(before);
    expect(s.runtime.dutySummary(threadId)).toMatchObject({ schedulesOff: false, schedules: [{ id: made.schedule.id, status: "paused" }] });
    const ordinary = s.env.agentStore.createManagerThread("Release 3.21");
    expect(s.runtime.dutySummary(ordinary.id)).toBeNull();
  } finally { s.close(); }
});

test("with the switch on, a duty thread's summary says schedules are off", () => {
  const s = setup({ disabled: true });
  try {
    const thread = s.env.agentStore.createManagerThread("t");
    const at = "2026-11-04T08:20:00.000Z";
    const row = s.runtime.scheduleStore.insert({ threadId: thread.id, name: "q", cron: "0 9 * * *", timezone: "UTC", checkScript: "c", checkTimeoutMs: 60_000, brief: "b", status: "active", nextDueAt: "2026-11-05T09:00:00.000Z" }, at);
    s.runtime.scheduleStore.ensureDutyThread(thread.id, "investigate", threadNotesDir(thread.id), at);
    expect(s.runtime.dutySummary(thread.id)).toMatchObject({ schedulesOff: true, schedules: [{ id: row.id }] });
  } finally { s.close(); }
});
