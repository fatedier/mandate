import { expect, test } from "bun:test";
import {
  buildFeatureTaskSendTool,
  buildFeatureTaskTools
} from "../src/server/modules/agent/tools/feature-task-tools.js";
import { buildFeatureMessageSendTool } from "../src/server/modules/agent/tools/feature-message-tools.js";
import { isFeatureMessageRequest } from "../src/shared/feature-message.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { ToolDispatcher, ToolRegistry } from "../src/server/modules/agent/tool-registry.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

class CapturingSse {
  events: Array<{ name: string; data: any }> = [];
  emit(name: string, data: any) {
    this.events.push({ name, data });
  }
}

test("feature_message_send queues a conversation turn without creating a task", async () => {
  const env = freshStoresEnv("md-feature-message-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const wakeCalls: any[] = [];
    const tool = buildFeatureMessageSendTool({
      agentStore: env.agentStore,
      featuresStore: env.features,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return "wake-message";
        }
      }
    });

    const result = await tool.handler(
      { featureId, message: "Can you clarify the current approach?" },
      { threadId: callerThread.id, wakeId: "caller-wake", scope: {} } as any
    );

    const featureThread = env.agentStore.getThreadByScope("worker", featureId)!;
    expect(result).toEqual({ featureThreadId: featureThread.id, status: "started" });
    expect(env.agentStore.listTasksForThread(featureThread.id)).toEqual([]);
    expect(env.agentStore.getActiveMessages(featureThread.id)).toEqual([]);
    expect(wakeCalls).toEqual([[featureThread.id, "user", null]]);

    const wake = env.agentStore.createWake({
      threadId: featureThread.id,
      reason: "user",
      triggerMessageId: null
    });
    const delivered = env.agentStore.drainMailboxToMessages(featureThread.id, wake.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.sourceThreadId).toBe(callerThread.id);
    expect(isFeatureMessageRequest(delivered[0]!.content)).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("feature_task_send appends work to feature main thread and schedules wake", async () => {
  const env = freshStoresEnv("md-feature-task-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const sse = new CapturingSse();
    const wakeCalls: any[] = [];

    const tool = buildFeatureTaskSendTool({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: sse as any,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return "wake-1";
        },
        getRunningWakeForThread: () => null
      }
    });

    const result = await tool.handler(
      { feature: featureId, title: "Fix test", message: "Please fix the failing test." },
      { threadId: callerThread.id, wakeId: "caller-wake", scope: {} } as any
    );

    expect(result).toMatchObject({ status: "started" });
    expect(result.taskId).toBeTruthy();
    const featureThread = env.agentStore.getThreadByScope("worker", featureId)!;
    expect(result.featureThreadId).toBe(featureThread.id);

    const tasks = env.agentStore.listTasksForThread(featureThread.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: result.taskId,
      title: "Fix test",
      status: "queued",
      channel: "manager",
      callerThreadId: callerThread.id
    });

    const messages = env.agentStore.getActiveMessages(featureThread.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].source).toBe("manager");
    expect(messages[0].sourceThreadId).toBe(callerThread.id);
    expect(messages[0].content.type).toBe("text");
    expect((messages[0].content as any).text).toContain("Please fix the failing test.");
    expect(wakeCalls).toEqual([[featureThread.id, "user", messages[0].id]]);
    expect(sse.events.some((event) => event.name === "agentMessageAppended")).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("feature_task_send marks pending wake when feature thread is busy", async () => {
  const env = freshStoresEnv("md-feature-task-busy-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const pending: string[] = [];

    const tool = buildFeatureTaskSendTool({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: new CapturingSse() as any,
      wakeScheduler: {
        wake: () => null,
        getRunningWakeForThread: () => null
      },
      markPendingTaskWake: (threadId) => pending.push(threadId)
    });

    const result = await tool.handler(
      { feature: featureId, message: "Second task" },
      { threadId: callerThread.id, wakeId: "caller-wake", scope: {} } as any
    );

    const featureThread = env.agentStore.getThreadByScope("worker", featureId)!;
    expect(result).toMatchObject({ status: "queued", featureThreadId: featureThread.id });
    expect(pending).toEqual([featureThread.id]);
  } finally {
    env.cleanup();
  }
});

