import { expect, test } from "bun:test";
import { AgentHistoryStore, indexAgentHistoryMessage } from "../src/server/modules/agent/history-store.js";
import { historyWordsReady } from "../src/server/modules/agent/history-words.js";
import { historyEnv } from "./helpers/history-env.js";

// chat_history_search reads the words index: a Chinese word inside a clause
// is found, a time range bounds the index itself, and when no word matches,
// each term is looked for as text.

type Env = ReturnType<typeof historyEnv>;
const say = (env: Env, threadId: string, text: string) =>
  env.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text } });
const hitsOf = (result: ReturnType<AgentHistoryStore["search"]>) => result.results.flatMap((r) => r.hits.map((h) => h.messageId)).sort();
const search = (env: Env, query: string, extra: Partial<Parameters<AgentHistoryStore["search"]>[0]> = {}) =>
  new AgentHistoryStore(env.store.db).search({ callerThreadId: env.caller.id, projectId: env.projectId, query, includeCurrentLineage: true, ...extra });

test("search: a Chinese word inside a clause is found, beside another term's hits", () => {
  const env = historyEnv();
  try {
    const clause = say(env, env.thread.id, "我们讨论了数据库迁移的方案");
    const other = say(env, env.caller.id, "rollout notes for the release");
    expect(hitsOf(search(env, "数据库 rollout"))).toEqual([clause.id, other.id].sort());
  } finally {
    env.cleanup();
  }
});

test("search: the time range bounds the words index itself", () => {
  const env = historyEnv();
  try {
    const early = say(env, env.thread.id, "数据库 early");
    const late = say(env, env.thread.id, "数据库 late");
    indexAgentHistoryMessage(env.store.db, { ...early, createdAt: "2026-01-01T00:00:00.000Z" });
    indexAgentHistoryMessage(env.store.db, { ...late, createdAt: "2026-03-01T00:00:00.000Z" });
    const range = { preset: "all" as const, reason: "test", since: "2026-02-01T00:00:00.000Z", until: "2026-03-01T00:00:00.000Z" };
    expect(hitsOf(search(env, "数据库", { timeRange: range }))).toEqual([late.id]);
    // The range is applied to the words rows' own rowids: an entry whose time
    // drifted into the range while its words row stayed early is still left out.
    env.store.db.prepare("update agent_message_search_entries set message_created_at = '2026-02-15T00:00:00.000Z' where message_id = ?").run(early.id);
    expect(hitsOf(search(env, "数据库", { timeRange: range }))).toEqual([late.id]);
  } finally {
    env.cleanup();
  }
});

test("search: when no word matches, each term is looked for as text", () => {
  const env = historyEnv();
  try {
    const clause = say(env, env.thread.id, "我们讨论了数据库迁移的方案");
    // "据库迁" crosses two words, and "zzzz" is nowhere: the whole query is in
    // no message, but its first term is in one.
    expect(hitsOf(search(env, "据库迁 zzzz"))).toEqual([clause.id]);
  } finally {
    env.cleanup();
  }
});

test("search: a words index not ready is filled by the search before it reads", () => {
  const env = historyEnv();
  try {
    const clause = say(env, env.thread.id, "我们讨论了数据库迁移的方案");
    const other = say(env, env.caller.id, "rollout notes for the release");
    env.store.db.exec("insert into agent_message_search_words (agent_message_search_words) values ('delete-all'); delete from agent_message_search_word_keys; delete from agent_message_search_words_state");
    expect(hitsOf(search(env, "数据库 rollout"))).toEqual([clause.id, other.id].sort());
    // The hits alone do not tell (each scope's text fallback finds its own):
    // the search itself read both entries into the words index.
    expect(historyWordsReady(env.store.db)).toBe(true);
    expect(env.store.db.prepare("select count(*) as n from agent_message_search_word_keys").get()).toEqual({ n: 2 });
  } finally {
    env.cleanup();
  }
});

// A search's fill does not wipe the whole index when the ICU changes.
test("search: an index another segmenter wrote is left for the background, and the old index answers", () => {
  const env = historyEnv();
  try {
    const clause = say(env, env.thread.id, "数据库 迁移");
    search(env, "数据库");
    env.store.db.prepare("update agent_message_search_words_state set value = 'icu-older' where key = 'version'").run();
    const rows = () => (env.store.db.prepare("select count(*) as n from agent_message_search_word_keys").get() as { n: number }).n;
    expect(rows()).toBe(1);
    expect(hitsOf(search(env, "数据库"))).toEqual([clause.id]);
    expect(rows()).toBe(1);
    expect(env.store.db.prepare("select value from agent_message_search_words_state where key = 'version'").get()).toEqual({ value: "icu-older" });
  } finally {
    env.cleanup();
  }
});
