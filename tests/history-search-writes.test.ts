import { expect, test } from "bun:test";
import { AgentHistoryStore } from "../src/server/modules/agent/history-store.js";
import { historyEnv } from "./helpers/history-env.js";

// What a search costs the server's thread besides its reads: the look for
// unindexed messages; it writes nothing else.

type Env = ReturnType<typeof historyEnv>;

/** A message written past the store, so nothing indexed it. */
function rawMessage(env: Env, id: string, text: string): void {
  const seq = (env.store.db.prepare("select coalesce(max(seq), 0) + 1 as n from agent_messages where thread_id = ?").get(env.thread.id) as { n: number }).n;
  env.store.db.prepare("insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values (?, ?, ?, 'user', 'user', ?, ?)")
    .run(id, env.thread.id, seq, JSON.stringify({ type: "text", text }), new Date().toISOString());
}
const indexed = (env: Env, id: string) => env.store.db.prepare("select 1 from agent_message_search_entries where message_id = ?").get(id) !== null;

test("a backfill that found every message remembers how far it read: the next looks only at messages after it", () => {
  const env = historyEnv();
  const store = new AgentHistoryStore(env.store.db);
  rawMessage(env, "msg_raw_early", "rollout notes for the release");
  store.backfill();
  expect(indexed(env, "msg_raw_early")).toBe(true);
  // A gap below that point is not looked for again; a new message is.
  env.store.db.prepare("delete from agent_message_search_entries where message_id = 'msg_raw_early'").run();
  rawMessage(env, "msg_raw_late", "migration plan for staging");
  store.backfill();
  expect(indexed(env, "msg_raw_late")).toBe(true);
  expect(indexed(env, "msg_raw_early")).toBe(false);
});

test("a message given a rowid a deletion freed is still looked for after a complete backfill", () => {
  const env = historyEnv();
  const store = new AgentHistoryStore(env.store.db);
  rawMessage(env, "msg_raw_a", "first note");
  rawMessage(env, "msg_raw_b", "second note");
  store.backfill();
  // The newest message deleted (a deleted thread's): SQLite gives its rowid
  // to the next message, below where the backfill had read to.
  env.store.db.prepare("delete from agent_messages where id = 'msg_raw_b'").run();
  rawMessage(env, "msg_raw_c", "third note");
  store.backfill();
  expect(indexed(env, "msg_raw_c")).toBe(true);
});

test("a search writes nothing once the index is whole", () => {
  const env = historyEnv();
  for (const text of ["rollout notes", "rollout plan", "rollout checklist"]) {
    env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text } });
  }
  const db = env.store.db;
  const store = new AgentHistoryStore(db);
  const search = () => store.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "rollout", includeOwnThread: true });
  // The first search may still finish the index's backfill.
  search();
  const original = db.prepare.bind(db);
  const writes: string[] = [];
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (/^\s*(insert|update|delete|replace)\b/i.test(sql)) writes.push(sql.trim().split("\n")[0]!);
    return original(sql);
  };
  try {
    expect(search().threads.map((thread) => thread.id)).toEqual([env.thread.id]);
  } finally {
    (db as unknown as { prepare: unknown }).prepare = original;
  }
  expect(writes).toEqual([]);
});