test("feature_task_send queues mailbox while feature thread is running", async () => {
  const env = freshStoresEnv("md-feature-task-running-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const sse = new CapturingSse();
    const wakeCalls: any[] = [];
    const pending: string[] = [];
    const queue = new AgentUserMessageQueue({
      agentStore: env.agentStore,
      sse: sse as any,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return `wake-${wakeCalls.length}`;
        },
        isThreadBusy: (threadId) => threadId === featureThread.id
      }
    });

    const tool = buildFeatureTaskSendTool({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: sse as any,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return `direct-wake-${wakeCalls.length}`;
        },
        getRunningWakeForThread: () => null
      },
      userMessageQueue: queue,
      markPendingTaskWake: (threadId) => pending.push(threadId)
    });

    const result = await tool.handler(
      { feature: featureId, message: "Continue after the limit event.", title: "Continue" },
      { threadId: callerThread.id, wakeId: "caller-wake", scope: {} } as any
    );

    expect(result).toMatchObject({ status: "queued", featureThreadId: featureThread.id });
    expect(queue.pendingCount(featureThread.id)).toBe(0);
    expect(env.agentStore.hasQueuedFeatureTaskDispatchMailboxMessages(featureThread.id)).toBe(true);
    expect(env.agentStore.getActiveMessages(featureThread.id)).toEqual([]);
    expect(wakeCalls).toEqual([]);
    expect(pending).toEqual([]);

    const drained = env.agentStore.drainMailboxToMessages(featureThread.id, "wake-after-running");
    expect(drained).toHaveLength(1);

    const messages = env.agentStore.getActiveMessages(featureThread.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.source).toBe("manager");
    expect(messages[0]!.sourceThreadId).toBe(callerThread.id);
    expect(messages[0]!.content.type).toBe("text");
    expect((messages[0]!.content as any).text).toContain("Continue after the limit event.");
    expect(wakeCalls).toEqual([]);
    expect(sse.events.map((event) => event.name)).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("feature_task_send marks pending task wake after queued running-wake message flushes", async () => {
  const env = freshStoresEnv("md-feature-task-running-wake-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const sse = new CapturingSse();
    const wakeCalls: any[] = [];
    const pending: string[] = [];
    const queue = new AgentUserMessageQueue({
      agentStore: env.agentStore,
      sse: sse as any,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return `wake-${wakeCalls.length}`;
        },
        isThreadBusy: () => true
      },
      onPendingTaskMessageFlushed: (threadId) => pending.push(threadId)
    });
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);

    const tool = buildFeatureTaskSendTool({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: sse as any,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return `direct-wake-${wakeCalls.length}`;
        },
        getRunningWakeForThread: () => ({ id: "wake-running", reason: "user", startedAt: "now" })
      },
      userMessageQueue: queue,
      markPendingTaskWake: (threadId) => pending.push(threadId)
    });

    const result = await tool.handler(
      { feature: featureId, message: "Follow-up after this wake.", title: "Follow-up" },
      { threadId: callerThread.id, wakeId: "caller-wake", scope: {} } as any
    );

    expect(result).toMatchObject({ status: "queued", featureThreadId: featureThread.id });
    expect(queue.pendingCount(featureThread.id)).toBe(0);
    expect(env.agentStore.hasQueuedFeatureTaskDispatchMailboxMessages(featureThread.id)).toBe(true);
    expect(env.agentStore.getActiveMessages(featureThread.id)).toEqual([]);
    expect(wakeCalls).toEqual([]);
    expect(pending).toEqual([]);

    const flushed = env.agentStore.drainMailboxToMessages(featureThread.id, "wake-running");
    expect(flushed).toHaveLength(1);
    expect(queue.pendingCount(featureThread.id)).toBe(0);
    if (flushed[0]!.content.type === "text" && flushed[0]!.content.metadata?.featureTaskDispatch) {
      pending.push(featureThread.id);
    }
    expect(pending).toEqual([featureThread.id]);
  } finally {
    env.cleanup();
  }
});

