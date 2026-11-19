import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { ACTIVE_WINDOW_IDLE_MS } from "../src/server/modules/agent/active-window.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { applyRetentionWork, truncateChatToolResults } from "../src/server/platform/db/retention.js";
import { freshAgentEnv } from "./helpers/fixtures.js";
import { statementsRan } from "./helpers/sql-watch.js";

// A conversation's window is kept in memory between reads and caught up by
// what came after it. Whatever changed in between, a read gives what a fresh
// read of the database gives — that is the whole contract — and a read of a
// window held reads only the rows that are new.

type Env = ReturnType<typeof freshAgentEnv>;

/** The window as a store holding nothing reads it now. */
const fresh = (env: Env, threadId: string) => new AgentStore(env.store.db).getActiveMessages(threadId);

function say(env: Env, threadId: string, text: string) {
  return env.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text } });
}

function toolTurn(env: Env, threadId: string, callId: string, result: string) {
  const call = env.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: callId, toolName: "bash", args: { command: "ls" } }] } });
  const output = env.agentStore.appendMessage({ threadId, role: "tool", source: "self", content: { type: "tool_result", toolCallId: callId, toolName: "bash", result } });
  return { call, output };
}

/** Rows the statements reading agent_messages returned while `fn` ran. */
function messageRowsRead(db: Database, fn: () => unknown): number {
  const { ran } = statementsRan(db, /from agent_messages\b/, fn);
  return ran.reduce((rows, run) => rows + (run.method === "all" ? (run.result as unknown[]).length : run.method === "get" && run.result ? 1 : 0), 0);
}

test("a held window matches a fresh read after appends of every kind", () => {
  const env = freshAgentEnv("md-window-appends-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-appends");
  say(env, thread.id, "start");
  env.agentStore.getActiveMessages(thread.id);
  toolTurn(env, thread.id, "call_1", "a.txt\nb.txt");
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context] state" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "plan-reminder", content: { type: "text", text: "<plan-reminder>update it</plan-reminder>" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "output-limit", content: { type: "text", text: "go on" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "done" } });
  const held = env.agentStore.getActiveMessages(thread.id);
  expect(held).toEqual(fresh(env, thread.id));
  expect(held).toHaveLength(7);
});

test("a compaction's summary, with kept and shortened turns, makes the next read the new window", () => {
  const env = freshAgentEnv("md-window-summary-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-summary");
  const kept = say(env, thread.id, "keep this ask");
  const long = say(env, thread.id, "a very long paste ".repeat(50));
  toolTurn(env, thread.id, "call_1", "output");
  env.agentStore.getActiveMessages(thread.id);
  const summary = env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "compression",
    content: { type: "summary", summary: "what came before", replacedRange: [1, 4], replacedCount: 4, compactedCount: 4, retained: [{ id: kept.id }, { id: long.id, truncatedText: "a very long paste [truncated]" }] }
  });
  const after = say(env, thread.id, "next ask");
  const held = env.agentStore.getActiveMessages(thread.id);
  expect(held).toEqual(fresh(env, thread.id));
  expect(held.map((m) => m.id)).toEqual([kept.id, long.id, summary.id, after.id]);
  expect(held[1]!.content).toMatchObject({ text: "a very long paste [truncated]" });
});

test("each retention operation is seen by the next read", () => {
  const env = freshAgentEnv("md-window-retention-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-retention");
  const context = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context] old" } });
  const reply = env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "done", sdkAssistantMessages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] } as never });
  const { output } = toolTurn(env, thread.id, "call_1", "line\n".repeat(1500));
  env.agentStore.getActiveMessages(thread.id);

  applyRetentionWork(env.store.db, { runtimeContextIds: [context.id], llmPayloadIds: [], toolResults: [], replayStateIds: [], mailboxIds: [], skipMarkerIds: [] });
  expect(env.agentStore.getActiveMessages(thread.id)).toEqual(fresh(env, thread.id));
  expect(env.agentStore.getActiveMessages(thread.id).some((m) => m.id === context.id)).toBe(false);

  applyRetentionWork(env.store.db, { runtimeContextIds: [], llmPayloadIds: [], toolResults: [], replayStateIds: [reply.id], mailboxIds: [], skipMarkerIds: [] });
  expect(env.agentStore.getActiveMessages(thread.id)).toEqual(fresh(env, thread.id));
  expect(env.agentStore.getActiveMessages(thread.id).find((m) => m.id === reply.id)!.content).not.toHaveProperty("sdkAssistantMessages");

  expect(truncateChatToolResults(env.store.db, { headChars: 2000, cutoffIso: new Date().toISOString(), maxRows: 100, overCeiling: true })).toBe(1);
  const held = env.agentStore.getActiveMessages(thread.id);
  expect(held).toEqual(fresh(env, thread.id));
  expect(JSON.stringify(held.find((m) => m.id === output.id)!.content).length).toBeLessThan(5000);
});

test("a deleted thread reads empty", () => {
  const env = freshAgentEnv("md-window-deleted-");
  const thread = env.agentStore.createManagerThread("Old work");
  say(env, thread.id, "one");
  say(env, thread.id, "two");
  expect(env.agentStore.getActiveMessages(thread.id)).toHaveLength(2);
  env.agentStore.archiveThread(thread.id);
  const deletion = new ThreadDeletion({ db: env.store.db, agentStore: env.agentStore, canvases: { delete: () => null }, dataDir: env.dir });
  expect(deletion.delete(thread.id).ok).toBe(true);
  expect(env.agentStore.getActiveMessages(thread.id)).toEqual([]);
});

