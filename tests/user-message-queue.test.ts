import { expect, spyOn, test } from "bun:test";
import { mentionsOf } from "../src/shared/mentions.js";
import { Hono } from "hono";
import { mountAgentsRoutes } from "../src/server/modules/agent/agents-api.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { prepareAiSdkMessages } from "../src/server/modules/agent/wake-message-adapter.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import type { ScopeRuntime } from "../src/server/runtime/scope.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { contentOf, stub } from "./helpers/typed.js";

test("AgentUserMessageQueue: idle submit appends immediately and starts one wake", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-idle-");
  const emitted: any[] = [];
  const wakes: any[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: (event, data) => emitted.push({ event, data }) },
    wakeScheduler: {
      wake: (threadId, reason, triggerMessageId) => {
        wakes.push({ threadId, reason, triggerMessageId });
        return "wake-1";
      },
      isThreadBusy: () => false
    }
  });

  const result = queue.submitUserMessage({
    scope: "worker",
    scopeId: "f1",
    content: "hello",
    clientRequestId: "local-1"
  });

  expect(result.queued).toBe(false);
  expect(result.messageId).toBeTruthy();
  expect(result.wakeId).toBe("wake-1");
  const thread = agentStore.getThreadByScope("worker", "f1")!;
  const messages = agentStore.getActiveMessages(thread.id);
  expect(messages.length).toBe(1);
  expect(messages[0]!.content).toEqual({
    type: "text",
    text: "hello",
    clientRequestId: "local-1"
  });
  expect(wakes).toStrictEqual([{
    threadId: thread.id,
    reason: "user",
    triggerMessageId: result.messageId
  }]);
  expect(emitted.map((e) => e.event)).toStrictEqual(["agentMessageAppended"]);
});

// A message written while the thread was busy waits in memory. The flush
// dropped the whole queue first: one message the database refused took
// every message after it with it.
test("AgentUserMessageQueue: a flush the database refuses part-way keeps the messages it did not write, for the next flush", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-refused-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: { wake: () => "wake-1", isThreadBusy: () => busy }
  });
  for (const text of ["first", "second", "third"]) {
    queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: text, clientRequestId: `local-${text}` });
  }
  const real = agentStore.appendMessage.bind(agentStore);
  let calls = 0;
  const append = spyOn(agentStore, "appendMessage").mockImplementation((...args: Parameters<typeof agentStore.appendMessage>) => {
    calls++;
    if (calls === 2) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return real(...args);
  });
  busy = false;
  try {
    expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
  } finally {
    append.mockRestore();
  }
  expect(queue.pendingCount(thread.id)).toBe(2);
  queue.flushIfIdle(thread.id);
  expect(agentStore.getActiveMessages(thread.id).map((m) => m.content.type === "text" ? m.content.text : "")).toEqual(["first", "second", "third"]);
  expect(queue.pendingCount(thread.id)).toBe(0);
});

// What follows a written message (a note to a worker's manager) can be
// refused too: the message is written by then and must not be written again.
test("AgentUserMessageQueue: a flush whose follow-up after a written message fails does not write that message twice", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-followup-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  let refuse = true;
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: { wake: () => "wake-1", isThreadBusy: () => busy },
    onMessageAppended: () => {
      if (!refuse) return;
      refuse = false;
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    }
  });
  for (const text of ["first", "second", "third"]) {
    queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: text, clientRequestId: `local-${text}` });
  }
  busy = false;
  expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
  expect(queue.pendingCount(thread.id)).toBe(2);
  queue.flushIfIdle(thread.id);
  expect(agentStore.getActiveMessages(thread.id).map((m) => m.content.type === "text" ? m.content.text : "")).toEqual(["first", "second", "third"]);
});

// Kept after a refused flush, the rest wait while the thread is idle; the
// next message must not jump ahead of them (an older instruction would land
// after a newer correction).
test("AgentUserMessageQueue: a message sent while messages a refused flush kept are waiting lands after them", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-order-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  const wakes: Array<string | null> = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: { wake: (_t, _r, triggerMessageId) => { wakes.push(triggerMessageId); return "wake-1"; }, isThreadBusy: () => busy }
  });
  for (const text of ["A", "B", "C"]) {
    queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: text, clientRequestId: `local-${text}` });
  }
  const real = agentStore.appendMessage.bind(agentStore);
  let calls = 0;
  const append = spyOn(agentStore, "appendMessage").mockImplementation((...args: Parameters<typeof agentStore.appendMessage>) => {
    calls++;
    if (calls === 2) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return real(...args);
  });
  busy = false;
  try {
    expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
  } finally {
    append.mockRestore();
  }
  const sent = queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: "D", clientRequestId: "local-D" });
  const texts = agentStore.getActiveMessages(thread.id).map((m) => m.content.type === "text" ? m.content.text : "");
  expect(texts).toEqual(["A", "B", "C", "D"]);
  expect(queue.pendingCount(thread.id)).toBe(0);
  expect(sent.queued).toBe(false);
  expect(wakes.at(-1)).toBe(sent.messageId);
});