test("feature_task_send clears stale review prompt when new work starts", async () => {
  const env = freshStoresEnv("md-feature-task-clear-review-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const workStore = new WorkItemStore(env.store.db);
    const item = workStore.getByFeature(featureId)!;
    workStore.update(item.id, { needsUser: "review" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const sse = new CapturingSse();

    const tool = buildFeatureTaskSendTool({
      agentStore: env.agentStore,
      featuresStore: env.features,
      workStore,
      sse: sse as any,
      wakeScheduler: {
        wake: () => "wake-1",
        getRunningWakeForThread: () => null
      }
    });

    const result = await tool.handler(
      { feature: featureId, title: "New work", message: "Start the next task." },
      { threadId: callerThread.id, wakeId: "caller-wake", scope: {} } as any
    );

    expect(result).toMatchObject({ status: "started" });
    expect(workStore.getByFeature(featureId)?.needsUser).toBeNull();
    expect(sse.events.some((event) => event.name === "workItemUpdated")).toBe(true);
  } finally {
    env.cleanup();
  }
});

test("feature_task_send does not clear input prompt", async () => {
  const env = freshStoresEnv("md-feature-task-keep-input-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const workStore = new WorkItemStore(env.store.db);
    const item = workStore.getByFeature(featureId)!;
    workStore.update(item.id, { needsUser: "input" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);

    const tool = buildFeatureTaskSendTool({
      agentStore: env.agentStore,
      featuresStore: env.features,
      workStore,
      sse: new CapturingSse() as any,
      wakeScheduler: {
        wake: () => "wake-1",
        getRunningWakeForThread: () => null
      }
    });

    await tool.handler(
      { feature: featureId, title: "Follow up", message: "Try more work." },
      { threadId: callerThread.id, wakeId: "caller-wake", scope: {} } as any
    );

    expect(workStore.getByFeature(featureId)?.needsUser).toBe("input");
  } finally {
    env.cleanup();
  }
});

test("task_claim and task_update clear stale review prompt", async () => {
  const env = freshStoresEnv("md-feature-task-claim-clear-review-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const workStore = new WorkItemStore(env.store.db);
    const item = workStore.getByFeature(featureId)!;
    workStore.update(item.id, { needsUser: "review" });
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const task = env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Do work",
      message: "Do work"
    });
    const sse = new CapturingSse();
    const tools = buildFeatureTaskTools({
      agentStore: env.agentStore,
      featuresStore: env.features,
      workStore,
      sse: sse as any,
      wakeScheduler: {
        wake: () => "wake-1",
        getRunningWakeForThread: () => null
      }
    });
    const claim = tools.find((tool) => tool.name === "task_claim")!;
    const update = tools.find((tool) => tool.name === "task_update")!;

    await claim.handler({ taskId: task.id }, { threadId: featureThread.id, wakeId: "fw", scope: {} } as any);
    expect(workStore.getByFeature(featureId)?.needsUser).toBeNull();

    workStore.update(item.id, { needsUser: "review" });
    await update.handler(
      { taskId: task.id, status: "waiting", note: "Waiting for a pane." },
      { threadId: featureThread.id, wakeId: "fw", scope: {} } as any
    );
    expect(workStore.getByFeature(featureId)?.needsUser).toBeNull();
    expect(sse.events.filter((event) => event.name === "workItemUpdated").length).toBeGreaterThanOrEqual(2);
  } finally {
    env.cleanup();
  }
});

test("task_complete marks done and notifies caller when callerThreadId is set", async () => {
  // Tasks dispatched by overview have callerThreadId — task_complete should
  // close the queue item AND wake the caller with a completion event.
  const env = freshStoresEnv("md-feature-task-complete-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const workStore = new WorkItemStore(env.store.db);
    const workItem = workStore.getByFeature(featureId)!;
    workStore.update(workItem.id, { title: "Implement source labels", canvasId: "canvas_stub" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const task = env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Do work",
      message: "Do work",
      callerThreadId: callerThread.id,
      createdByThreadId: callerThread.id
    });
    const sse = new CapturingSse();
    const wakeCalls: any[] = [];
    const complete = buildFeatureTaskTools({
      agentStore: env.agentStore,
      projectsStore: env.projects,
      featuresStore: env.features,
      workStore,
      sse: sse as any,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return "caller-wake";
        },
        getRunningWakeForThread: () => null
      }
    }).find((tool) => tool.name === "task_complete")!;

    const result = await complete.handler(
      { taskId: task.id, summary: "Done." },
      { threadId: featureThread.id, wakeId: "feature-wake", scope: {} } as any
    );

    expect(result).toMatchObject({ ok: true, notifiedCaller: true, callerWakeId: "caller-wake" });
    expect(env.agentStore.getTaskById(task.id)?.status).toBe("done");
    // Mailbox event written to caller with kind=completion and source snapshot.
    expect(env.agentStore.hasQueuedFeatureEvents(callerThread.id)).toBe(true);
    const events = env.agentStore.listPendingFeatureEvents(callerThread.id, 50);
    expect(events).toHaveLength(1);
    const content = events[0]!.content;
    expect(content.type).toBe("feature_event");
    expect(content.kind).toBe("completion");
    expect(content.workItemId).toBe(workItem.id);
    expect(content.source?.project?.name).toBe("P");
    expect(content.source?.feature.name).toBe("F");
    expect(content.source?.workItem?.id).toBe(workItem.id);
    expect(content.source?.workItem?.title).toBe("Implement source labels");
    expect(wakeCalls.filter((c) => c[0] === callerThread.id)).toHaveLength(1);
    expect(wakeCalls[0]?.[3]?.featureEvents?.[0]).toMatchObject({
      type: "feature_event",
      kind: "completion",
      source: {
        project: { name: "P" },
        feature: { name: "F" },
        workItem: { id: workItem.id, title: "Implement source labels" }
      }
    });
  } finally {
    env.cleanup();
  }
});

