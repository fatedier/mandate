import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { applyRetentionWork, truncateChatToolResults } from "../src/server/platform/db/retention.js";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

// A conversation's version moves whenever one of its stored messages changes
// after it was written, whoever changed it: what was read of the conversation
// before is then known to be out of date. Appending moves nothing (a reader
// finds new rows by their seq).

function say(agentStore: AgentStore, threadId: string, text: string) {
  return agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text } });
}

test("appending a message changes no version; changing or deleting one bumps its thread's", () => {
  const env = freshAgentEnv("md-versions-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-versions");
  const other = env.agentStore.getOrCreateThread("worker", "wkr-other");
  const first = say(env.agentStore, thread.id, "one");
  say(env.agentStore, thread.id, "two");
  const third = say(env.agentStore, thread.id, "three");
  say(env.agentStore, other.id, "elsewhere");
  expect(env.agentStore.messageVersion(thread.id)).toBe(0);

  env.store.db.prepare("update agent_messages set content = ? where id = ?").run(JSON.stringify({ type: "text", text: "one, edited" }), first.id);
  expect(env.agentStore.messageVersion(thread.id)).toBe(1);
  env.store.db.prepare("delete from agent_messages where id = ?").run(third.id);
  expect(env.agentStore.messageVersion(thread.id)).toBe(2);
  expect(env.agentStore.messageVersion(other.id)).toBe(0);
});

test("a row inserted below the thread's newest seq bumps the version", () => {
  const env = freshAgentEnv("md-versions-seq-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-seq");
  const first = say(env.agentStore, thread.id, "one");
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", seq: first.seq + 2, content: { type: "text", text: "two" } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", seq: first.seq + 1, content: { type: "text", text: "squeezed in" } });
  expect(env.agentStore.messageVersion(thread.id)).toBe(1);
  say(env.agentStore, thread.id, "three");
  expect(env.agentStore.messageVersion(thread.id)).toBe(1);
});

test("a wake ending canceled bumps its thread; step counts, token figures and a finished end do not", () => {
  const env = freshAgentEnv("md-versions-wakes-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-wakes");
  const done = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  env.agentStore.updateWakeStepCount(done.id, 3);
  env.agentStore.updateWakeTokenUsage(done.id, 1200, 1500);
  env.agentStore.finishWake(done.id, "finished");
  expect(env.agentStore.messageVersion(thread.id)).toBe(0);

  const stopped = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  env.agentStore.finishWake(stopped.id, "canceled", "Stopped by user.");
  expect(env.agentStore.messageVersion(thread.id)).toBe(1);
});

test("a change made through a second connection bumps the version the store reads", () => {
  const env = freshAgentEnv("md-versions-conn-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-conn");
  const first = say(env.agentStore, thread.id, "one");
  const second = new Database(path.join(env.dir, "mandate.db"));
  try {
    second.prepare("update agent_messages set content = ? where id = ?").run(JSON.stringify({ type: "text", text: "changed elsewhere" }), first.id);
  } finally {
    second.close();
  }
  expect(env.agentStore.messageVersion(thread.id)).toBeGreaterThan(0);
});

test("deleting a thread keeps its version row, bumped", () => {
  const env = freshAgentEnv("md-versions-delete-");
  const thread = env.agentStore.createManagerThread("Old work");
  say(env.agentStore, thread.id, "one");
  say(env.agentStore, thread.id, "two");
  env.agentStore.archiveThread(thread.id);
  const before = env.agentStore.messageVersion(thread.id);
  const deletion = new ThreadDeletion({ db: env.store.db, agentStore: env.agentStore, canvases: { delete: () => null }, dataDir: env.dir });
  expect(deletion.delete(thread.id).ok).toBe(true);
  const row = env.store.db.prepare("select version from agent_message_versions where thread_id = ?").get(thread.id) as { version: number } | null;
  expect(row).not.toBeNull();
  expect(row!.version).toBeGreaterThan(before);
});

test("the version triggers exist after a second schema initialization", () => {
  const env = freshAgentEnv("md-versions-schema-");
  initializeAgentSchema(env.store.db);
  initializeAgentSchema(env.store.db);
  const names = (env.store.db.prepare("select name from sqlite_master where type = 'trigger' and name like '%version%' order by name").all() as Array<{ name: string }>).map((row) => row.name);
  expect(names).toEqual([
    "agent_messages_version_delete",
    "agent_messages_version_insert",
    "agent_messages_version_update",
    "agent_wakes_version_delete",
    "agent_wakes_version_update"
  ]);
});

test("retention counts the results it shortens, not the version rows the change moves", () => {
  const env = freshAgentEnv("md-versions-counts-");
  const thread = env.agentStore.getOrCreateThread("worker", "wkr-counts");
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "call_1", toolName: "bash", args: {} }] } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "call_1", toolName: "bash", result: "line\n".repeat(2000) } });
  const cut = () => truncateChatToolResults(env.store.db, { headChars: 2000, cutoffIso: new Date().toISOString(), maxRows: 100, overCeiling: true });
  expect(cut()).toBe(1);
  expect(env.agentStore.messageVersion(thread.id)).toBe(1);
  expect(cut()).toBe(0);

  const context = env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context] old" } });
  const reply = env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "done", sdkAssistantMessages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] } as never });
  expect(applyRetentionWork(env.store.db, { runtimeContextIds: [context.id], llmPayloadIds: [], toolResults: [], replayStateIds: [reply.id], mailboxIds: [], skipMarkerIds: [] }))
    .toMatchObject({ runtimeContextDeleted: 1, replayStateCleared: 1 });
});