test("AgentUserMessageQueue: busy submit queues and later flushes all messages into one wake", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-busy-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  const emitted: any[] = [];
  const wakes: any[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: (event, data) => emitted.push({ event, data }) },
    wakeScheduler: {
      wake: (threadId, reason, triggerMessageId) => {
        wakes.push({ threadId, reason, triggerMessageId });
        return `wake-${wakes.length}`;
      },
      isThreadBusy: () => busy
    }
  });

  const first = queue.submitUserMessage({
    scope: "worker", scopeId: "f1", content: "first", clientRequestId: "local-1"
  });
  const second = queue.submitUserMessage({
    scope: "worker", scopeId: "f1", content: "second", clientRequestId: "local-2"
  });

  expect(first).toEqual({
    threadId: thread.id,
    messageId: null,
    wakeId: null,
    queued: true,
    queuedReason: "running_wake"
  });
  expect(second).toEqual({
    threadId: thread.id,
    messageId: null,
    wakeId: null,
    queued: true,
    queuedReason: "running_wake"
  });
  expect(agentStore.getActiveMessages(thread.id)).toEqual([]);
  expect(queue.pendingCount(thread.id)).toBe(2);

  busy = false;
  const wakeId = queue.flushIfIdle(thread.id);
  expect(wakeId).toBe("wake-1");

  const messages = agentStore.getActiveMessages(thread.id);
  expect(messages.map((m) => m.content.type === "text" ? m.content.text : "")).toEqual([
    "first",
    "second"
  ]);
  expect(wakes.length).toBe(1);
  expect(wakes[0]!.triggerMessageId).toBe(messages[1]!.id);
  expect(emitted.map((e) => e.event)).toStrictEqual([
    "agentMessageAppended",
    "agentMessageAppended"
  ]);
});

test("AgentUserMessageQueue: queued messages can be flushed into a running thread without starting a wake", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-running-flush-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  const emitted: any[] = [];
  const wakes: any[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: (event, data) => emitted.push({ event, data }) },
    wakeScheduler: {
      wake: (threadId, reason, triggerMessageId) => {
        wakes.push({ threadId, reason, triggerMessageId });
        return `wake-${wakes.length}`;
      },
      isThreadBusy: () => true
    }
  });

  const result = queue.submitUserMessage({
    scope: "worker", scopeId: "f1", content: "while busy", clientRequestId: "local-busy"
  });
  expect(result.queued).toBe(true);
  expect(result.queuedReason).toBe("running_wake");
  expect(queue.pendingCount(thread.id)).toBe(1);

  const flushed = queue.flushQueuedIntoThread(thread.id);
  expect(flushed.length).toBe(1);
  expect(queue.pendingCount(thread.id)).toBe(0);
  expect(wakes).toStrictEqual([]);
  expect(agentStore.getActiveMessages(thread.id).map((m) => m.content.type === "text" ? m.content.text : ""))
    .toEqual(["while busy"]);
  expect(emitted.map((e) => e.event)).toStrictEqual(["agentMessageAppended"]);
});

test("AgentUserMessageQueue: thread submit can decline in-memory queue when busy", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-decline-busy-");
  const thread = agentStore.getOrCreateThread("worker", "feat-no-memory-queue");
  const queue = new AgentUserMessageQueue({
    agentStore,
    wakeScheduler: {
      wake: () => "wake-1",
      isThreadBusy: () => true
    }
  });

  const result = queue.submitThreadUserMessage({
    threadId: thread.id,
    source: "manager",
    sourceThreadId: "thread-overview",
    content: "persist elsewhere",
    queueWhenBusy: false
  });

  expect(result).toEqual({
    threadId: thread.id,
    messageId: null,
    wakeId: null,
    queued: true,
    queuedReason: "running_wake"
  });
  expect(queue.pendingCount(thread.id)).toBe(0);
  expect(agentStore.getActiveMessages(thread.id)).toEqual([]);
});

test("AgentUserMessageQueue: thread submit preserves caller source after queued flush", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-thread-source-");
  const thread = agentStore.getOrCreateThread("worker", "feat-source");
  const callerThread = agentStore.getOrCreateThread("manager", null);
  let busy = true;
  const wakes: any[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    wakeScheduler: {
      wake: (threadId, reason, triggerMessageId) => {
        wakes.push({ threadId, reason, triggerMessageId });
        return "wake-1";
      },
      isThreadBusy: () => busy
    }
  });

  const queued = queue.submitThreadUserMessage({
    threadId: thread.id,
    source: "manager",
    sourceThreadId: callerThread.id,
    content: "queued overview work"
  });

  expect(queued).toEqual({
    threadId: thread.id,
    messageId: null,
    wakeId: null,
    queued: true,
    queuedReason: "running_wake"
  });
  busy = false;
  expect(queue.flushIfIdle(thread.id)).toBe("wake-1");

  const messages = agentStore.getActiveMessages(thread.id);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.source).toBe("manager");
  expect(messages[0]!.sourceThreadId).toBe(callerThread.id);
  expect(messages[0]!.content.type).toBe("text");
  expect(contentOf(messages[0]!, "text").text).toBe("queued overview work");
  expect(wakes).toStrictEqual([{
    threadId: thread.id,
    reason: "user",
    triggerMessageId: messages[0]!.id
  }]);
});

