import { expect, test } from "bun:test";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { WorkersStore } from "../../src/server/modules/workers/workers-store.js";
import type { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import type { MandateStore } from "../../src/server/app/store.js";
import { buildAgentsTestApp, buildTestScopes, getJson, postJson } from "../helpers/test-app.js";
import { freshAgentEnv, NOOP_WAKE, seedWorker, seedProject } from "../helpers/fixtures.js";
import { AgentUserMessageQueue } from "../../src/server/modules/agent/user-message-queue.js";

function appWith(deps: {
  agentStore: AgentStore;
  projects: ProjectsStore;
  workers: WorkersStore;
  wake?: (tid: string, reason: string, mid: string | null) => string | null;
  modelSupportsImage?: boolean;
  contextBudgetTokens?: number;
}) {
  return buildAgentsTestApp({
    agentStore: deps.agentStore,
    wakeScheduler: deps.wake ? { wake: deps.wake } : NOOP_WAKE,
    scopes: buildTestScopes(deps.workers),
    contextBudgetTokens: deps.contextBudgetTokens,
    modelSupportsInput: (_scope, input) => input === "image" ? deps.modelSupportsImage ?? true : true
  });
}

function buildScene(store: MandateStore) {
  const projects = new ProjectsStore(store.db);
  const workers = new WorkersStore(store.db);
  const workerId = seedWorker(workers, seedProject(projects));
  return { projects, workers, workerId };
}

test("GET /thread on missing thread → empty payload (no 404)", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const app = appWith({ agentStore, projects, workers });
  const r = await getJson(app, `/api/agents/workers/${workerId}/thread`);
  expect(r.status).toBe(200);
  expect(r.body.thread).toBe(null);
  expect(r.body.messages).toStrictEqual([]);
  // Said, not left for the page to guess: nothing older to load.
  expect(r.body.hasMore).toBe(false);
});

test("GET /thread paginates: since=N returns full UI timeline messages with seq > N", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const thread = agentStore.getOrCreateThread("worker", workerId);
  for (let i = 0; i < 5; i++) {
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: `m${i}` }
    });
  }
  agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "compression",
    content: {
      type: "summary", summary: "summarized",
      replacedRange: [1, 2], replacedCount: 2, compactedCount: 2,
      retained: []
    }
  });
  const app = appWith({ agentStore, projects, workers });
  const r = await getJson(app, `/api/agents/workers/${workerId}/thread?since=0`);
  expect(r.status).toBe(200);
  expect(r.body.messages.length).toBe(6);
  expect(r.body.messages.map((m: any) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("GET /thread paginates older UI history with before cursor", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const thread = agentStore.getOrCreateThread("worker", workerId);
  for (let i = 0; i < 5; i++) {
    agentStore.appendMessage({
      threadId: thread.id, role: "user", source: "user",
      content: { type: "text", text: `m${i + 1}` }
    });
  }
  const app = appWith({ agentStore, projects, workers });

  const first = await getJson(app, `/api/agents/workers/${workerId}/thread?limit=2`);
  expect(first.status).toBe(200);
  expect(first.body.messages.map((m: any) => m.seq)).toEqual([4, 5]);
  expect(first.body.hasMore).toBe(true);

  const second = await getJson(app, `/api/agents/workers/${workerId}/thread?limit=2&before=4`);
  expect(second.body.messages.map((m: any) => m.seq)).toEqual([2, 3]);
  expect(second.body.hasMore).toBe(true);

  const third = await getJson(app, `/api/agents/workers/${workerId}/thread?limit=2&before=2`);
  expect(third.body.messages.map((m: any) => m.seq)).toEqual([1]);
  expect(third.body.hasMore).toBe(false);
});

test("GET /thread includes latest context budget usage when configured", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const thread = agentStore.getOrCreateThread("worker", workerId);
  agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "hi" }
  });
  const wake = agentStore.createWake({
    threadId: thread.id,
    reason: "user",
    triggerMessageId: null
  });
  agentStore.updateWakeTokenUsage(wake.id, 85_000, 85_000);
  agentStore.finishWake(wake.id, "finished");

  const app = appWith({ agentStore, projects, workers, contextBudgetTokens: 170_000 });
  const r = await getJson(app, `/api/agents/workers/${workerId}/thread`);
  expect(r.status).toBe(200);
  expect(r.body.contextUsage).toMatchObject({
    inputTokens: 85_000,
    budgetTokens: 170_000
  });
});

