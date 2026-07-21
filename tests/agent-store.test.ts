import { expect, test } from "bun:test";
import { freshAgentEnv } from "./helpers/fixtures.js";

const freshStore = () => freshAgentEnv("md-agent-");

test("AgentStore.getOrCreateThread: creates on first call, returns existing on second", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const t1 = agentStore.getOrCreateThread("worker", "feat-A");
    const t2 = agentStore.getOrCreateThread("worker", "feat-A");
    expect(t1.id).toBe(t2.id);
    expect(t1.scope).toBe("worker");
    expect(t1.scopeId).toBe("feat-A");
    expect(t1.archivedAt).toBe(null);
  } finally {
    cleanup();
  }
});

test("AgentStore.getOrCreateThread: separate threads per scope_id", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const a = agentStore.getOrCreateThread("worker", "feat-A");
    const b = agentStore.getOrCreateThread("worker", "feat-B");
    expect(a.id).not.toBe(b.id);
  } finally {
    cleanup();
  }
});

test("AgentStore.createSideThread: freezes parent context and keeps the main singleton", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const parent = agentStore.getOrCreateThread("worker", "feat-A");
    agentStore.appendMessage({
      threadId: parent.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "main question" }
    });
    agentStore.appendMessage({
      threadId: parent.id,
      role: "user",
      source: "runtime-context",
      content: { type: "text", text: "stale runtime context" }
    });
    agentStore.appendMessage({
      threadId: parent.id,
      role: "assistant",
      source: "self",
      content: { type: "assistant", text: "main answer" }
    });

    const side = agentStore.createSideThread(parent.id);
    expect(side.kind).toBe("side");
    expect(side.parentThreadId).toBe(parent.id);
    expect(side.ephemeral).toBe(true);
    expect(agentStore.getThreadByScope("worker", "feat-A")?.id).toBe(parent.id);
    expect(agentStore.getOpenSideThread(parent.id)?.id).toBe(side.id);
    expect(agentStore.getMessages(side.id)).toEqual([]);

    const active = agentStore.getActiveMessages(side.id);
    expect(active.map((message) => message.source)).toEqual([
      "user",
      "self",
      "side-boundary"
    ]);
    expect(active.every((message) => message.threadId === side.id)).toBe(true);
  } finally {
    cleanup();
  }
});

test("AgentStore.createSideThread: running wake snapshot ends at its trigger message", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const parent = agentStore.getOrCreateThread("manager", null);
    agentStore.appendMessage({
      threadId: parent.id,
      role: "assistant",
      source: "self",
      content: { type: "assistant", text: "previous answer" }
    });
    const trigger = agentStore.appendMessage({
      threadId: parent.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "current question" }
    });
    const wake = agentStore.createWake({
      threadId: parent.id,
      reason: "user",
      triggerMessageId: trigger.id
    });
    agentStore.appendMessage({
      threadId: parent.id,
      role: "assistant",
      source: "self",
      wakeId: wake.id,
      content: { type: "assistant", text: "partial output" }
    });

    const side = agentStore.createSideThread(parent.id);
    const inheritedTexts = agentStore.getActiveMessages(side.id).flatMap((message) => {
      if (message.content.type === "text") return [message.content.text];
      if (message.content.type === "assistant" && message.content.text) return [message.content.text];
      return [];
    });
    expect(inheritedTexts).toContain("current question");
    expect(inheritedTexts).not.toContain("partial output");
    expect(side.forkContextEndSeq).toBe(trigger.seq);
  } finally {
    cleanup();
  }
});

test("AgentStore side transfer: creation is idempotent and delivery records provenance", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const parent = agentStore.getOrCreateThread("manager", null);
    agentStore.appendMessage({
      threadId: parent.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "main" }
    });
    const side = agentStore.createSideThread(parent.id);
    const first = agentStore.createSideTransfer({
      sourceThreadId: side.id,
      clientRequestId: "req-1",
      content: "Useful side findings"
    });
    const duplicate = agentStore.createSideTransfer({
      sourceThreadId: side.id,
      clientRequestId: "req-1",
      content: "ignored duplicate"
    });
    expect(duplicate.id).toBe(first.id);

    const delivered = agentStore.deliverSideTransfer(first.id)!;
    expect(delivered.transfer.status).toBe("delivered");
    expect(delivered.message.source).toBe("side-summary");
    expect(delivered.message.sourceThreadId).toBe(side.id);
    expect(delivered.message.threadId).toBe(parent.id);
    expect(agentStore.deliverSideTransfer(first.id)).toBe(null);
  } finally {
    cleanup();
  }
});