test("AgentUserMessageQueue: removeQueuedMessage drops a queued message before flush", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-remove-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  const queue = new AgentUserMessageQueue({
    agentStore,
    wakeScheduler: {
      wake: () => "wake-1",
      isThreadBusy: () => busy
    }
  });

  queue.submitUserMessage({
    scope: "worker", scopeId: "f1", content: "first", clientRequestId: "local-1"
  });
  queue.submitUserMessage({
    scope: "worker", scopeId: "f1", content: "second", clientRequestId: "local-2"
  });

  expect(queue.removeQueuedMessage(thread.id, "local-1")).toBe(true);
  expect(queue.removeQueuedMessage(thread.id, "missing")).toBe(false);
  expect(queue.pendingCount(thread.id)).toBe(1);

  busy = false;
  expect(queue.flushIfIdle(thread.id)).toBe("wake-1");
  const messages = agentStore.getActiveMessages(thread.id);
  expect(messages.map((m) => m.content.type === "text" ? m.content.text : "")).toEqual(["second"]);
});

test("AgentUserMessageQueue: recovered interrupted wake does not keep later messages queued", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-recover-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  const interrupted = agentStore.createWake({
    threadId: thread.id,
    reason: "user",
    triggerMessageId: null
  });
  expect(agentStore.getRunningWakeForThread(thread.id)?.id).toBe(interrupted.id);

  expect(agentStore.recoverInterruptedWakes("server restarted")).toBe(1);
  expect(agentStore.getRunningWakeForThread(thread.id)).toBe(null);

  const wakes: any[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    wakeScheduler: {
      wake: (threadId, reason, triggerMessageId) => {
        wakes.push({ threadId, reason, triggerMessageId });
        return "wake-1";
      },
      isThreadBusy: () => false,
      getRunningWakeForThread: (threadId) => agentStore.getRunningWakeForThread(threadId)
    }
  });

  const result = queue.submitUserMessage({
    scope: "worker", scopeId: "f1", content: "after restart", clientRequestId: "local-1"
  });

  expect(result.queued).toBe(false);
  expect(result.messageId).toBeTruthy();
  expect(wakes.length).toBe(1);
  expect(agentStore.getWakeById(interrupted.id)?.status).toBe("error");
});