test("GET /thread: a message says its wake was stopped by a person once that wake has ended so, and no other does", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const thread = agentStore.getOrCreateThread("worker", workerId);
  agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "hi" } });
  const ended: Array<[string, string | null]> = [["stopped", "canceled"], ["failed", "error"], ["stuck", "stuck"], ["limited", "limit_reached"], ["done", "finished"], ["running", null]];
  const wakeOf = new Map<string, string>();
  for (const [name, status] of ended) {
    const wake = agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    wakeOf.set(name, wake.id);
    agentStore.appendMessage({
      threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id,
      content: { type: "assistant", text: "", toolCalls: [{ toolCallId: `call-${name}`, toolName: "read_plan", args: {} }] }
    });
    agentStore.appendMessage({
      threadId: thread.id, role: "tool", source: "self", wakeId: wake.id,
      content: { type: "tool_result", toolCallId: `call-${name}`, toolName: "read_plan", result: { ok: true } }
    });
    if (status) agentStore.finishWake(wake.id, status as "finished", null);
  }
  const app = appWith({ agentStore, projects, workers });
  const read = async () => {
    const r = await getJson(app, `/api/agents/workers/${workerId}/thread`);
    expect(r.status).toBe(200);
    const nameOf = new Map([...wakeOf].map(([name, id]) => [id, name]));
    return (r.body.messages as Array<{ wakeId: string | null; role: string; wakeInterrupted?: boolean }>)
      .map((m) => [m.wakeId ? nameOf.get(m.wakeId) : "none", m.role, "wakeInterrupted" in m ? m.wakeInterrupted : "absent"]);
  };
  const others = ["failed", "stuck", "limited", "done", "running"].flatMap((name) => [[name, "assistant", "absent"], [name, "tool", "absent"]]);
  expect(await read()).toEqual([["none", "user", "absent"], ["stopped", "assistant", true], ["stopped", "tool", true], ...others]);
  // The running turn is stopped: the same messages, read again, now say so.
  agentStore.finishWake(wakeOf.get("running")!, "canceled", "Stopped by user.");
  expect((await read()).slice(-2)).toEqual([["running", "assistant", true], ["running", "tool", true]]);
});

test("POST /messages: returns messageId + wakeId, triggers wake", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  let wokenWith: { tid: string; reason: string; mid: string | null } | null = null;
  const app = appWith({
    agentStore, projects, workers,
    wake: (tid, reason, mid) => {
      wokenWith = { tid, reason, mid };
      return "wake-test";
    }
  });
  const r = await postJson(app, `/api/agents/workers/${workerId}/messages`, { content: "hi" });
  expect(r.status).toBe(202);
  expect(r.body.messageId).toBeTruthy();
  expect(r.body.wakeId).toBeTruthy();
  expect(r.body.threadId).toBeTruthy();
  expect(wokenWith).toBeTruthy();
  expect(wokenWith!.reason).toBe("user");
});

test("POST /messages: image attachment is persisted when model supports image input", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const app = appWith({ agentStore, projects, workers, modelSupportsImage: true });
  const attachment = {
    type: "image" as const,
    id: "img-test",
    name: "shot.png",
    mediaType: "image/png",
    data: "iVBORw0KGgo=",
    sizeBytes: 8
  };
  const r = await postJson(app, `/api/agents/workers/${workerId}/messages`, {
    content: "look at this",
    attachments: [attachment]
  });
  expect(r.status).toBe(202);
  const thread = agentStore.getThreadByScope("worker", workerId)!;
  const [message] = agentStore.getActiveMessages(thread.id);
  expect(message!.content).toEqual({
    type: "text",
    text: "look at this",
    attachments: [attachment]
  });
});

