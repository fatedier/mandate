import { expect, test } from "bun:test";
import { MandateStore } from "../src/server/app/store.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { WakeLock } from "../src/server/modules/agent/wake-lock.js";
import { REPEAT_NUDGE_TEXT, repeatStopText } from "../src/server/modules/agent/repeat-failures.js";
import { createTestWakeScheduler } from "./helpers/wake-scheduler.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { onCleanup } from "./helpers/cleanup.js";
import { tempDir } from "./helpers/temp.js";
import type { AgentScope } from "../src/server/modules/agent/tool-scope.js";
import type { ToolDispatcher } from "../src/server/modules/agent/wake-loop.js";

// Stop 1: the same tool failing the same way. The third failure tells the
// model; the fifth ends the wake `stuck` and tells it why. A worker's
// conversation then waits for someone above it: a person, or its manager.
// The global agent's and a manager's do not wait at all:
// what happens next wakes them, as it would have.

function fresh() {
  const store = new MandateStore(tempDir("md-stuck-"));
  onCleanup(() => store.db.close());
  return { agentStore: new AgentStore(store.db) };
}
const STUB_SCOPE = (_t: string): AgentScope => ({ kind: "worker", feature: { workingDir: "/tmp/stub" }, project: { workingDir: "/tmp/stub" } });
// Every spawn_pane fails the same way; everything else succeeds.
const DISPATCH: ToolDispatcher = {
  registry: { tools: {} },
  dispatch: async (call: { toolName: string }) => call.toolName === "spawn_pane"
    ? { isError: true, error: "can't find window" }
    : { result: "ok" }
};
const spawnTurn = (n: number) => ({ toolCalls: [{ toolCallId: `c${n}`, toolName: "spawn_pane", args: { cwd: "/w" } }], finishReason: "tool-calls" as const });

function scheduler(agentStore: AgentStore, turns: Parameters<typeof createMockLLM>[0], events: Array<{ name: string; data: any }> = []) {
  return createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => DISPATCH,
    llmModel: createMockLLM(turns),
    sse: { emit: (name, data) => events.push({ name, data }) },
    buildToolScope: STUB_SCOPE
  });
}

test("the same failure five times ends the wake stuck, with the reason in its row; the third was nudged", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-a");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const events: Array<{ name: string; data: any }> = [];
  const { wakeAndWait } = scheduler(agentStore, [1, 2, 3, 4, 5].map(spawnTurn), events);
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("stuck");
  const rows = agentStore.getMessages(thread.id);
  const results = rows.filter((m) => m.content.type === "tool_result").map((m) => (m.content as { error?: string }).error ?? "");
  expect(results).toHaveLength(5);
  expect(results.map((e) => e.includes(REPEAT_NUDGE_TEXT))).toEqual([false, false, true, false, false]);
  // The fifth says what happens to such a turn and what to do instead, ahead
  // of the error (a long error is cut for the model from its end).
  expect(results.map((e) => e.startsWith(repeatStopText(5)))).toEqual([false, false, false, false, true]);
  expect(repeatStopText(5)).toContain("failed 5 times in a row");
  expect(repeatStopText(5)).toContain("Do not make this call again");
  expect(rows.at(-1)).toMatchObject({
    role: "system", source: "wake-failure", wakeId,
    content: { type: "wake_failure", status: "stuck", message: "spawn_pane failed 5 times in a row: can't find window" }
  });
  const finished = events.find((e) => e.name === "agentWakeFinished")!;
  expect(finished.data.status).toBe("stuck");
  expect(Object.keys(finished.data).sort()).toEqual(["contextUsage", "errorMessage", "scope", "scopeId", "status", "stepCount", "threadId", "wakeId"]);
});

test("a stuck thread refuses an alarm wake but accepts a person's, which starts a new streak", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-b");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  // After the person's message the model fails once more: a fresh streak
  // (count 1), not the old one's sixth.
  const { wakeAndWait, scheduler: s } = scheduler(agentStore, [...[1, 2, 3, 4, 5, 6].map(spawnTurn), { text: "Trying another way.", finishReason: "stop" }]);
  await wakeAndWait(thread.id, "user", ask.id);
  const alarm = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "alarm", content: { type: "text", text: "[Mandate alarm fired]" } });
  expect(s.wake(thread.id, "alarm", alarm.id)).toBeNull();
  expect(agentStore.getMessageById(alarm.id)).not.toBeNull();
  const again = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Continue" } });
  const next = await wakeAndWait(thread.id, "user", again.id);
  expect(agentStore.getWakeById(next)?.status).toBe("finished");
});

