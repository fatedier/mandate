import { afterEach, expect, test } from "bun:test";
import { mergeHistoryWords } from "../src/server/modules/agent/history-words.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";

// The chat history's words index does not merge its segments as a message is
// written (SQLite's automerge: a merge now and then made one write take
// tens of milliseconds, more on a busy disk); a timed step merges a bounded amount
// instead, so the index stays as quick to search.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const segments = (e: StoresEnv) => (e.store.db.prepare("select count(*) as n from agent_message_search_words_idx").get() as { n: number }).n;

test("writing a message merges nothing in the words index", () => {
  env = freshStoresEnv("md-words-automerge-");
  const row = env.store.db.prepare("select v from agent_message_search_words_config where k = 'automerge'").get() as { v: number } | null;
  expect(row?.v).toBe(0);
});

test("a merge step folds the segments the writes left, and every message is still found", () => {
  env = freshStoresEnv("md-words-merge-");
  const thread = env.agentStore.getOrCreateThread("manager", null);
  for (let i = 0; i < 40; i++) {
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: `release checklist step ${i} zebra${i}` } });
  }
  const before = segments(env);
  mergeHistoryWords(env.store.db);
  mergeHistoryWords(env.store.db);
  expect(segments(env)).toBeLessThan(before);
  const matches = (word: string) => (env!.store.db.prepare("select count(*) as n from agent_message_search_words where agent_message_search_words match ?").get(word) as { n: number }).n;
  expect([matches("zebra7"), matches("checklist")]).toEqual([1, 40]);
});

test("a step merges until nothing is left to fold or its time is up, and says whether more is left", () => {
  env = freshStoresEnv("md-words-drain-");
  const db = env.store.db;
  const thread = env.agentStore.getOrCreateThread("manager", null);
  const words = Array.from({ length: 400 }, (_, i) => `term${i}`);
  for (let i = 0; i < 300; i++) {
    const text = Array.from({ length: 300 }, (_, j) => words[(i * 7 + j * 13) % words.length]).join(" ");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
  }
  // No time at all: one step, and more is left.
  expect(mergeHistoryWords(db, 0)).toBe(true);
  // With time, it goes on until nothing is left; then a step finds nothing.
  let more = true;
  for (let i = 0; i < 50 && more; i++) more = mergeHistoryWords(db);
  expect(more).toBe(false);
  expect(mergeHistoryWords(db)).toBe(false);
});
