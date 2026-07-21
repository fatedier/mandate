import { expect, test } from "bun:test";
import { Hono } from "hono";
import { mountAgentsRoutes } from "../src/server/modules/agent/agents-api.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { freshAgentEnv, freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("AgentUserMessageQueue: idle submit appends immediately and starts one wake", () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-idle-");
  try {
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
      scope: "manager",
      scopeId: null,
      content: "hello",
      clientRequestId: "local-1"
    });

    expect(result.queued).toBe(false);
    expect(result.messageId).toBeTruthy();
    expect(result.wakeId).toBe("wake-1");
    const thread = agentStore.getThreadByScope("manager", null)!;
    const messages = agentStore.getActiveMessages(thread.id);
    expect(messages.length).toBe(1);
    expect(messages[0]!.content).toEqual({
      type: "text",
      text: "hello",
      clientRequestId: "local-1"
    });
    expect(wakes).toEqual([{
      threadId: thread.id,
      reason: "user",
      triggerMessageId: result.messageId
    }]);
    expect(emitted.map((e) => e.event)).toEqual(["agentMessageAppended"]);
  } finally { cleanup(); }
});

test("AgentUserMessageQueue: busy submit queues and later flushes all messages into one wake", () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-busy-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
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
      scope: "manager", scopeId: null, content: "first", clientRequestId: "local-1"
    });
    const second = queue.submitUserMessage({
      scope: "manager", scopeId: null, content: "second", clientRequestId: "local-2"
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
    expect(emitted.map((e) => e.event)).toEqual([
      "agentMessageAppended",
      "agentMessageAppended"
    ]);
  } finally { cleanup(); }
});

test("AgentUserMessageQueue: queued messages can be flushed into a running thread without starting a wake", () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-running-flush-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
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
      scope: "manager", scopeId: null, content: "while busy", clientRequestId: "local-busy"
    });
    expect(result.queued).toBe(true);
    expect(result.queuedReason).toBe("running_wake");
    expect(queue.pendingCount(thread.id)).toBe(1);

    const flushed = queue.flushQueuedIntoThread(thread.id);
    expect(flushed.length).toBe(1);
    expect(queue.pendingCount(thread.id)).toBe(0);
    expect(wakes).toEqual([]);
    expect(agentStore.getActiveMessages(thread.id).map((m) => m.content.type === "text" ? m.content.text : ""))
      .toEqual(["while busy"]);
    expect(emitted.map((e) => e.event)).toEqual(["agentMessageAppended"]);
  } finally { cleanup(); }
});

test("AgentUserMessageQueue: thread submit can decline in-memory queue when busy", () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-decline-busy-");
  try {
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
  } finally { cleanup(); }
});

test("AgentUserMessageQueue: thread submit preserves caller source after queued flush", () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-thread-source-");
  try {
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
    expect((messages[0]!.content as any).text).toBe("queued overview work");
    expect(wakes).toEqual([{
      threadId: thread.id,
      reason: "user",
      triggerMessageId: messages[0]!.id
    }]);
  } finally { cleanup(); }
});

test("AgentUserMessageQueue: pending task wake callback only fires for running-wake flush", () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-task-wake-flush-");
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-task-wake");
    const flushedTaskMessages: string[] = [];
    let busy = true;
    const queue = new AgentUserMessageQueue({
      agentStore,
      wakeScheduler: {
        wake: () => "wake-1",
        isThreadBusy: () => busy
      },
      onPendingTaskMessageFlushed: (threadId) => flushedTaskMessages.push(threadId)
    });

    queue.submitThreadUserMessage({
      threadId: thread.id,
      source: "manager",
      sourceThreadId: "thread-overview",
      content: "task while running",
      pendingTaskWakeOnFlush: true
    });
    expect(flushedTaskMessages).toEqual([]);

    const flushed = queue.flushQueuedIntoThread(thread.id);
    expect(flushed).toHaveLength(1);
    expect(flushedTaskMessages).toEqual([thread.id]);

    busy = true;
    queue.submitThreadUserMessage({
      threadId: thread.id,
      source: "manager",
      sourceThreadId: "thread-overview",
      content: "task through idle flush",
      pendingTaskWakeOnFlush: true
    });
    busy = false;
    expect(queue.flushIfIdle(thread.id)).toBe("wake-1");
    expect(flushedTaskMessages).toEqual([thread.id]);
  } finally { cleanup(); }
});

test("AgentUserMessageQueue: direct feature message clears stale review prompt", () => {
  const { projects, features, agentStore, store, cleanup } = freshStoresEnv("md-user-queue-feature-review-");
  try {
    const projectId = seedProject(projects);
    const featureId = seedFeature(features, projectId);
    const workItems = new WorkItemStore(store.db);
    const item = workItems.getByFeature(featureId)!;
    workItems.update(item.id, { needsUser: "review" });

    const emitted: any[] = [];
    const queue = new AgentUserMessageQueue({
      agentStore,
      workStore: workItems,
      sse: { emit: (event, data) => emitted.push({ event, data }) },
      wakeScheduler: {
        wake: () => "wake-1",
        isThreadBusy: () => false
      }
    });

    const result = queue.submitUserMessage({
      scope: "worker",
      scopeId: featureId,
      content: "继续改一下"
    });

    expect(result.queued).toBe(false);
    expect(workItems.getByFeature(featureId)!.needsUser).toBeNull();
    expect(emitted.map((e) => e.event)).toContain("workItemUpdated");
  } finally { cleanup(); }
});