test("AgentStore side transfer: archived parent requires explicit retargeting", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const parent = agentStore.getOrCreateThread("manager", null);
    agentStore.appendMessage({
      threadId: parent.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "main" }
    });
    const side = agentStore.createSideThread(parent.id);
    const transfer = agentStore.createSideTransfer({
      sourceThreadId: side.id,
      clientRequestId: "req-retarget",
      content: "Retarget me"
    });
    agentStore.archiveThread(parent.id);
    expect(agentStore.deliverSideTransfer(transfer.id)).toBe(null);
    expect(agentStore.getSideTransferById(transfer.id)?.status).toBe("needs_retarget");

    const fresh = agentStore.getOrCreateThread("manager", null);
    expect(agentStore.retargetSideTransfer(transfer.id, fresh.id)?.status).toBe("pending");
    expect(agentStore.deliverSideTransfer(transfer.id)?.message.threadId).toBe(fresh.id);
  } finally {
    cleanup();
  }
});

test("AgentStore.getThreadByScope: returns null when missing", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    expect(agentStore.getThreadByScope("worker", "nope")).toBe(null);
  } finally {
    cleanup();
  }
});

test("AgentStore.archiveThread: sets archived_at; new getOrCreate returns a new row", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const t1 = agentStore.getOrCreateThread("worker", "feat-A");
    agentStore.archiveThread(t1.id);
    const archived = agentStore.getThreadById(t1.id)!;
    expect(archived.archivedAt).toBeTruthy();
    const t2 = agentStore.getOrCreateThread("worker", "feat-A");
    expect(t1.id).not.toBe(t2.id);
  } finally {
    cleanup();
  }
});

test("AgentStore.appendMessage: assigns monotonic seq; getActiveMessages returns in order", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const m1 = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "hello" }
    });
    const m2 = agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "user",
      content: { type: "assistant", text: "hi back" }
    });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    const active = agentStore.getActiveMessages(thread.id);
    expect(active.length).toBe(2);
    expect(active[0].id).toBe(m1.id);
    expect(active[1].id).toBe(m2.id);
  } finally {
    cleanup();
  }
});

test("AgentStore.getActiveMessages: derives prompt history from appended compression summaries", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const m1 = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "old" }
    });
    const m2 = agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "user",
      content: { type: "assistant", text: "old reply" }
    });
    const summary = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "compression",
      content: {
        type: "summary",
        summary: "summarized",
        replacedRange: [1, 2],
        replacedCount: 2
      }
    });
    const active = agentStore.getActiveMessages(thread.id);
    expect(active.map((m) => m.id)).toEqual([summary.id]);
    const all = agentStore.getMessages(thread.id);
    expect(all).toEqual([m1, m2, summary]);
    const since = agentStore.getMessagesSince(thread.id, 0);
    expect(since.map((m) => m.id)).toEqual([m1.id, m2.id, summary.id]);
  } finally {
    cleanup();
  }
});

test("AgentStore.getMessagesPage: paginates desc with `before` seq", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    for (let i = 0; i < 5; i++) {
      agentStore.appendMessage({
        threadId: thread.id,
        role: "user",
        source: "user",
        content: { type: "text", text: `msg-${i}` }
      });
    }
    const page = agentStore.getMessagesPage(thread.id, { limit: 2 });
    expect(page.length).toBe(2);
    expect((page[0].content as any).text).toBe("msg-4");
    expect((page[1].content as any).text).toBe("msg-3");
    const next = agentStore.getMessagesPage(thread.id, { limit: 2, beforeSeq: page[1].seq });
    expect((next[0].content as any).text).toBe("msg-2");
  } finally {
    cleanup();
  }
});

test("AgentStore.createWake → updateWakeStepCount → finishWake lifecycle", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "go" }
    });
    const wake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: trigger.id
    });
    expect(wake.status).toBe("running");
    expect(wake.stepCount).toBe(0);

    agentStore.updateWakeStepCount(wake.id, 3);
    agentStore.finishWake(wake.id, "finished");

    const got = agentStore.getWakeById(wake.id)!;
    expect(got.status).toBe("finished");
    expect(got.stepCount).toBe(3);
    expect(got.finishedAt).toBeTruthy();
  } finally {
    cleanup();
  }
});