test("agents API: DELETE queued message cancels a busy queued user message", async () => {
  const { agentStore } = freshAgentEnv("md-user-queue-route-");
  let busy = true;
  const queue = new AgentUserMessageQueue({
    agentStore,
    wakeScheduler: {
      wake: () => "wake-1",
      isThreadBusy: () => busy
    }
  });
  const app = new Hono();
  mountAgentsRoutes(app, {
    agentStore,
    wakeScheduler: { wake: () => "wake-1" },
    userMessageQueue: queue,
    scopes: {
      manager: stub<ScopeRuntime>({ verifyScopeId: (scopeId: string | null) => scopeId === null ? null : "manager scopeId must be null" }),
      worker: stub<ScopeRuntime>({ verifyScopeId: () => "feature not found" }),
      global: stub<ScopeRuntime>({ verifyScopeId: () => null }),
      subagent: stub<ScopeRuntime>({ verifyScopeId: () => "a subagent's thread is read by its id" })
    }
  });

  const thread = agentStore.createManagerThread("Release");
  const post = await app.request(`/api/agents/threads/${thread.id}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "cancel me", clientRequestId: "local-route" })
  });
  expect(post.status).toBe(202);
  expect(await post.json()).toMatchObject({ queued: true, messageId: null });
  expect(queue.pendingCount(thread.id)).toBe(1);

  const del = await app.request(`/api/agents/threads/${thread.id}/queued-messages/local-route`, { method: "DELETE" });
  expect(del.status).toBe(200);
  expect(await del.json()).toEqual({ ok: true, removed: true });
  expect(queue.pendingCount(thread.id)).toBe(0);

  busy = false;
  expect(queue.flushIfIdle(thread.id)).toBe(null);
  expect(agentStore.getActiveMessages(thread.id)).toEqual([]);
});

function managerQueue(prefix: string, busy: () => boolean) {
  const env = freshAgentEnv(prefix);
  const changed: string[] = [];
  const settled: unknown[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore: env.agentStore,
    wakeScheduler: { wake: () => "wake-1", isThreadBusy: busy },
    onQueueChanged: (threadId) => changed.push(threadId),
    onQuestionSettled: (threadId, question, how) => settled.push([threadId, question, how])
  });
  const thread = env.agentStore.createManagerThread("Release");
  return { ...env, queue, thread, changed, settled };
}

test("the user's own answer is said to settle its question with their words, taken in at once or behind a turn; the agent's relay, typed words, a Continue and a message not taken are not", () => {
  let busy = false;
  const { queue, thread, settled, cleanup } = managerQueue("md-user-queue-settled-", () => busy);
  const push = { id: "q_1", question: "Push the branch?" };
  try {
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Push now", source: "user", answers: [push] });
    expect(settled).toStrictEqual([[thread.id, push, { how: "answered", answer: "Push now" }]]);
    busy = true;
    const tag = { id: "q_2", question: "Tag it?" };
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Tag it", source: "user", answers: [tag] });
    expect(settled.slice(1)).toStrictEqual([[thread.id, tag, { how: "answered", answer: "Tag it" }]]);
    // Their agent answering for them already knows.
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Yes", source: "user", answers: [push], relay: { by: "global", spoken: false, handoffId: "hof_1" } });
    queue.submitThreadUserMessage({ threadId: thread.id, content: "And the docs.", source: "user" });
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Continue", source: "user", answers: [push], control: "continue" });
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Push now", source: "user", answers: [push], queueWhenBusy: false });
    expect(settled.length).toBe(2);
  } finally { cleanup(); }
});

test("a pick's mark is stored on the message it becomes; a typed message stores none", () => {
  const { agentStore, queue, thread, cleanup } = managerQueue("md-user-queue-pick-", () => false);
  try {
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Push now", source: "user", answers: [{ id: "q_1", question: "Push the branch?" }] });
    queue.submitThreadUserMessage({ threadId: thread.id, content: "And tag it.", source: "user" });
    // A list that names nothing is not written: a message with it would read as a pick of nothing.
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Go on.", source: "user", answers: [] });
    const [pick, typed, none] = agentStore.getActiveMessages(thread.id).map((m) => contentOf(m, "text"));
    expect(pick).toEqual({ type: "text", text: "Push now", metadata: { answers: [{ id: "q_1", question: "Push the branch?" }] } });
    expect(typed).toEqual({ type: "text", text: "And tag it." });
    expect(none).toEqual({ type: "text", text: "Go on." });
  } finally { cleanup(); }
});

test("what the user answered behind a running turn is reported until it lands, and the queue says when it changed", () => {
  let busy = true;
  const { agentStore, queue, thread, changed, cleanup } = managerQueue("md-user-queue-answers-", () => busy);
  try {
    expect(queue.queuedAnswers(thread.id)).toEqual([]);
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Push now", source: "user", clientRequestId: "local-1", answers: [{ id: "q_1", question: "Push?" }] });
    queue.submitThreadUserMessage({ threadId: thread.id, content: "And tag it.", source: "user", clientRequestId: "local-2" });
    // A typed one says what stood when it was written: here nothing was asked.
    expect(queue.queuedAnswers(thread.id)).toEqual([{ answers: [{ id: "q_1", question: "Push?" }] }, { answers: [], openWhenWritten: [] }]);
    expect(changed).toStrictEqual([thread.id, thread.id]);
    // Taken back before it landed: no longer an answer.
    expect(queue.removeQueuedMessage(thread.id, "local-2")).toBe(true);
    expect(queue.queuedAnswers(thread.id)).toEqual([{ answers: [{ id: "q_1", question: "Push?" }] }]);
    expect(changed.length).toBe(3);
    // Removing nothing changes nothing.
    expect(queue.removeQueuedMessage(thread.id, "local-9")).toBe(false);
    expect(changed.length).toBe(3);
    busy = false;
    queue.flushIfIdle(thread.id);
    expect(queue.queuedAnswers(thread.id)).toEqual([]);
    expect(contentOf(agentStore.getActiveMessages(thread.id)[0]!, "text").metadata).toEqual({ answers: [{ id: "q_1", question: "Push?" }] });
    // Dropped with the queue: said so once more, and only when something was held.
    busy = true;
    queue.submitThreadUserMessage({ threadId: thread.id, content: "One more", source: "user" });
    expect(queue.clearThread(thread.id)).toBe(1);
    expect(changed.length).toBe(5);
    expect(queue.clearThread(thread.id)).toBe(0);
    expect(changed.length).toBe(5);
  } finally { cleanup(); }
});

test("only the user's own queued words are answers: a relayed worker message waiting behind the turn is not", () => {
  const { queue, thread, cleanup } = managerQueue("md-user-queue-sources-", () => true);
  try {
    queue.submitThreadUserMessage({ threadId: thread.id, content: "[report]", source: "worker-report" });
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Reply from a worker", source: "feature-message" });
    expect(queue.queuedAnswers(thread.id)).toEqual([]);
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Said aloud", source: "voice" });
    expect(queue.queuedAnswers(thread.id)).toEqual([{ answers: [], openWhenWritten: [] }]);
  } finally { cleanup(); }
});

test("a message that waited behind a turn lands with the questions that stood when it was written; one taken in at once carries no such mark", () => {
  let busy = true;
  const { agentStore, queue, thread, cleanup } = managerQueue("md-user-queue-waited-", () => busy);
  try {
    agentStore.setQueuedAnswers((id) => queue.queuedAnswers(id));
    const ask = (id: string, question: string) => agentStore.appendMessage({
      threadId: thread.id, role: "tool", source: "self",
      content: { type: "tool_result", toolCallId: `call_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options: [] } }
    });
    ask("q_1", "Rename the flag?");
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Yes, rename it.", source: "user" });
    // A worker's reply held the same way is nobody's answer and carries nothing.
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Reply from a worker", source: "feature-message" });
    ask("q_2", "Push to main now?");
    expect(queue.queuedAnswers(thread.id)).toEqual([{ answers: [], openWhenWritten: ["q_1"] }]);
    const landed = queue.flushQueuedIntoThread(thread.id).map((m) => contentOf(m, "text"));
    // It lands after the second question, answering neither, and says which was asked since.
    expect(landed).toEqual([
      { type: "text", text: "Yes, rename it.", metadata: { openWhenWritten: ["q_1"], writtenBefore: [{ id: "q_2", question: "Push to main now?" }] }, arrivedAt: expect.any(String) },
      { type: "text", text: "Reply from a worker", arrivedAt: expect.any(String) }
    ]);
    expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
    busy = false;
    const now = queue.submitThreadUserMessage({ threadId: thread.id, content: "Not yet.", source: "user" });
    expect(contentOf(agentStore.getActiveMessages(thread.id).find((m) => m.id === now.messageId)!, "text")).toEqual({ type: "text", text: "Not yet." });
    expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
  } finally { cleanup(); }
});

