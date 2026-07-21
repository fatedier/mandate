import { expect, test } from "bun:test";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import {
  enqueueManagerLimitReachedEvent,
  wakeManagerForLimitReached
} from "../src/server/runtime/agent-limit-reached-events.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

test("enqueueManagerLimitReachedEvent writes a compact feature-level event without waking manager", () => {
  const env = freshStoresEnv("md-limit-event-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const workStore = new WorkItemStore(env.store.db);
    const workItem = workStore.getByFeature(featureId)!;
    const managerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Lower-priority task",
      message: "Build it",
      status: "active",
      priority: 1,
      callerThreadId: managerThread.id,
      createdByThreadId: managerThread.id
    });
    env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Higher-priority queued task",
      message: "Do later",
      status: "queued",
      priority: 10,
      callerThreadId: managerThread.id,
      createdByThreadId: managerThread.id
    });
    const wake = env.agentStore.createWake({
      threadId: featureThread.id,
      reason: "user",
      triggerMessageId: null
    });
    env.agentStore.appendMessage({
      threadId: featureThread.id,
      role: "assistant",
      source: "self",
      wakeId: wake.id,
      content: {
        type: "assistant",
        text: "Implemented backend metadata, tests still pending."
      }
    });
    const wakeCalls: any[] = [];

    const result = enqueueManagerLimitReachedEvent({
      agentStore: env.agentStore,
      projectsStore: env.projects,
      featuresStore: env.features,
      workStore
    }, {
      threadId: featureThread.id,
      wakeId: wake.id,
      stepCount: 201
    });

    expect(result.enqueued).toBe(true);
    if (!result.enqueued) throw new Error("expected limit event to be enqueued");
    const sourceCapturedAt = result.featureEvent.source?.capturedAt;
    expect(typeof sourceCapturedAt).toBe("string");
    expect(result).toMatchObject({
      enqueued: true,
      overviewThreadId: managerThread.id,
      featureEvent: {
        type: "feature_event",
        kind: "limit_reached",
        featureId,
        workItemId: workItem.id,
        source: {
          project: { id: projectId, name: "P" },
          feature: { id: featureId, name: "F" },
          workItem: { id: workItem.id, title: workItem.title },
          capturedAt: sourceCapturedAt
        },
        label: workItem.title,
        summary: "Implemented backend metadata, tests still pending.",
        stepCount: 201
      }
    });
    expect(wakeCalls).toEqual([]);

    const events = env.agentStore.listPendingFeatureEvents(managerThread.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toMatchObject({
      type: "feature_event",
      kind: "limit_reached",
      featureId,
      workItemId: workItem.id,
      source: {
        project: { id: projectId, name: "P" },
        feature: { id: featureId, name: "F" },
        workItem: { id: workItem.id, title: workItem.title },
        capturedAt: sourceCapturedAt
      },
      label: workItem.title,
      summary: "Implemented backend metadata, tests still pending.",
      stepCount: 201
    });
    expect("taskId" in events[0]!.content).toBe(false);
    expect(result.featureEvent).toEqual(events[0]!.content);

    const wakeId = wakeManagerForLimitReached({
      wakeScheduler: {
        wake: (...args) => {
          wakeCalls.push(args);
          return "overview-wake";
        }
      }
    }, result);
    expect(wakeId).toBe("overview-wake");
    expect(wakeCalls).toEqual([[
      managerThread.id,
      "feature-event",
      null,
      { featureEvents: [events[0]!.content] }
    ]]);
  } finally {
    env.cleanup();
  }
});