test("AgentStore.getMessageIdsForWake: returns ids of messages produced by + triggering this wake", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-A");
    const trigger = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "go" }
    });
    const wake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: trigger.id
    });
    const produced = agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "user",
      wakeId: wake.id,
      content: { type: "assistant", text: "ok" }
    });
    const ids = agentStore.getMessageIdsForWake(wake.id);
    expect(ids.sort()).toEqual([trigger.id, produced.id].sort());
  } finally {
    cleanup();
  }
});

test("AgentStore messages expose wakeReason derived from wakeId", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("manager", null);
    const wake = agentStore.createWake({
      threadId: thread.id,
      reason: "work-item-heartbeat",
      triggerMessageId: null
    });
    const produced = agentStore.appendMessage({
      threadId: thread.id,
      role: "assistant",
      source: "self",
      wakeId: wake.id,
      content: { type: "assistant", text: "checked active items" }
    });

    expect(produced.wakeReason).toBe("work-item-heartbeat");
    expect(agentStore.getMessageById(produced.id)?.wakeReason).toBe("work-item-heartbeat");
    expect(agentStore.getMessages(thread.id)[0]?.wakeReason).toBe("work-item-heartbeat");
    expect(agentStore.getActiveMessages(thread.id)[0]?.wakeReason).toBe("work-item-heartbeat");
    expect(agentStore.getMessagesPage(thread.id, { limit: 1 })[0]?.wakeReason).toBe(
      "work-item-heartbeat"
    );
    expect(agentStore.getMessagesSince(thread.id, 0)[0]?.wakeReason).toBe("work-item-heartbeat");
  } finally {
    cleanup();
  }
});

test("AgentStore.getContextUsage: returns latest wake input tokens", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context");
    const oldWake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: null
    });
    agentStore.updateWakeTokenUsage(oldWake.id, 10, 10);
    agentStore.finishWake(oldWake.id, "finished");
    const latestWake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: null
    });
    agentStore.updateWakeTokenUsage(latestWake.id, 42, 42);
    agentStore.finishWake(latestWake.id, "finished");

    expect(agentStore.getContextUsage(thread.id, 170).inputTokens).toBe(42);
    expect(agentStore.getContextUsage(thread.id, 170).budgetTokens).toBe(170);
  } finally {
    cleanup();
  }
});

test("AgentStore.getContextUsage: estimates active history after compression", () => {
  const { agentStore, cleanup } = freshStore();
  try {
    const thread = agentStore.getOrCreateThread("worker", "feat-context-compressed");
    agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "user",
      content: { type: "text", text: "large previous history ".repeat(500) }
    });
    const wake = agentStore.createWake({
      threadId: thread.id,
      reason: "user",
      triggerMessageId: null
    });
    agentStore.updateWakeTokenUsage(wake.id, 1000, 1000);
    agentStore.finishWake(wake.id, "finished");
    const summary = agentStore.appendMessage({
      threadId: thread.id,
      role: "user",
      source: "compression",
      content: {
        type: "summary",
        summary: "compressed",
        replacedRange: [0, 0],
        replacedCount: 1
      }
    });

    const usage = agentStore.getContextUsage(thread.id, 1700);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.inputTokens).toBeLessThan(1000);
    expect(usage.updatedAt).toBe(summary.createdAt);
  } finally {
    cleanup();
  }
});

test("AgentStore.ensureSystemMessage: replaces the stored prompt when the template changed", () => {
  const { agentStore } = freshStore();
  const thread = agentStore.getOrCreateThread("worker", "feat-sys");

  const first = agentStore.ensureSystemMessage(thread.id, "old policy text");
  expect(first?.content).toEqual({ type: "text", text: "old policy text" });

  // Same text: no-op, same message row.
  const same = agentStore.ensureSystemMessage(thread.id, "old policy text");
  expect(same?.id).toBe(first!.id);

  // Template upgraded (e.g. a prompt policy change shipped): the stored
  // system message must pick it up instead of freezing the thread forever.
  const updated = agentStore.ensureSystemMessage(thread.id, "new policy text");
  expect(updated?.content).toEqual({ type: "text", text: "new policy text" });
  expect(agentStore.getSystemMessage(thread.id)?.content).toEqual({
    type: "text",
    text: "new policy text"
  });

  // Still exactly one system message; seq 0 preserved.
  const systemRows = agentStore.db
    .prepare("select seq, content from agent_messages where thread_id = ? and role = 'system'")
    .all(thread.id) as { seq: number; content: string }[];
  expect(systemRows.length).toBe(1);
  expect(systemRows[0]!.seq).toBe(0);
  expect(JSON.parse(systemRows[0]!.content).text).toBe("new policy text");
});