test("what the Continue control sends is stored as the control's, and answers nothing: at once, or behind a turn", () => {
  let busy = false;
  const { agentStore, queue, thread, cleanup } = managerQueue("md-user-queue-control-", () => busy);
  try {
    agentStore.setQueuedAnswers((id) => queue.queuedAnswers(id));
    agentStore.appendMessage({
      threadId: thread.id, role: "tool", source: "self",
      content: { type: "tool_result", toolCallId: "call_q_1", toolName: "ask_user", result: { asked: true, questionId: "q_1", question: "Push to main now?", options: [] } }
    });
    const sent = queue.submitThreadUserMessage({ threadId: thread.id, content: "Continue", source: "user", control: "continue" });
    expect(contentOf(agentStore.getActiveMessages(thread.id).find((m) => m.id === sent.messageId)!, "text")).toEqual({ type: "text", text: "Continue", metadata: { control: "continue" } });
    expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1"]);
    busy = true;
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Continue", source: "user", control: "continue" });
    expect(queue.queuedAnswers(thread.id)).toEqual([]);
    expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1"]);
    expect(contentOf(queue.flushQueuedIntoThread(thread.id)[0]!, "text").metadata).toEqual({ control: "continue" });
    expect(agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1"]);
  } finally { cleanup(); }
});

test("the conversation's own turn starts before anyone else hears an answer settled: telling them cannot hold it back", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-settled-order-");
  const wakes: string[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    wakeScheduler: { wake: (threadId) => { wakes.push(threadId); return "wake-1"; }, isThreadBusy: () => false },
    onQuestionSettled: () => { throw new Error("the agent's conversation could not be told"); }
  });
  const thread = agentStore.createManagerThread("Release");
  expect(() => queue.submitThreadUserMessage({ threadId: thread.id, content: "Push now", source: "user", answers: [{ id: "q_1", question: "Push the branch?" }] }))
    .toThrow("could not be told");
  expect(wakes).toStrictEqual([thread.id]);
});

// Skipping a question: the user closes it without answering. Nobody is
// woken; the asker reads that it was skipped when it next looks.