test("task_complete ignores unknown extra args (zod strips them)", async () => {
  // Unrecognised fields (e.g. notifyCaller, notifyUser) are stripped by zod
  // before reaching the handler. Behaviour matches the standard case: caller
  // gets notified because callerThreadId is set.
  const env = freshStoresEnv("md-feature-task-complete-ignore-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const task = env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Do work",
      message: "Do work",
      callerThreadId: callerThread.id,
      createdByThreadId: callerThread.id
    });
    const wakeCalls: any[] = [];
    const registry = new ToolRegistry();
    for (const tool of buildFeatureTaskTools({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: new CapturingSse() as any,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return "caller-wake";
        },
        getRunningWakeForThread: () => null
      }
    })) {
      registry.register(tool);
    }
    const dispatcher = new ToolDispatcher(registry);

    const dispatched = await dispatcher.dispatch(
      {
        toolCallId: "call-1",
        toolName: "task_complete",
        args: { taskId: task.id, summary: "Done.", notifyCaller: false }
      },
      { threadId: featureThread.id, wakeId: "feature-wake", scope: {} } as any
    );

    expect(dispatched.isError).toBeFalsy();
    expect(dispatched.result).toMatchObject({ ok: true, notifiedCaller: true });
    expect(env.agentStore.getTaskById(task.id)?.status).toBe("done");
    expect(env.agentStore.hasQueuedFeatureEvents(callerThread.id)).toBe(true);
    expect(wakeCalls.filter((c) => c[0] === callerThread.id)).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});

test("task_complete marks pending mailbox wake when caller is busy", async () => {
  // When the caller's thread is already running a wake (wakeScheduler.wake returns null),
  // task_complete must call markPendingMailboxWake so the caller picks the event up
  // on its next idle cycle.
  const env = freshStoresEnv("md-feature-task-mailbox-busy-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const task = env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Do work",
      message: "Do work",
      callerThreadId: callerThread.id,
      createdByThreadId: callerThread.id
    });
    const pending: string[] = [];
    const complete = buildFeatureTaskTools({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: new CapturingSse() as any,
      wakeScheduler: {
        wake: () => null,
        getRunningWakeForThread: () => null
      },
      markPendingMailboxWake: (threadId) => pending.push(threadId)
    }).find((tool) => tool.name === "task_complete")!;

    const result = await complete.handler(
      { taskId: task.id, summary: "Done." },
      { threadId: featureThread.id, wakeId: "feature-wake", scope: {} } as any
    );

    // notifiedCaller=true but wake returned null → markPendingMailboxWake called instead
    expect(result).toMatchObject({ ok: true, notifiedCaller: true });
    expect(env.agentStore.hasQueuedFeatureEvents(callerThread.id)).toBe(true);
    expect(pending).toContain(callerThread.id);
  } finally {
    env.cleanup();
  }
});

test("task_notify_caller with kind=blocked escalates with signal=blocked", async () => {
  const env = freshStoresEnv("md-feature-task-notify-blocked-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const workStore = new WorkItemStore(env.store.db);
    const workItem = workStore.getByFeature(featureId)!;
    workStore.update(workItem.id, { title: "Investigate blocker" });
    const callerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const task = env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Do work",
      message: "Do work",
      callerThreadId: callerThread.id,
      createdByThreadId: callerThread.id
    });

    const wakeCalls: any[] = [];
    const notify = buildFeatureTaskTools({
      agentStore: env.agentStore,
      projectsStore: env.projects,
      featuresStore: env.features,
      workStore,
      sse: new CapturingSse() as never,
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return "wake-x";
        },
        getRunningWakeForThread: () => null
      }
    }).find((tool) => tool.name === "task_notify_caller")!;

    await notify.handler(
      { taskId: task.id, message: "Waiting for approval", kind: "blocked" },
      { threadId: featureThread.id, wakeId: "feature-wake", scope: {} } as never
    );

    // blocked escalates — verify via listPendingFeatureEvents.
    const events = env.agentStore.listPendingFeatureEvents(callerThread.id, 50);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.content.type).toBe("feature_event");
    expect(evt.content.kind).toBe("escalation");
    if (evt.content.kind !== "escalation") throw new Error("expected an escalation event");
    expect(evt.content.signal).toBe("blocked");
    expect(evt.content.summary).toBe("Waiting for approval");
    expect(evt.content.workItemId).toBe(workItem.id);
    expect(evt.content.source?.project?.name).toBe("P");
    expect(evt.content.source?.feature.name).toBe("F");
    expect(evt.content.source?.workItem?.id).toBe(workItem.id);
    expect(evt.content.source?.workItem?.title).toBe("Investigate blocker");
    expect(wakeCalls[0]?.[3]?.featureEvents?.[0]).toMatchObject({
      type: "feature_event",
      kind: "escalation",
      signal: "blocked",
      source: {
        project: { name: "P" },
        feature: { name: "F" },
        workItem: { id: workItem.id, title: "Investigate blocker" }
      }
    });
  } finally {
    env.cleanup();
  }
});