test("enqueueManagerLimitReachedEvent ignores feature threads when no overview thread exists", () => {
  const env = freshStoresEnv("md-limit-event-none-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const wakeCalls: any[] = [];

    const result = enqueueManagerLimitReachedEvent({
      agentStore: env.agentStore
    }, {
      threadId: featureThread.id,
      wakeId: "wake-missing",
      stepCount: 201
    });

    expect(result).toEqual({ enqueued: false });
    expect(wakeCalls).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("enqueueManagerLimitReachedEvent skips when the feature has no open tasks", () => {
  const env = freshStoresEnv("md-limit-event-no-open-tasks-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const managerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const task = env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Complete task",
      message: "Build it",
      status: "active",
      callerThreadId: managerThread.id,
      createdByThreadId: managerThread.id
    });
    env.agentStore.updateTask({ id: task.id, status: "done", lastNote: "Done." });
    const wake = env.agentStore.createWake({
      threadId: featureThread.id,
      reason: "user",
      triggerMessageId: null
    });

    const result = enqueueManagerLimitReachedEvent({
      agentStore: env.agentStore
    }, {
      threadId: featureThread.id,
      wakeId: wake.id,
      stepCount: 201
    });

    expect(result).toEqual({ enqueued: false });
    expect(env.agentStore.listPendingFeatureEvents(managerThread.id)).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("enqueueManagerLimitReachedEvent skips when this wake completed a caller-visible task", () => {
  const env = freshStoresEnv("md-limit-event-completed-task-");
  try {
    const projectId = seedProject(env.projects, { name: "P" });
    const featureId = seedFeature(env.features, projectId, { name: "F" });
    const managerThread = env.agentStore.getOrCreateThread("manager", null);
    const featureThread = env.agentStore.getOrCreateThread("worker", featureId);
    const completed = env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Complete task",
      message: "Build it",
      status: "active",
      callerThreadId: managerThread.id,
      createdByThreadId: managerThread.id
    });
    env.agentStore.createTask({
      featureId,
      threadId: featureThread.id,
      source: "agent",
      channel: "manager",
      title: "Remaining task",
      message: "Do next",
      status: "queued",
      callerThreadId: managerThread.id,
      createdByThreadId: managerThread.id
    });
    env.agentStore.updateTask({ id: completed.id, status: "done", lastNote: "Done." });
    const wake = env.agentStore.createWake({
      threadId: featureThread.id,
      reason: "user",
      triggerMessageId: null
    });
    env.agentStore.appendMessage({
      threadId: featureThread.id,
      role: "tool",
      source: "self",
      wakeId: wake.id,
      content: {
        type: "tool_result",
        toolCallId: "call-complete",
        toolName: "task_complete",
        result: { ok: true, notifiedCaller: true, callerWakeId: "wake-overview" }
      }
    });

    const result = enqueueManagerLimitReachedEvent({
      agentStore: env.agentStore
    }, {
      threadId: featureThread.id,
      wakeId: wake.id,
      stepCount: 201
    });

    expect(result).toEqual({ enqueued: false });
    expect(env.agentStore.hasOpenTasksForThread(featureThread.id)).toBe(true);
    expect(env.agentStore.listPendingFeatureEvents(managerThread.id)).toEqual([]);
  } finally {
    env.cleanup();
  }
});

test("wakeManagerForLimitReached marks pending mailbox wake when overview is busy", () => {
  const pending: string[] = [];
  const wakeCalls: any[] = [];

  const wakeId = wakeManagerForLimitReached({
    wakeScheduler: {
      wake: (...args) => {
        wakeCalls.push(args);
        return null;
      }
    },
    markPendingMailboxWake: (threadId) => pending.push(threadId)
  }, {
    enqueued: true,
    overviewThreadId: "thr-overview",
    featureEvent: {
      type: "feature_event",
      kind: "limit_reached",
      featureId: "feat-1",
      workItemId: null,
      label: "Feature wake limit reached",
      summary: "Hit the step budget.",
      stepCount: 201
    }
  });

  expect(wakeId).toBe(null);
  expect(wakeCalls).toEqual([[
    "thr-overview",
    "feature-event",
    null,
    {
      featureEvents: [{
        type: "feature_event",
        kind: "limit_reached",
        featureId: "feat-1",
        workItemId: null,
        label: "Feature wake limit reached",
        summary: "Hit the step budget.",
        stepCount: 201
      }]
    }
  ]]);
  expect(pending).toEqual(["thr-overview"]);
});