// The two conversations that follow other agents' work. Stopped for good,
// each was a dead end: the global agent heard of no thread it followed and
// kept none of the times it had set, and a manager's workers reported to
// nobody. Nobody stands above the global agent but the user, so it has to be
// able to recover by itself.
for (const who of ["global", "manager"] as const) {
  test(`the ${who} conversation, stopped for a repeated failing call, is woken by what happens next`, async () => {
    const { agentStore } = fresh();
    const thread = who === "global" ? agentStore.getOrCreateGlobalThread() : agentStore.createManagerThread("release");
    const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
    const { wakeAndWait } = scheduler(agentStore, [
      ...[1, 2, 3, 4, 5].map(spawnTurn),
      { text: "Looked again: it is done.", finishReason: "stop" },
      { text: "Read the report.", finishReason: "stop" }
    ]);
    const stopped = await wakeAndWait(thread.id, "user", ask.id);
    expect(agentStore.getWakeById(stopped)?.status).toBe("stuck");
    // A time it set for itself.
    const alarm = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "alarm", content: { type: "text", text: "[Mandate alarm fired]" } });
    const looked = await wakeAndWait(thread.id, "alarm", alarm.id);
    expect(agentStore.getWakeById(looked)?.status).toBe("finished");
    // Mail with no message of its own to point at: a thread's notice, a worker's report.
    const told = await wakeAndWait(thread.id, who === "global" ? "thread-notice" : "worker-report", null);
    expect(agentStore.getWakeById(told)?.status).toBe("finished");
  });
}

test("woken again and making the same call, the turn ends at that step: the streak is not forgotten", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateGlobalThread();
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const llm = createMockLLM([...[1, 2, 3, 4, 5, 6].map(spawnTurn), { text: "never asked for", finishReason: "stop" }]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => DISPATCH,
    llmModel: llm, sse: { emit: () => {} }, buildToolScope: STUB_SCOPE
  });
  await wakeAndWait(thread.id, "user", ask.id);
  expect(llm.calls).toHaveLength(5);
  const alarm = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "alarm", content: { type: "text", text: "[Mandate alarm fired]" } });
  const again = await wakeAndWait(thread.id, "alarm", alarm.id);
  // One step, and no more: the sixth failure in a row.
  expect(llm.calls).toHaveLength(6);
  expect(agentStore.getWakeById(again)).toMatchObject({ status: "stuck", errorMessage: "spawn_pane failed 6 times in a row: can't find window" });
  const last = agentStore.getMessages(thread.id).filter((m) => m.content.type === "tool_result").at(-1)!;
  expect((last.content as { error?: string }).error?.startsWith(repeatStopText(6))).toBe(true);
});

// A worker that stops reports "stopped" to its manager, whose prompt told it
// to nudge the worker on. The message went into the worker's mail, the wake
// was refused, and the tool answered "queued": the manager believed it had
// been heard and the worker never read it.
// Its manager's message wakes it. The alarms and watches it set itself do
// not: those were the loops.
function workerScheduler(agentStore: AgentStore, turns: Parameters<typeof createMockLLM>[0]) {
  const llm = createMockLLM(turns);
  const made = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => DISPATCH,
    llmModel: llm, sse: { emit: () => {} }, buildToolScope: STUB_SCOPE,
    // As the runtime does: mail is read when the wake starts.
    preWakeHook: (threadId, info) => { agentStore.drainMailboxToMessages(threadId, info.wakeId); }
  });
  return { ...made, llm };
}
/** What feature_message_send does: the message into the worker's mail, then a wake with no message of its own. */
function managerWrites(agentStore: AgentStore, workerThreadId: string, text: string) {
  const manager = agentStore.createManagerThread("release");
  agentStore.enqueueMailboxMessage({ threadId: workerThreadId, role: "user", source: "manager", sourceThreadId: manager.id, content: { type: "text", text } });
}
const alarmFor = (agentStore: AgentStore, threadId: string) =>
  agentStore.appendMessage({ threadId, role: "user", source: "alarm", content: { type: "text", text: "[Mandate alarm fired]" } });

test("a stopped worker is woken for its manager's message, and reads it; its own alarm does not wake it", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-m");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const { wakeAndWait, scheduler: s } = workerScheduler(agentStore, [...[1, 2, 3, 4, 5].map(spawnTurn), { text: "Used the window that exists.", finishReason: "stop" }]);
  const stopped = await wakeAndWait(thread.id, "user", ask.id);
  expect(agentStore.getWakeById(stopped)?.status).toBe("stuck");
  expect(s.wake(thread.id, "alarm", alarmFor(agentStore, thread.id).id)).toBeNull();
  managerWrites(agentStore, thread.id, "Use the window that exists.");
  const woken = await wakeAndWait(thread.id, "user", null);
  expect(agentStore.getWakeById(woken)?.status).toBe("finished");
  // Read in that wake: it is in the conversation, and the mail is that wake's.
  expect(agentStore.getMessages(thread.id).filter((m) => m.source === "manager").map((m) => (m.content as { text?: string }).text)).toStrictEqual(["Use the window that exists."]);
  expect(agentStore.listMailboxMessagesDeliveredToWake(woken).map((m) => m.source)).toEqual(["manager"]);
});