test("AgentUserMessageQueue: removeQueuedMessage drops a queued message before flush", () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-remove-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    let busy = true;
    const queue = new AgentUserMessageQueue({
      agentStore,
      wakeScheduler: {
        wake: () => "wake-1",
        isThreadBusy: () => busy
      }
    });

    queue.submitUserMessage({
      scope: "manager", scopeId: null, content: "first", clientRequestId: "local-1"
    });
    queue.submitUserMessage({
      scope: "manager", scopeId: null, content: "second", clientRequestId: "local-2"
    });

    expect(queue.removeQueuedMessage(thread.id, "local-1")).toBe(true);
    expect(queue.removeQueuedMessage(thread.id, "missing")).toBe(false);
    expect(queue.pendingCount(thread.id)).toBe(1);

    busy = false;
    expect(queue.flushIfIdle(thread.id)).toBe("wake-1");
    const messages = agentStore.getActiveMessages(thread.id);
    expect(messages.map((m) => m.content.type === "text" ? m.content.text : "")).toEqual(["second"]);
  } finally { cleanup(); }
});

test("AgentUserMessageQueue: recovered interrupted wake does not keep later messages queued", () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-recover-");
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
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
      scope: "manager", scopeId: null, content: "after restart", clientRequestId: "local-1"
    });

    expect(result.queued).toBe(false);
    expect(result.messageId).toBeTruthy();
    expect(wakes.length).toBe(1);
    expect(agentStore.getWakeById(interrupted.id)?.status).toBe("error");
  } finally { cleanup(); }
});

test("agents API: DELETE queued message cancels a busy queued user message", async () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-queue-route-");
  try {
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
        manager: { verifyScopeId: (scopeId: string | null) => scopeId === null ? null : "manager scopeId must be null" },
        worker: { verifyScopeId: () => "feature not found" }
      }
    } as any);

    const post = await app.request("/api/agents/manager/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "cancel me", clientRequestId: "local-route" })
    });
    expect(post.status).toBe(202);
    expect(await post.json()).toMatchObject({ queued: true, messageId: null });

    const thread = agentStore.getThreadByScope("manager", null)!;
    expect(queue.pendingCount(thread.id)).toBe(1);

    const del = await app.request("/api/agents/manager/queued-messages/local-route", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, removed: true });
    expect(queue.pendingCount(thread.id)).toBe(0);

    busy = false;
    expect(queue.flushIfIdle(thread.id)).toBe(null);
    expect(agentStore.getActiveMessages(thread.id)).toEqual([]);
  } finally { cleanup(); }
});

test("agents API: attached work item refs are enriched before append", async () => {
  const { agentStore, cleanup } = freshAgentEnv("md-user-work-item-ref-");
  try {
    const app = new Hono();
    mountAgentsRoutes(app, {
      agentStore,
      wakeScheduler: { wake: () => "wake-1" },
      workStore: {
        get: () => ({
          id: "wi-1",
          featureId: "feat-1",
          projectId: "proj-1",
          title: "Review console init",
          summary: "Local validation passed; needs user review.",
          canvasId: null,
          needsUser: "review",
          phase: "verifying",
          phaseDetail: "ready",
          lastActivityAt: "2026-05-28T00:00:00.000Z",
          createdAt: "2026-05-28T00:00:00.000Z",
          updatedAt: "2026-05-28T00:00:00.000Z"
        })
      },
      scopes: {
        manager: { verifyScopeId: (scopeId: string | null) => scopeId === null ? null : "manager scopeId must be null" },
        worker: { verifyScopeId: () => "feature not found" }
      }
    } as any);

    const res = await app.request("/api/agents/manager/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "这个可以删掉了",
        workItemRef: { itemId: "wi-1", snapshotAt: "2026-05-28T10:00:00.000Z" }
      })
    });
    expect(res.status).toBe(202);

    const thread = agentStore.getThreadByScope("manager", null)!;
    const message = agentStore.getActiveMessages(thread.id)[0]!;
    expect(message.content.type).toBe("text");
    expect(message.content.metadata?.workItemRef).toMatchObject({
      itemId: "wi-1",
      snapshotAt: "2026-05-28T10:00:00.000Z",
      title: "Review console init",
      summary: "Local validation passed; needs user review.",
      projectId: "proj-1",
      featureId: "feat-1",
      needsUser: "review",
      phase: "verifying",
      phaseDetail: "ready"
    });
  } finally { cleanup(); }
});
