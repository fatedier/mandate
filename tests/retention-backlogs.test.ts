import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { applyRetentionWork } from "../src/server/platform/db/retention.js";
import { findDefaultRetentionWork, runRetentionPass } from "./helpers/retention.js";
import { advanceHistoryBackfillMark, AgentHistoryStore, markHistoryIndexIncomplete } from "../src/server/modules/agent/history-store.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { plansOf } from "./helpers/sql-watch.js";

// The hourly retention pass: what it finds and what it drops.
//
// Rows nothing reads again go, a bounded number at a time: read handles past
// their expiry, mail delivered a week ago (its message is in the conversation),
// and the search index's skip markers below the backfill's mark (a backfill
// looks only above it) or for messages gone.

const NOW = new Date("2026-11-02T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const count = (db: Database, sql: string, ...args: Array<string | number>) => (db.prepare(sql).get(...args) as { n: number }).n;
const pass = (db: Database) => applyRetentionWork(db, findDefaultRetentionWork(db, NOW), NOW);

function mail(db: Database, id: string, status: "queued" | "delivered", at: string | null, wakeId: string | null = null) {
  db.prepare(`insert into agent_mailbox (id, thread_id, role, source, content, status, created_at, delivered_at, wake_id)
    values (?, 'thr_m', 'user', 'thread-notice', '{"type":"text","text":"x"}', ?, ?, ?, ?)`).run(id, status, at ?? hoursAgo(1), at, wakeId);
}
/** A turn that ended as `status`, for mail delivered to it. */
function turn(e: StoresEnv, status: "finished" | "error" | "canceled" | "stuck"): string {
  const thread = e.agentStore.getOrCreateThread("manager", null);
  const wake = e.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  e.agentStore.finishWake(wake.id, status, status === "finished" ? undefined : "ended");
  return wake.id;
}

test("mail delivered more than a week ago to a turn that ended goes; mail delivered since, or still waiting however old, stays", () => {
  const env = freshStoresEnv("md-retention-mail-");
  const db = env.store.db;
  const done = turn(env, "finished");
  mail(db, "mb_old", "delivered", hoursAgo(24 * 8), done);
  mail(db, "mb_stopped", "delivered", hoursAgo(24 * 8), turn(env, "canceled"));
  mail(db, "mb_recent", "delivered", hoursAgo(24 * 6), done);
  mail(db, "mb_waiting", "queued", null);
  db.prepare("update agent_mailbox set created_at = ? where id = 'mb_waiting'").run(hoursAgo(24 * 30));
  expect(pass(db).mailboxDeleted).toBe(2);
  expect((db.prepare("select id from agent_mailbox order by id").all() as Array<{ id: string }>).map((r) => r.id)).toEqual(["mb_recent", "mb_waiting"]);
});

test("mail delivered to a turn that failed or got stuck stays, however old: a retry, or the turn resumed after a restart, forwards its reply from it", () => {
  const env = freshStoresEnv("md-retention-mail-failed-");
  const db = env.store.db;
  mail(db, "mb_failed", "delivered", hoursAgo(24 * 30), turn(env, "error"));
  mail(db, "mb_stuck", "delivered", hoursAgo(24 * 30), turn(env, "stuck"));
  expect(pass(db).mailboxDeleted).toBe(0);
  expect((db.prepare("select count(*) as n from agent_mailbox").get() as { n: number }).n).toBe(2);
});

test("skip markers at or below the backfill's mark, or for a message gone, go; those above it stay; with no mark, all stay", () => {
  const env = freshStoresEnv("md-retention-skips-");
  const db = env.store.db;
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const ids = Array.from({ length: 4 }, (_, i) => env.agentStore.appendMessage({
    threadId: thread.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: `c${i}`, toolName: "bash", result: "ok" }
  }).id);
  // Each passed over by the index, and one for a message since deleted.
  for (const id of [...ids, "msg_gone"]) {
    db.prepare("insert or ignore into agent_message_search_skipped (message_id, indexed_at) values (?, ?)").run(id, hoursAgo(5));
  }
  db.prepare("delete from agent_message_search_skipped where message_id not in (select value from json_each(?))").run(JSON.stringify([...ids, "msg_gone"]));
  const markers = () => (db.prepare("select message_id from agent_message_search_skipped order by message_id").all() as Array<{ message_id: string }>).map((r) => r.message_id);
  expect(markers().length).toBe(5);
  // No mark yet: a backfill would look at every message, markers and all.
  expect(pass(db).skipMarkersDeleted).toBe(0);
  const rowid = (id: string) => (db.prepare("select rowid as r from agent_messages where id = ?").get(id) as { r: number }).r;
  db.prepare("insert into agent_message_search_words_state (key, value) values ('backfill_checked_rowid', ?) on conflict(key) do update set value = excluded.value")
    .run(String(rowid(ids[1]!)));
  expect(pass(db).skipMarkersDeleted).toBe(3);
  expect(markers()).toEqual([ids[2]!, ids[3]!].sort());
});

test("a pass takes at most 2,000 of each; the rest wait for the next", () => {
  const env = freshStoresEnv("md-retention-cap-");
  const db = env.store.db;
  const wake = turn(env, "finished");
  db.transaction(() => { for (let i = 0; i < 2_005; i++) mail(db, `mb_${i}`, "delivered", hoursAgo(24 * 8), wake); })();
  expect(pass(db).mailboxDeleted).toBe(2_000);
  expect(pass(db).mailboxDeleted).toBe(5);
  expect(count(db, "select count(*) as n from agent_mailbox")).toBe(0);
});

