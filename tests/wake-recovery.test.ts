import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { INTERRUPTED_TOOL_RESULT, pendingWakeRecovery } from "../src/server/modules/agent/wake-recovery.js";
import { prepareAiSdkMessages } from "../src/server/modules/agent/wake-message-adapter.js";

function setup() {
  const db = new Database(":memory:");
  initializeAgentSchema(db);
  const store = new AgentStore(db);
  const thread = store.getOrCreateThread("manager", null);
  const trigger = store.appendMessage({ threadId: thread.id, role: "user", source: "user",
    content: { type: "text", text: "Inspect the current progress and finish the task." } });
  const wake = store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: trigger.id });
  return { db, store, thread, wake, trigger };
}

function seedPartialTools(s: ReturnType<typeof setup>) {
  s.store.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", wakeId: s.wake.id,
    content: { type: "assistant", toolCalls: [
      { toolCallId: "done", toolName: "read_file", args: { path: "README.md" } },
      { toolCallId: "unknown", toolName: "send_command", args: { command: "make build" } }
    ] } });
  s.store.appendMessage({ threadId: s.thread.id, role: "tool", source: "self", wakeId: s.wake.id,
    content: { type: "tool_result", toolCallId: "done", toolName: "read_file", result: "saved file contents" } });
}

test("restart repairs a partial tool group and preserves successful results in the model prompt", () => {
  const s = setup();
  try {
    seedPartialTools(s);
    expect(s.store.recoverInterruptedWakes("server restarted")).toBe(1);
    const messages = s.store.getActiveMessages(s.thread.id);
    const results = messages.filter((m) => m.content.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]!.content).toMatchObject({ result: "saved file contents" });
    expect(results[1]!.content).toMatchObject({ toolCallId: "unknown", isError: true, error: INTERRUPTED_TOOL_RESULT });
    const prompt = prepareAiSdkMessages(messages, { includeImages: true });
    expect(prompt.filter((m) => m.role === "tool")).toHaveLength(2);
    expect(JSON.stringify(prompt)).toContain("saved file contents");
    expect(s.store.getWakeById(s.wake.id)).toMatchObject({ status: "error", errorMessage: "server restarted" });
    expect(s.store.listThreadIdsWithQueuedMailboxMessages()).toEqual([s.thread.id]);
  } finally { s.db.close(); }
});

test("repair, status and recovery request roll back together when enqueue fails", () => {
  const s = setup();
  try {
    seedPartialTools(s);
    s.db.exec(`create trigger reject_recovery before insert on agent_mailbox
      begin select raise(abort, 'injected failure'); end`);
    expect(() => s.store.recoverInterruptedWakes("restart")).toThrow("injected failure");
    expect(s.store.getWakeById(s.wake.id)?.status).toBe("running");
    expect(s.store.getActiveMessages(s.thread.id).filter((m) => m.role === "tool")).toHaveLength(1);
    expect(s.store.listThreadIdsWithQueuedMailboxMessages()).toEqual([]);
    s.db.exec("drop trigger reject_recovery");
    expect(s.store.recoverInterruptedWakes("restart")).toBe(1);
  } finally { s.db.close(); }
});

test("repeated restart before consumption merges the pending request and repairs only once", () => {
  const s = setup();
  try {
    seedPartialTools(s);
    s.store.recoverInterruptedWakes("restart");
    expect(s.store.recoverInterruptedWakes("restart again")).toBe(0);
    const next = s.store.createWake({ threadId: s.thread.id, reason: "user", triggerMessageId: null });
    expect(next.triggerMessageId).toBe(s.trigger.id);
    s.store.recoverInterruptedWakes("restart before mailbox drain");
    expect(pendingWakeRecovery(s.db, s.thread.id)?.wakeIds).toEqual([s.wake.id, next.id]);
    const third = s.store.createWake({ threadId: s.thread.id, reason: "user", triggerMessageId: null });
    const delivered = s.store.drainMailboxToMessages(s.thread.id, third.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.source).toBe("restart-recovery");
    expect(s.store.getActiveMessages(s.thread.id).filter((m) => m.role === "tool")).toHaveLength(2);
    s.store.finishWake(third.id, "finished");
    expect(s.store.recoverInterruptedWakes("restart after completion")).toBe(0);
    expect(s.store.listThreadIdsWithQueuedMailboxMessages()).toEqual([]);
  } finally { s.db.close(); }
});