function ask(store: AgentStore, threadId: string, id: string, question: string) {
  store.appendMessage({
    threadId, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: `call_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options: [] } }
  });
}

function skipScene(prefix: string, busy: boolean) {
  const env = freshAgentEnv(prefix);
  const store = env.agentStore;
  const events: string[] = [];
  const wakes: string[] = [];
  const changed: string[] = [];
  const settled: unknown[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore: store,
    sse: { emit: (event) => { events.push(event); } },
    wakeScheduler: { wake: (threadId) => { wakes.push(threadId); return null; }, isThreadBusy: () => busy },
    onQueueChanged: (threadId) => { changed.push(threadId); },
    onQuestionSettled: (threadId, q, how) => { settled.push([threadId, q.id, how]); }
  });
  store.setQueuedAnswers((threadId) => queue.queuedAnswers(threadId));
  const t = store.createManagerThread("Release");
  ask(store, t.id, "q_1", "Push the branch?");
  ask(store, t.id, "q_2", "Tag the docs site\nwith the same version?");
  const open = (s: AgentStore = store) => s.openQuestions(t.id).map((q) => q.id);
  const question = (id: string) => store.openQuestions(t.id).find((q) => q.id === id)!;
  return { env, store, queue, t, events, wakes, changed, settled, open, question };
}

test("a question skipped while its asker is idle closes now, with a row the asker reads, and nobody is woken", () => {
  const { env, store, queue, t, events, wakes, settled, open, question } = skipScene("md-skip-idle-", false);
  try {
    const before = store.getActiveMessages(t.id).length;
    queue.skipQuestion(t.id, question("q_2"));
    expect(open()).toEqual(["q_1"]);
    expect(settled).toStrictEqual([[t.id, "q_2", { how: "skipped" }]]);
    expect(open(new AgentStore(env.store.db))).toEqual(["q_1"]);
    const rows = store.getActiveMessages(t.id);
    expect(rows.length).toBe(before + 1);
    const row = rows.at(-1)!;
    expect([row.role, row.source, row.content]).toEqual(["user", "question-skip", {
      type: "text",
      text: 'The user skipped your question "Tag the docs site with the same version?".',
      metadata: { closedQuestions: ["q_2"] }
    }] as never);
    expect(events).toStrictEqual([SSE_EVENTS.agentMessageAppended]);
    expect(wakes).toStrictEqual([]);
    // The asker reads it as written, nothing added.
    expect(prepareAiSdkMessages([row], { includeImages: false })).toEqual([{ role: "user", content: 'The user skipped your question "Tag the docs site with the same version?".' }]);
  } finally { env.cleanup(); }
});

// The row waits for the turn's next step in the mailbox, which the runtime
// drains before each step (as it does a worker's note).
test("a question skipped while its asker's turn runs closes now: its row waits in the mailbox, starts no turn, and lands when the mailbox is drained", () => {
  const { env, store, queue, t, events, wakes, changed, settled, open, question } = skipScene("md-skip-busy-", true);
  try {
    const before = store.getActiveMessages(t.id).length;
    queue.skipQuestion(t.id, question("q_2"));
    expect(open()).toEqual(["q_1"]);
    expect(settled).toStrictEqual([[t.id, "q_2", { how: "skipped" }]]);
    expect(open(new AgentStore(env.store.db))).toEqual(["q_1"]);
    // Not a row yet, nothing appended, and the page is told what is open.
    expect(store.getActiveMessages(t.id).length).toBe(before);
    expect(events).toStrictEqual([]);
    expect(changed).toStrictEqual([t.id]);
    // It starts no turn of its own.
    expect(wakes).toStrictEqual([]);
    expect(store.hasQueuedMailboxMessages(t.id)).toBe(false);
    const wake = store.createWake({ threadId: t.id, reason: "user", triggerMessageId: null });
    const [landed] = store.drainMailboxToMessages(t.id, wake.id);
    expect([landed!.source, (landed!.content as { text: string }).text]).toEqual(["question-skip", 'The user skipped your question "Tag the docs site with the same version?".']);
    expect(open()).toEqual(["q_1"]);
    expect(open(new AgentStore(env.store.db))).toEqual(["q_1"]);
  } finally { env.cleanup(); }
});

// The messages are written, then the wake's row is refused (another writer
// holds the database): they must not sit there with no wake. The next flush
// wakes on the last one, writing nothing again; a wake that ran meanwhile
// read them, and then nothing more is woken.
test("AgentUserMessageQueue: messages written whose wake was refused are woken on at the next flush, unless a wake ran since", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-unwoken-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  let refuse = true;
  const wakes: Array<string | null> = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: {
      wake: (_t, _r, triggerMessageId) => {
        if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
        wakes.push(triggerMessageId);
        return "wake-1";
      },
      isThreadBusy: () => busy
    }
  });
  for (const text of ["first", "second"]) queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: text, clientRequestId: `local-${text}` });
  busy = false;
  expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
  const written = agentStore.getActiveMessages(thread.id);
  expect(written.map((m) => m.content.type === "text" ? m.content.text : "")).toEqual(["first", "second"]);
  expect(queue.flushIfIdle(thread.id)).toBe("wake-1");
  expect(wakes).toStrictEqual([written.at(-1)!.id]);
  expect(agentStore.getActiveMessages(thread.id)).toHaveLength(2);
  // Woken: the next flush has nothing to wake.
  expect(queue.flushIfIdle(thread.id)).toBe(null);

  // Refused again, then a wake runs for another reason: it read them.
  refuse = true;
  busy = true;
  queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: "third", clientRequestId: "local-third" });
  busy = false;
  expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
  const other = agentStore.createWake({ threadId: thread.id, reason: "worker-report", triggerMessageId: null });
  agentStore.finishWake(other.id, "finished");
  expect(queue.flushIfIdle(thread.id)).toBe(null);
  expect(wakes).toHaveLength(1);
});

// Refused part-way, and the rest taken back before the next flush: what was
// written is still woken on.
test("AgentUserMessageQueue: messages a part-refused flush wrote are woken on after the rest is taken back", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-partly-taken-back-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  const wakes: Array<string | null> = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: { wake: (_t, _r, triggerMessageId) => { wakes.push(triggerMessageId); return "wake-1"; }, isThreadBusy: () => busy }
  });
  for (const text of ["first", "second"]) queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: text, clientRequestId: `local-${text}` });
  const real = agentStore.appendMessage.bind(agentStore);
  let calls = 0;
  const append = spyOn(agentStore, "appendMessage").mockImplementation((...args: Parameters<typeof agentStore.appendMessage>) => {
    calls++;
    if (calls === 2) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return real(...args);
  });
  busy = false;
  try {
    expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
  } finally {
    append.mockRestore();
  }
  expect(queue.removeQueuedMessage(thread.id, "local-second")).toBe(true);
  expect(queue.flushIfIdle(thread.id)).toBe("wake-1");
  const written = agentStore.getActiveMessages(thread.id);
  expect(written.map((m) => m.content.type === "text" ? m.content.text : "")).toEqual(["first"]);
  expect(wakes).toStrictEqual([written[0]!.id]);
});

test("AgentUserMessageQueue: clearing a thread drops a refused wake's message too: nothing is woken on it after", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-clear-unwoken-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  let refuse = true;
  const wakes: Array<string | null> = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: {
      wake: (_t, _r, triggerMessageId) => {
        if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
        wakes.push(triggerMessageId);
        return "wake-1";
      },
      isThreadBusy: () => busy
    }
  });
  queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: "first", clientRequestId: "local-first" });
  busy = false;
  expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
  queue.clearThread(thread.id);
  expect(queue.flushIfIdle(thread.id)).toBe(null);
  expect(wakes).toStrictEqual([]);
});

// Sent to an idle thread: written, then its wake's row refused (another
// writer holding the database). The sender heard an error for a message that
// was in, and a resend wrote it twice; the thread was not woken for it. Now
// the sender hears it was sent, and the thread's follow-up, tried again,
// wakes on it.
function refusingQueue(agentStore: ReturnType<typeof freshAgentEnv>["agentStore"], opts: { retry: boolean; refuse: () => boolean }) {
  const wakes: Array<string | null> = [];
  const retried: string[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: {
      wake: (_t, _r, triggerMessageId) => {
        if (opts.refuse()) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
        wakes.push(triggerMessageId);
        return "wake-1";
      },
      isThreadBusy: () => false,
      ...(opts.retry ? { retryFollowUp: (threadId: string) => { retried.push(threadId); } } : {})
    }
  });
  return { queue, wakes, retried };
}

test("AgentUserMessageQueue: a message sent to an idle thread whose wake is refused reads as sent, and the retried follow-up wakes on it", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-send-refused-");
  const thread = agentStore.createManagerThread("Release");
  let refuse = true;
  const q = refusingQueue(agentStore, { retry: true, refuse: () => refuse });
  const sent = q.queue.submitThreadUserMessage({ threadId: thread.id, content: "Push now", source: "user" });
  const written = agentStore.getActiveMessages(thread.id);
  expect(written).toHaveLength(1);
  expect(sent).toEqual({ threadId: thread.id, messageId: written[0]!.id, wakeId: null, queued: false });
  expect(q.retried).toStrictEqual([thread.id]);
  refuse = false;
  expect(q.queue.flushIfIdle(thread.id)).toBe("wake-1");
  expect(q.wakes).toStrictEqual([written[0]!.id]);
  expect(agentStore.getActiveMessages(thread.id)).toHaveLength(1);
});

test("AgentUserMessageQueue: with nobody to try its follow-up again, a send whose wake is refused fails as before", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-send-refused-bare-");
  const thread = agentStore.createManagerThread("Release");
  const q = refusingQueue(agentStore, { retry: false, refuse: () => true });
  expect(() => q.queue.submitThreadUserMessage({ threadId: thread.id, content: "Push now", source: "user" })).toThrow("database is locked");
});

test("AgentUserMessageQueue: a send whose own message is refused after messages a refused flush kept were written fails, and the follow-up tried again wakes on those", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-send-append-refused-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  const wakes: Array<string | null> = [];
  const retried: string[] = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: {
      wake: (_t, _r, triggerMessageId) => { wakes.push(triggerMessageId); return "wake-1"; },
      isThreadBusy: () => busy,
      retryFollowUp: (threadId) => { retried.push(threadId); }
    }
  });
  queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: "A", clientRequestId: "local-A" });
  busy = false;
  const real = agentStore.appendMessage.bind(agentStore);
  let calls = 0;
  // The first flush is refused outright; the send then writes A, and its own B is refused.
  const append = spyOn(agentStore, "appendMessage").mockImplementation((...args: Parameters<typeof agentStore.appendMessage>) => {
    calls++;
    if (calls === 1 || calls === 3) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return real(...args);
  });
  try {
    expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
    expect(() => queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: "B", clientRequestId: "local-B" })).toThrow("database is locked");
  } finally {
    append.mockRestore();
  }
  const written = agentStore.getActiveMessages(thread.id);
  expect(written.map((m) => m.content.type === "text" ? m.content.text : "")).toEqual(["A"]);
  expect(retried).toStrictEqual([thread.id]);
  expect(queue.flushIfIdle(thread.id)).toBe("wake-1");
  expect(wakes).toStrictEqual([written[0]!.id]);
});

test("AgentUserMessageQueue: a send woken after a refused flush also answers for what that flush wrote: no second wake for it", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-send-clears-unwoken-");
  const thread = agentStore.getOrCreateThread("worker", "f1");
  let busy = true;
  let refuse = true;
  const wakes: Array<string | null> = [];
  const queue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit: () => {} },
    wakeScheduler: {
      wake: (_t, _r, triggerMessageId) => {
        if (refuse) { refuse = false; throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }
        wakes.push(triggerMessageId);
        return "wake-1";
      },
      isThreadBusy: () => busy
    }
  });
  queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: "A", clientRequestId: "local-A" });
  busy = false;
  expect(() => queue.flushIfIdle(thread.id)).toThrow("database is locked");
  const sent = queue.submitUserMessage({ scope: "worker", scopeId: "f1", content: "B", clientRequestId: "local-B" });
  expect(wakes).toStrictEqual([sent.messageId]);
  expect(queue.flushIfIdle(thread.id)).toBe(null);
  expect(wakes).toHaveLength(1);
});


// A message that names threads keeps which ones beside its words, whether it
// lands at once or waits behind a running turn first.
test("AgentUserMessageQueue: a message sent with mentions stores them in its metadata, at once or after waiting behind a turn", () => {
  const { agentStore } = freshAgentEnv("md-user-queue-mentions-");
  const thread = agentStore.createManagerThread("Release");
  const mentions = [{ kind: "thread", id: "thr_target", label: "Parser errors" }];
  let busy = false;
  const queue = new AgentUserMessageQueue({ agentStore, wakeScheduler: { wake: () => "wake-1", isThreadBusy: () => busy } });
  queue.submitThreadUserMessage({ threadId: thread.id, content: "Follow up on @Parser errors", source: "user", mentions });
  expect(mentionsOf(agentStore.getActiveMessages(thread.id).at(-1)!.content)).toEqual(mentions);
  busy = true;
  expect(queue.submitThreadUserMessage({ threadId: thread.id, content: "Look again at @Parser errors", source: "user", mentions })).toMatchObject({ queued: true });
  busy = false;
  queue.flushIfIdle(thread.id);
  const last = agentStore.getActiveMessages(thread.id).at(-1)!;
  expect(last.content.type === "text" ? last.content.text : "").toBe("Look again at @Parser errors");
  expect(mentionsOf(last.content)).toEqual(mentions);
  // A message with none carries no mark.
  queue.submitThreadUserMessage({ threadId: thread.id, content: "plain", source: "user" });
  const plain = agentStore.getActiveMessages(thread.id).at(-1)!.content;
  expect(plain.type === "text" ? plain.metadata?.mentions : "x").toBeUndefined();
});

test("a message that waits behind a running turn keeps the time it was taken in; one taken in at once has none of its own", () => {
  let busy = true;
  const { agentStore, queue, thread, cleanup } = managerQueue("md-user-queue-arrived-", () => busy);
  try {
    const before = new Date().toISOString();
    queue.submitThreadUserMessage({ threadId: thread.id, content: "Check the logs", source: "user" });
    const after = new Date().toISOString();
    busy = false;
    queue.flushIfIdle(thread.id);
    queue.submitThreadUserMessage({ threadId: thread.id, content: "And the docs.", source: "user" });
    const [waited, direct] = agentStore.getActiveMessages(thread.id).map((m) => m.content);
    const arrivedAt = waited?.type === "text" ? waited.arrivedAt : undefined;
    expect(typeof arrivedAt).toBe("string");
    expect(arrivedAt! >= before && arrivedAt! <= after).toBe(true);
    expect(direct?.type === "text" ? direct.arrivedAt : "not text").toBeUndefined();
  } finally { cleanup(); }
});