test("found a while ago, a row is removed only if it still qualifies", () => {
  const env = freshStoresEnv("md-retention-recheck-");
  const db = env.store.db;
  mail(db, "mb_old", "delivered", hoursAgo(24 * 8), turn(env, "finished"));
  const work = findDefaultRetentionWork(db, NOW);
  // Meanwhile (made up, to prove the re-check): the mail delivered again.
  db.prepare("update agent_mailbox set delivered_at = ? where id = 'mb_old'").run(hoursAgo(1));
  expect(applyRetentionWork(db, work, NOW).mailboxDeleted).toBe(0);
});

test("the backfill's mark moves to the newest message while every message is known indexed, and not otherwise", () => {
  const env = freshStoresEnv("md-retention-mark-");
  const db = env.store.db;
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const say = (text: string) => env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
  const mark = () => (db.prepare("select value from agent_message_search_words_state where key = 'backfill_checked_rowid'").get() as { value: string } | null)?.value ?? null;
  const top = () => String((db.prepare("select max(rowid) as r from agent_messages").get() as { r: number }).r);
  say("first");
  // No backfill has run in this process: nothing is known.
  expect([advanceHistoryBackfillMark(db), mark()]).toEqual([false, null]);
  new AgentHistoryStore(db).backfill();
  say("second");
  expect([advanceHistoryBackfillMark(db), mark()]).toEqual([true, top()]);
  // An indexing failed: the next backfill has to look again, from where the mark is.
  const before = mark();
  say("third");
  markHistoryIndexIncomplete(db);
  expect([advanceHistoryBackfillMark(db), mark()]).toEqual([false, before]);
});

// The hourly pass first asks which threads hold runtime context: a few
// thousand rows among hundreds of thousands of messages. Found through an
// index of its own, not by reading every message.

test("the threads holding runtime context are found without reading every message", () => {
  const env = freshStoresEnv("md-retention-reads-");
  const thread = env.agentStore.createManagerThread("Release");
  for (let i = 0; i < 20; i++) env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `message ${i}` } });
  env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "runtime-context", content: { type: "text", text: "[initial_context]", metadata: { runtimeContextKind: "initial" } } });
  const plans = plansOf(env.store.db, /select distinct thread_id from agent_messages/, () => runRetentionPass(env.store.db));
  expect(plans).toHaveLength(1);
  expect(plans[0]).toContain("USING COVERING INDEX idx_agent_messages_runtime_context");
});

// A reply keeps a copy of what the model sent (its reasoning, encrypted, and
// its calls) to send back to that model on the next step, and the reasoning
// as text. Once a compaction has passed the reply, no model reads it again
// (a compaction keeps only user turns by id) and the chat never showed
// either, and both are large. The hourly pass drops both.

function seeded() {
  const env = freshStoresEnv("md-retention-replay-");
  const thread = env.agentStore.createManagerThread("Release");
  const reply = (text: string) => env.agentStore.appendMessage({
    threadId: thread.id, role: "assistant", source: "self",
    content: {
      type: "assistant", text,
      // A call whose own arguments name "reasoning": not the reply's reasoning.
      toolCalls: [{ toolCallId: `c-${text}`, toolName: "note", args: { reasoning: "an argument" } }],
      sdkAssistantMessages: [{ role: "assistant", content: [{ type: "reasoning", text: "thinking", providerOptions: { openai: { reasoningEncryptedContent: "sealed" } } }, { type: "text", text }] }],
      reasoning: { text: "thinking", ms: 12 }
    } as never
  });
  const before = reply("before");
  env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "compression",
    content: { type: "summary", summary: "what came before", replacedRange: [1, 1], replacedCount: 1, compactedCount: 1, retained: [] }
  });
  const after = reply("after");
  const content = (id: string) => JSON.parse((env.store.db.prepare("select content from agent_messages where id = ?").get(id) as { content: string }).content) as Record<string, unknown>;
  return { env, before, after, content };
}

test("a reply a compaction has passed loses its replay copy and its hidden reasoning; what the chat shows stays; a reply after it keeps both", () => {
  const s = seeded();
  expect(runRetentionPass(s.env.store.db).replayStateCleared).toBe(1);
  expect(s.content(s.before.id)).toEqual({
    type: "assistant", text: "before",
    toolCalls: [{ toolCallId: "c-before", toolName: "note", args: { reasoning: "an argument" } }]
  });
  expect(Object.keys(s.content(s.after.id))).toEqual(expect.arrayContaining(["sdkAssistantMessages", "reasoning"]));
  // Nothing left to drop: a call's own "reasoning" argument is not taken for the reply's.
  expect(runRetentionPass(s.env.store.db).replayStateCleared).toBe(0);
});

test("a thread never compacted keeps every reply's replay copy", () => {
  const env = freshStoresEnv("md-retention-replay-none-");
  const thread = env.agentStore.createManagerThread("Fresh");
  env.agentStore.appendMessage({
    threadId: thread.id, role: "assistant", source: "self",
    content: { type: "assistant", text: "hi", toolCalls: [], sdkAssistantMessages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] } as never
  });
  expect(runRetentionPass(env.store.db).replayStateCleared).toBe(0);
});