test("restart after consuming the notice preserves recovery lineage and schedules another wake", () => {
  const s = setup();
  try {
    s.store.recoverInterruptedWakes("restart");
    const next = s.store.createWake({ threadId: s.thread.id, reason: "user", triggerMessageId: null });
    s.store.drainMailboxToMessages(s.thread.id, next.id);
    s.store.recoverInterruptedWakes("restart during recovery");
    expect(pendingWakeRecovery(s.db, s.thread.id)?.wakeIds).toEqual([s.wake.id, next.id]);
    expect(s.store.listThreadIdsWithQueuedMailboxMessages()).toEqual([s.thread.id]);
  } finally { s.db.close(); }
});

test("durable stop intent prevents recovery even before the running loop exits", () => {
  const s = setup();
  try {
    seedPartialTools(s);
    s.store.recoverInterruptedWakes("restart");
    const next = s.store.createWake({ threadId: s.thread.id, reason: "user", triggerMessageId: null });
    s.store.requestWakeCancellation(next.id);
    expect(s.store.getWakeById(next.id)?.status).toBe("running");
    s.store.recoverInterruptedWakes("restart before abort completes");
    expect(s.store.getWakeById(next.id)?.status).toBe("canceled");
    expect(s.store.listThreadIdsWithQueuedMailboxMessages()).toEqual([]);
  } finally { s.db.close(); }
});

test("only active main conversations recover; terminal wake states remain terminal", () => {
  const s = setup();
  try {
    const worker = s.store.getOrCreateThread("worker", "active-worker");
    const inactive = s.store.getOrCreateThread("worker", "archived-project-worker");
    const archived = s.store.getOrCreateThread("worker", "archived-thread");
    const closed = s.store.getOrCreateThread("worker", "closed-thread");
    const side = s.store.getOrCreateThread("worker", "side-thread");
    for (const thread of [worker, inactive, archived, closed, side]) {
      s.store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    }
    s.store.archiveThread(archived.id);
    s.db.prepare("update agent_threads set closed_at = 'closed' where id = ?").run(closed.id);
    s.db.prepare("update agent_threads set kind = 'side' where id = ?").run(side.id);
    for (const status of ["finished", "canceled", "error", "limit_reached"] as const) {
      const thread = s.store.getOrCreateThread("worker", status);
      const wake = s.store.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
      s.store.finishWake(wake.id, status);
    }
    s.store.recoverInterruptedWakes("restart", (thread) => thread.id !== inactive.id);
    expect(new Set(s.store.listThreadIdsWithQueuedMailboxMessages())).toEqual(new Set([s.thread.id, worker.id]));
    s.store.archiveThread(worker.id);
    s.store.recoverInterruptedWakes("restart again");
    expect(s.store.listThreadIdsWithQueuedMailboxMessages()).toEqual([s.thread.id]);
    expect(pendingWakeRecovery(s.db, worker.id)).toBeUndefined();
  } finally { s.db.close(); }
});

test("new user input consumes recovery in the same wake and follows the recovery notice", () => {
  const s = setup();
  try {
    s.store.enqueueMailboxMessage({ threadId: s.thread.id, role: "user", source: "user",
      content: { type: "text", text: "Only inspect now; do not continue editing." } });
    s.store.recoverInterruptedWakes("restart");
    const next = s.store.createWake({ threadId: s.thread.id, reason: "user", triggerMessageId: "new-input" });
    expect(next.triggerMessageId).toBe("new-input");
    expect(next.metadata?.recovery?.wakeIds).toEqual([s.wake.id]);
    const delivered = s.store.drainMailboxToMessages(s.thread.id, next.id, 1);
    expect(delivered[0]!.source).toBe("restart-recovery");
    expect(s.store.drainMailboxToMessages(s.thread.id, next.id)[0]!.content).toMatchObject({ text: "Only inspect now; do not continue editing." });
    expect(pendingWakeRecovery(s.db, s.thread.id)).toBeUndefined();
  } finally { s.db.close(); }
});
