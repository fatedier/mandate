import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import {
  buildFeatureTaskTools
} from "../src/server/modules/agent/tools/feature-task-tools.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

class CapturingSse {
  events: Array<{ name: string; data: unknown }> = [];
  emit(name: string, data: unknown) {
    this.events.push({ name, data });
  }
}

function newStore(): { store: AgentStore; db: Database } {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const store = new AgentStore(db);
  return { store, db };
}

function newOverviewThread(store: AgentStore): string {
  return store.getOrCreateThread("manager", null).id;
}

test("drainMailboxToMessages skips feature_event rows, only drains message rows", () => {
  // feature_event rows are NOT drained into agent_messages.
  const { store } = newStore();
  const threadId = newOverviewThread(store);

  store.enqueueMailboxMessage({
    threadId,
    role: "user",
    source: "user",
    content: { type: "text", text: "hi" }
  });
  store.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t-1",
      featureId: "feat-1",
      workItemId: null,
      label: "Login",
      summary: "done",
      signal: "blocked"
    }
  });

  const drained = store.drainMailboxToMessages(threadId, "wake-1");
  // Only the regular message is drained; feature_event stays in mailbox.
  expect(drained.length).toBe(1);
  expect(drained[0]!.content.type).toBe("text");

  // feature_event is still pending
  const events = store.listPendingFeatureEvents(threadId, 50);
  expect(events.length).toBe(1);
  expect(events[0]!.content.signal).toBe("blocked");
});

test("mailbox queued predicates keep messages and feature_events separate", () => {
  const { store } = newStore();
  const threadId = newOverviewThread(store);

  expect(store.hasQueuedMailboxMessages(threadId)).toBe(false);
  expect(store.hasQueuedFeatureEvents(threadId)).toBe(false);
  store.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t-1",
      featureId: "feat-1",
      workItemId: null,
      label: "Thing",
      summary: "done",
      signal: "blocked"
    }
  });
  expect(store.hasQueuedMailboxMessages(threadId)).toBe(false);
  expect(store.hasQueuedFeatureEvents(threadId)).toBe(true);

  store.enqueueMailboxMessage({
    threadId,
    role: "user",
    source: "user",
    content: { type: "text", text: "hi" }
  });
  expect(store.hasQueuedMailboxMessages(threadId)).toBe(true);
});

test("task_notify_caller with kind=blocked writes escalation with signal=blocked", async () => {
  // blocked escalates — produces kind=escalation with signal=blocked.
  const env = freshStoresEnv("md-feature-event-blocked-");
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

    const notify = buildFeatureTaskTools({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: new CapturingSse() as never,
      wakeScheduler: {
        wake: () => "wake-x",
        getRunningWakeForThread: () => null
      }
    }).find((tool) => tool.name === "task_notify_caller")!;

    await notify.handler(
      { taskId: task.id, message: "Waiting for approval", kind: "blocked" },
      { threadId: featureThread.id, wakeId: "feature-wake", scope: {} } as never
    );

    // feature_events are NOT drained into agent_messages. Verify via listPendingFeatureEvents.
    const events = env.agentStore.listPendingFeatureEvents(callerThread.id, 50);
    expect(events.length).toBe(1);
    const evt = events[0]!;
    expect(evt.content.type).toBe("feature_event");
    expect(evt.content.kind).toBe("escalation");
    expect(evt.content.signal).toBe("blocked");
    expect(evt.content.summary).toBe("Waiting for approval");
  } finally {
    env.cleanup();
  }
});

test("task_notify_caller with kind=needs_user writes escalation with signal=needs_user", async () => {
  const env = freshStoresEnv("md-feature-event-needs-user-");
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

    const notify = buildFeatureTaskTools({
      agentStore: env.agentStore,
      featuresStore: env.features,
      sse: new CapturingSse() as never,
      wakeScheduler: {
        wake: () => "wake-y",
        getRunningWakeForThread: () => null
      }
    }).find((tool) => tool.name === "task_notify_caller")!;

    await notify.handler(
      { taskId: task.id, message: "waiting for user input", kind: "needs_user", artifacts: [{
        type: "canvas",
        canvasId: "cnv-1",
        title: "Report",
        path: "/canvas/cnv-1",
        role: "report"
      }] },
      { threadId: featureThread.id, wakeId: "feature-wake", scope: {} } as never
    );

    const events = env.agentStore.listPendingFeatureEvents(callerThread.id, 50);
    expect(events.length).toBe(1);
    const evt = events[0]!;
    expect(evt.content.type).toBe("feature_event");
    expect(evt.content.kind).toBe("escalation");
    expect(evt.content.signal).toBe("needs_user");
    expect(evt.content.summary).toBe("waiting for user input");
    expect(evt.content.artifacts).toEqual([{
      type: "canvas",
      canvasId: "cnv-1",
      title: "Report",
      path: "/canvas/cnv-1",
      role: "report"
    }]);
  } finally {
    env.cleanup();
  }
});