test("POST /messages: image attachment is rejected when model lacks image input", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const app = appWith({ agentStore, projects, workers, modelSupportsImage: false });
  const r = await postJson(app, `/api/agents/workers/${workerId}/messages`, {
    content: "look",
    attachments: [{
      type: "image",
      id: "img-test",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
      sizeBytes: 8
    }]
  });
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/does not support image/i);
});

test("POST /messages: 404 on archived worker", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  workers.archive(workerId);
  const app = appWith({ agentStore, projects, workers });
  const r = await postJson(app, `/api/agents/workers/${workerId}/messages`, { content: "hi" });
  expect(r.status).toBe(404);
});

test("GET /active-wakes: lists running wakes with scope info and excludes finished ones", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const workerThread = agentStore.getOrCreateThread("worker", workerId);
  const managerThread = agentStore.getOrCreateThread("manager", null);
  const done = agentStore.createWake({
    threadId: workerThread.id, reason: "user", triggerMessageId: null
  });
  agentStore.finishWake(done.id, "finished");
  const runningWorker = agentStore.createWake({
    threadId: workerThread.id, reason: "user", triggerMessageId: null
  });
  const runningManager = agentStore.createWake({
    threadId: managerThread.id, reason: "user", triggerMessageId: null
  });

  const app = appWith({ agentStore, projects, workers });
  const r = await getJson(app, "/api/agents/active-wakes");
  expect(r.status).toBe(200);
  const wakes = r.body.wakes as Array<{
    threadId: string; wakeId: string; scope: string; scopeId: string | null;
  }>;
  expect(wakes.map((w) => w.wakeId).sort()).toEqual(
    [runningWorker.id, runningManager.id].sort()
  );
  expect(wakes.find((w) => w.wakeId === runningWorker.id)).toMatchObject({
    threadId: workerThread.id, scope: "worker", scopeId: workerId
  });
  expect(wakes.find((w) => w.wakeId === runningManager.id)).toMatchObject({
    threadId: managerThread.id, scope: "manager", scopeId: null
  });
  // When each began, so a page opened mid-wake can show how long it has run.
  expect(wakes.map((w) => [w.wakeId, (w as { startedAt?: string }).startedAt]).sort()).toEqual(
    [[runningWorker.id, runningWorker.startedAt], [runningManager.id, runningManager.startedAt]].sort()
  );
});

test("GET /thread says which wake is running and since when, on every read of the thread", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const workerThread = agentStore.getOrCreateThread("worker", workerId);
  const managerThread = agentStore.getOrCreateThread("manager", null);
  const finished = agentStore.createWake({ threadId: workerThread.id, reason: "user", triggerMessageId: null });
  agentStore.finishWake(finished.id, "finished");
  const running = agentStore.createWake({ threadId: workerThread.id, reason: "user", triggerMessageId: null });
  const app = appWith({ agentStore, projects, workers });

  const expected = { wakeId: running.id, startedAt: running.startedAt };
  const reads = {
    page: `/api/agents/workers/${workerId}/thread`,
    since: `/api/agents/workers/${workerId}/thread?since=0`,
    byId: `/api/agents/threads/${workerThread.id}`,
    byIdSince: `/api/agents/threads/${workerThread.id}?since=0`
  };
  for (const [name, url] of Object.entries(reads)) {
    const r = await getJson(app, url);
    expect([name, r.status, r.body.activeWake]).toEqual([name, 200, expected]);
  }
  // A thread with nothing running says so.
  const idle = await getJson(app, `/api/agents/threads/${managerThread.id}`);
  expect(idle.body.activeWake).toBe(null);
});