test("a wake that ends canceled shows on the next read", () => {
  const env = freshAgentEnv("md-window-canceled-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-canceled");
  const wake = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "working" } });
  expect(env.agentStore.getActiveMessages(thread.id)[0]).not.toHaveProperty("wakeInterrupted");
  env.agentStore.finishWake(wake.id, "canceled", "Stopped by user.");
  const held = env.agentStore.getActiveMessages(thread.id);
  expect(held).toEqual(fresh(env, thread.id));
  expect(held[0]).toMatchObject({ wakeInterrupted: true });
});

test("a row inserted below the newest seq, and a change through a second connection, are seen", () => {
  const env = freshAgentEnv("md-window-elsewhere-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-elsewhere");
  const first = say(env, thread.id, "one");
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", seq: first.seq + 2, content: { type: "text", text: "two" } });
  env.agentStore.getActiveMessages(thread.id);
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", seq: first.seq + 1, content: { type: "text", text: "slipped in" } });
  expect(env.agentStore.getActiveMessages(thread.id)).toEqual(fresh(env, thread.id));
  expect(env.agentStore.getActiveMessages(thread.id)).toHaveLength(3);

  const second = new Database(path.join(env.dir, "mandate.db"));
  try {
    second.prepare("update agent_messages set content = ? where id = ?").run(JSON.stringify({ type: "text", text: "one, changed elsewhere" }), first.id);
  } finally {
    second.close();
  }
  const held = env.agentStore.getActiveMessages(thread.id);
  expect(held).toEqual(fresh(env, thread.id));
  expect(held.find((m) => m.id === first.id)!.content).toMatchObject({ text: "one, changed elsewhere" });
});

test("a transaction that rolls back leaves nothing in the window", () => {
  const env = freshAgentEnv("md-window-rollback-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-rollback");
  say(env, thread.id, "one");
  env.agentStore.getActiveMessages(thread.id);
  let inside = 0;
  expect(() => env.store.db.transaction(() => {
    say(env, thread.id, "never kept");
    inside = env.agentStore.getActiveMessages(thread.id).length;
    throw new Error("roll back");
  })()).toThrow("roll back");
  expect(inside).toBe(2);
  const after = say(env, thread.id, "two");
  const held = env.agentStore.getActiveMessages(thread.id);
  expect(held).toEqual(fresh(env, thread.id));
  expect(held.map((m) => m.content)).toEqual([{ type: "text", text: "one" }, { type: "text", text: "two" }]);
  expect(held[1]!.id).toBe(after.id);
});

test("a held window reads only the rows after it", () => {
  const env = freshAgentEnv("md-window-rows-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-rows");
  for (let i = 0; i < 200; i++) say(env, thread.id, `step ${i}`);
  expect(messageRowsRead(env.store.db, () => env.agentStore.getActiveMessages(thread.id))).toBeGreaterThanOrEqual(200);
  say(env, thread.id, "one more");
  expect(messageRowsRead(env.store.db, () => env.agentStore.getActiveMessages(thread.id))).toBe(1);
  expect(messageRowsRead(env.store.db, () => env.agentStore.getActiveMessages(thread.id))).toBe(0);
  expect(env.agentStore.getActiveMessages(thread.id)).toHaveLength(201);
});

test("a handed-out message cannot be changed", () => {
  const env = freshAgentEnv("md-window-frozen-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-frozen");
  say(env, thread.id, "as written");
  const handed = env.agentStore.getActiveMessages(thread.id);
  expect(() => { (handed[0]!.content as { text: string }).text = "changed"; }).toThrow(TypeError);
  handed.push(handed[0]!);
  expect(env.agentStore.getActiveMessages(thread.id).map((m) => m.content)).toEqual([{ type: "text", text: "as written" }]);
});

test("a window unused for ten minutes is read again, and is let go when another thread is read", () => {
  const env = freshAgentEnv("md-window-idle-");
  let now = 1_000_000;
  const store = new AgentStore(env.store.db, { activeWindow: { now: () => now } });
  const thread = store.getOrCreateThread("worker", "wkr-idle");
  for (let i = 0; i < 20; i++) say(env, thread.id, `step ${i}`);
  store.getActiveMessages(thread.id);
  now += ACTIVE_WINDOW_IDLE_MS;
  expect(messageRowsRead(env.store.db, () => store.getActiveMessages(thread.id))).toBe(0);
  now += ACTIVE_WINDOW_IDLE_MS + 1;
  expect(messageRowsRead(env.store.db, () => store.getActiveMessages(thread.id))).toBeGreaterThanOrEqual(20);
  const other = store.getOrCreateThread("worker", "wkr-other");
  now += ACTIVE_WINDOW_IDLE_MS + 1;
  store.getActiveMessages(other.id);
  expect(store.heldWindows().threads).toBe(1);
});

test("over the size cap the least recently used window goes", () => {
  const env = freshAgentEnv("md-window-cap-");
  const a = env.agentStore.getOrCreateThread("worker", "wkr-a");
  const b = env.agentStore.getOrCreateThread("worker", "wkr-b");
  for (let i = 0; i < 20; i++) { say(env, a.id, `a ${i}`); say(env, b.id, `b ${i}`); }
  const probe = new AgentStore(env.store.db);
  probe.getActiveMessages(a.id);
  const store = new AgentStore(env.store.db, { activeWindow: { maxBytes: probe.heldWindows().bytes + 1 } });
  store.getActiveMessages(a.id);
  store.getActiveMessages(b.id);
  expect(store.heldWindows().threads).toBe(1);
  expect(store.getActiveMessages(b.id)).toEqual(fresh(env, b.id));
  expect(messageRowsRead(env.store.db, () => store.getActiveMessages(a.id))).toBeGreaterThanOrEqual(20);
  expect(store.getActiveMessages(a.id)).toEqual(fresh(env, a.id));
});
