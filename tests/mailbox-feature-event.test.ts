import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { featureTaskDispatchMetadata } from "../src/server/modules/agent/feature-task-dispatch-message.js";

function setup() {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const agentStore = new AgentStore(db);
  // create overview thread to act as the recipient
  const thread = agentStore.getOrCreateThread("manager", null);
  return { db, agentStore, threadId: thread.id };
}

test("enqueueMailboxEvent writes event_kind='feature_event'", () => {
  const { db, agentStore, threadId } = setup();
  agentStore.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t-1",
      featureId: "f-1",
      workItemId: "wi-1",
      label: "x",
      summary: "blocker",
      signal: "blocked"
    }
  });
  const rows = db.prepare("select * from agent_mailbox where thread_id = ?").all(threadId) as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].event_kind).toBe("feature_event");
});

test("drainMailbox skips event_kind='feature_event'", () => {
  const { db, agentStore, threadId } = setup();

  // enqueue one regular message
  agentStore.enqueueMailboxMessage({
    threadId,
    role: "user",
    source: "user",
    content: { type: "text", text: "hello" }
  });

  // enqueue one feature_event
  agentStore.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t-1",
      featureId: "f-1",
      workItemId: null,
      label: "Work",
      summary: "blocked",
      signal: "blocked"
    }
  });

  // drain — should only produce 1 message (the regular message)
  const drained = agentStore.drainMailboxToMessages(threadId, "wake-1");
  expect(drained).toHaveLength(1);
  expect(drained[0]!.content.type).toBe("text");

  // assert agent_messages has exactly 1 row
  const msgRows = db.prepare("select * from agent_messages where thread_id = ?").all(threadId) as any[];
  expect(msgRows).toHaveLength(1);

  // assert feature_event mailbox row still has status='queued'
  const mbxRows = db.prepare(
    "select * from agent_mailbox where thread_id = ? and event_kind = 'feature_event'"
  ).all(threadId) as any[];
  expect(mbxRows).toHaveLength(1);
  expect(mbxRows[0].status).toBe("queued");
});

test("listPendingFeatureEvents returns only queued feature_event rows", () => {
  const { agentStore, threadId } = setup();

  // enqueue one regular message (event_kind='message')
  agentStore.enqueueMailboxMessage({
    threadId,
    role: "user",
    source: "user",
    content: { type: "text", text: "hello" }
  });

  // enqueue one feature_event
  agentStore.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t-2",
      featureId: "f-2",
      workItemId: null,
      label: "Feat",
      summary: "needs help",
      signal: "needs_user"
    }
  });

  const events = agentStore.listPendingFeatureEvents(threadId, 50);
  expect(events.length).toBe(1);
  expect(events[0]!.content.kind).toBe("escalation");
  expect(events[0]!.content.signal).toBe("needs_user");
});

test("queued mailbox predicates distinguish messages from feature_events", () => {
  const { agentStore, threadId } = setup();

  expect(agentStore.hasQueuedMailboxMessages(threadId)).toBe(false);
  expect(agentStore.hasQueuedFeatureEvents(threadId)).toBe(false);

  agentStore.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t-predicate",
      featureId: "f-predicate",
      workItemId: null,
      label: "Predicate",
      summary: "blocked",
      signal: "blocked"
    }
  });

  expect(agentStore.hasQueuedMailboxMessages(threadId)).toBe(false);
  expect(agentStore.hasQueuedFeatureEvents(threadId)).toBe(true);

  agentStore.enqueueMailboxMessage({
    threadId,
    role: "user",
    source: "user",
    content: { type: "text", text: "hello" }
  });

  expect(agentStore.hasQueuedMailboxMessages(threadId)).toBe(true);
  expect(agentStore.hasQueuedFeatureEvents(threadId)).toBe(true);
});

test("queued mailbox thread listing includes all durable turn messages", () => {
  const { agentStore, threadId } = setup();
  expect(agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([]);

  agentStore.enqueueMailboxMessage({
    threadId,
    role: "user",
    source: "manager",
    sourceThreadId: "caller-thread",
    content: { type: "text", text: "conversation message" }
  });
  expect(agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([threadId]);

  agentStore.drainMailboxToMessages(threadId, "wake-message");
  expect(agentStore.listThreadIdsWithQueuedMailboxMessages()).toEqual([]);
  expect(agentStore.listMailboxMessagesDeliveredToWake("wake-message")).toHaveLength(1);
});

test("feature task dispatch mailbox predicates find durable queued task messages", () => {
  const { agentStore, threadId } = setup();

  expect(agentStore.hasQueuedFeatureTaskDispatchMailboxMessages(threadId)).toBe(false);
  expect(agentStore.listThreadIdsWithQueuedFeatureTaskDispatchMailboxMessages()).toEqual([]);

  agentStore.enqueueMailboxMessage({
    threadId,
    role: "user",
    source: "manager",
    sourceThreadId: "thread-overview",
    content: {
      type: "text",
      text: "regular queued message"
    }
  });
  expect(agentStore.hasQueuedFeatureTaskDispatchMailboxMessages(threadId)).toBe(false);

  agentStore.enqueueMailboxMessage({
    threadId,
    role: "user",
    source: "manager",
    sourceThreadId: "thread-overview",
    content: {
      type: "text",
      text: "queued task",
      metadata: featureTaskDispatchMetadata("task-1")
    }
  });

  expect(agentStore.hasQueuedFeatureTaskDispatchMailboxMessages(threadId)).toBe(true);
  expect(agentStore.listThreadIdsWithQueuedFeatureTaskDispatchMailboxMessages()).toEqual([threadId]);
});

test("markFeatureEventsProcessed flips status to 'delivered'", () => {
  const { agentStore, threadId } = setup();

  agentStore.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t-3",
      featureId: "f-3",
      workItemId: null,
      label: "Thing",
      summary: "blocked again",
      signal: "blocked"
    }
  });

  const before = agentStore.listPendingFeatureEvents(threadId, 50);
  expect(before).toHaveLength(1);

  agentStore.markFeatureEventsProcessed([before[0]!.id]);

  const after = agentStore.listPendingFeatureEvents(threadId, 50);
  expect(after).toHaveLength(0);
});

test("enqueueMailboxEvent does NOT drain into agent_messages", () => {
  const { db, agentStore, threadId } = setup();

  // enqueue a feature_event only
  agentStore.enqueueMailboxEvent({
    threadId,
    role: "user",
    source: "feature-event",
    sourceThreadId: null,
    content: {
      type: "feature_event",
      kind: "escalation",
      taskId: "t-4",
      featureId: "f-4",
      workItemId: null,
      label: "Blocked work",
      summary: "totally stuck",
      signal: "blocked"
    }
  });

  // drain
  const drained = agentStore.drainMailboxToMessages(threadId, "wake-2");
  expect(drained).toHaveLength(0);

  // no agent_messages produced
  const msgRows = db.prepare("select * from agent_messages where thread_id = ?").all(threadId) as any[];
  expect(msgRows).toHaveLength(0);
});