test("POST /messages says when the wake it started began, on both a worker's and a manager thread", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const manager = agentStore.getOrCreateThread("manager", null);
  // A scheduler that really opens a wake row, as the running one does.
  const app = appWith({
    agentStore, projects, workers,
    wake: (tid, reason, mid) => agentStore.createWake({ threadId: tid, reason: reason as "user", triggerMessageId: mid }).id
  });
  const posts = {
    worker: await postJson(app, `/api/agents/workers/${workerId}/messages`, { content: "hi" }),
    manager: await postJson(app, `/api/agents/threads/${manager.id}/messages`, { content: "hi" })
  };
  for (const [name, r] of Object.entries(posts)) {
    const startedAt = agentStore.getWakeById(r.body.wakeId)?.startedAt;
    expect([name, r.status, typeof startedAt, r.body.wakeStartedAt]).toEqual([name, 202, "string", startedAt]);
  }
});

test("GET /thread says when it was read, on the server's clock", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const thread = agentStore.getOrCreateThread("worker", workerId);
  const app = appWith({ agentStore, projects, workers });
  const before = new Date().toISOString();
  const reads = [
    await getJson(app, `/api/agents/workers/${workerId}/thread`),
    await getJson(app, `/api/agents/workers/${workerId}/thread?since=0`),
    await getJson(app, `/api/agents/threads/${thread.id}`),
    await getJson(app, `/api/agents/threads/${thread.id}?since=0`)
  ];
  const after = new Date().toISOString();
  for (const r of reads) {
    expect(typeof r.body.readAt).toBe("string");
    expect(r.body.readAt >= before && r.body.readAt <= after).toBe(true);
  }
});

test("POST /messages through the message queue, as the runtime sends, says when its wake began too", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { workers, workerId } = buildScene(store);
  const manager = agentStore.getOrCreateThread("manager", null);
  const userMessageQueue = new AgentUserMessageQueue({
    agentStore,
    sse: { emit() {} },
    wakeScheduler: {
      wake: (threadId, reason, triggerMessageId) => agentStore.createWake({ threadId, reason, triggerMessageId }).id,
      isThreadBusy: () => false
    }
  });
  const app = buildAgentsTestApp({
    agentStore,
    wakeScheduler: NOOP_WAKE,
    userMessageQueue,
    scopes: buildTestScopes(workers),
    modelSupportsInput: () => true
  });
  const posts = {
    worker: await postJson(app, `/api/agents/workers/${workerId}/messages`, { content: "hi" }),
    manager: await postJson(app, `/api/agents/threads/${manager.id}/messages`, { content: "hi" })
  };
  for (const [name, r] of Object.entries(posts)) {
    const startedAt = agentStore.getWakeById(r.body.wakeId)?.startedAt;
    expect([name, r.status, typeof startedAt, r.body.wakeStartedAt]).toEqual([name, 202, "string", startedAt]);
  }
});

test("GET /thread lists what the thread's agent is still waiting on, on every read of the thread", async () => {
  const { store, agentStore } = freshAgentEnv("md-api-");
  const { projects, workers, workerId } = buildScene(store);
  const workerThread = agentStore.getOrCreateThread("worker", workerId);
  const waiting = [{ kind: "pane" as const, id: "mon_pane_1", windowKey: "md-project-1:pr_48", paneId: "%103", paneName: null, stableMs: 45_000, timeoutAt: "2026-10-08T13:21:00.000Z", note: "read the review", createdAt: "2026-10-08T12:51:00.000Z" }];
  const app = buildAgentsTestApp({
    agentStore,
    wakeScheduler: NOOP_WAKE,
    scopes: buildTestScopes(workers),
    pendingMonitors: (threadId) => ({ monitors: threadId === workerThread.id ? waiting : [], revision: { boot: 1791464000123, seq: 4 } })
  });
  for (const url of [`/api/agents/workers/${workerId}/thread`, `/api/agents/workers/${workerId}/thread?since=0`, `/api/agents/threads/${workerThread.id}`]) {
    const r = await getJson(app, url);
    expect([url, r.body.monitors, r.body.monitorsRevision]).toEqual([url, waiting, { boot: 1791464000123, seq: 4 }]);
  }
  void projects;
});