test("woken by its manager and making the same call, a worker's turn ends at that step, and it waits again", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-n");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const { wakeAndWait, scheduler: s, llm } = workerScheduler(agentStore, [...[1, 2, 3, 4, 5, 6].map(spawnTurn), { text: "never asked for", finishReason: "stop" }]);
  await wakeAndWait(thread.id, "user", ask.id);
  managerWrites(agentStore, thread.id, "Try again.");
  const again = await wakeAndWait(thread.id, "user", null);
  // One step: the streak is not forgotten for a manager's word, as it is for a person's.
  expect(llm.calls).toHaveLength(6);
  expect(agentStore.getWakeById(again)).toMatchObject({ status: "stuck", errorMessage: "spawn_pane failed 6 times in a row: can't find window" });
  // The message was read: nothing of the manager's waits, so the stop holds again.
  expect(s.wake(thread.id, "alarm", alarmFor(agentStore, thread.id).id)).toBeNull();
  expect(s.wake(thread.id, "user", null)).toBeNull();
});

test("mail that is not its manager's does not wake a stopped worker", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-o");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const { wakeAndWait, scheduler: s } = workerScheduler(agentStore, [...[1, 2, 3, 4, 5].map(spawnTurn), { text: "never asked for", finishReason: "stop" }]);
  await wakeAndWait(thread.id, "user", ask.id);
  agentStore.enqueueMailboxMessage({ threadId: thread.id, role: "user", source: "feature-message", sourceThreadId: null, content: { type: "text", text: "a reply from elsewhere" } });
  expect(s.wake(thread.id, "user", null)).toBeNull();
});

// A subagent's result wakes the conversation that started it as a worker's
// report does: through the rules there are, with no hold of its own.
test("a worker stopped for a repeated failing call stays held for its subagent's result, as for its own alarms", () => {
  const { agentStore } = fresh();
  const worker = agentStore.getOrCreateThread("worker", "feat-a");
  const stopped = agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
  agentStore.finishWake(stopped.id, "stuck", "Stopped.");
  agentStore.enqueueMailboxMessage({
    threadId: worker.id, role: "user", source: "subagent-result",
    content: { type: "text", text: "[Subagent result] “Map the cache layer”: finished after 0s." }
  });
  const { scheduler: s } = workerScheduler(agentStore, []);
  expect(s.wake(worker.id, "subagent-result", null)).toBeNull();
});

// 206 real steps: about a second alone, past the default 5 s in a busy parallel run.
test("a wake with no cap runs past 200 steps when every call succeeds", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-c");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const turns = [
    ...Array.from({ length: 205 }, (_, i) => ({ toolCalls: [{ toolCallId: `r${i}`, toolName: "read", args: { path: `f${i}` } }], finishReason: "tool-calls" as const })),
    { text: "Done.", finishReason: "stop" as const }
  ];
  const { wakeAndWait } = scheduler(agentStore, turns);
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  expect(agentStore.getWakeById(wakeId)).toMatchObject({ status: "finished", stepCount: 206 });
}, 30_000);

test("a success later in the same step undoes the stop the fifth failure would have made", async () => {
  // Parallel calls: the fifth spawn_pane failure first, then an edit that succeeds.
  // Which one the model listed first must not decide the stop.
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-p");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const both = {
    toolCalls: [
      { toolCallId: "c5", toolName: "spawn_pane", args: { cwd: "/w" } },
      { toolCallId: "e5", toolName: "edit", args: { path: "a.ts" } }
    ],
    finishReason: "tool-calls" as const
  };
  const { wakeAndWait } = scheduler(agentStore, [...[1, 2, 3, 4].map(spawnTurn), both, { text: "Edited instead.", finishReason: "stop" }]);
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("finished");
});

test("a person's message that reaches a running wake between steps starts a new streak", async () => {
  // Queued while the wake ran, flushed into it before the fifth step (as the
  // runtime's preStepHook does): the fifth failure counts 1, not 5.
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-q");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  let steps = 0;
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => DISPATCH,
    llmModel: createMockLLM([...[1, 2, 3, 4, 5].map(spawnTurn), { text: "Using the window you named.", finishReason: "stop" }]),
    sse: { emit: () => {} },
    buildToolScope: STUB_SCOPE,
    preStepHook: (threadId) => {
      steps++;
      if (steps === 5) agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "the window is called build" } });
    }
  });
  const wakeId = await wakeAndWait(thread.id, "user", ask.id);
  expect(agentStore.getWakeById(wakeId)?.status).toBe("finished");
});

test("the nudge reaches the model even when the error is longer than the model is shown", async () => {
  const { agentStore } = fresh();
  const thread = agentStore.getOrCreateThread("worker", "feat-long");
  const ask = agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "go" } });
  const long = `validation failed: ${"field is required; ".repeat(1500)}`;
  const llm = createMockLLM([...[1, 2, 3].map(spawnTurn), { text: "Trying another way.", finishReason: "stop" }]);
  const { wakeAndWait } = createTestWakeScheduler({
    agentStore, lock: new WakeLock(),
    buildSystemPrompt: () => "stub system prompt",
    toolDispatcherForThread: () => ({ registry: { tools: {} }, dispatch: async () => ({ isError: true, error: long }) }),
    llmModel: llm, sse: { emit: () => {} }, buildToolScope: STUB_SCOPE
  });
  expect(long.length).toBeGreaterThan(25_000);
  await wakeAndWait(thread.id, "user", ask.id);
  expect(JSON.stringify(llm.calls[3]!.options.prompt)).toContain(REPEAT_NUDGE_TEXT.slice(0, 60));
});
