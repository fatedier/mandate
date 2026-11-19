import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { indexAgentHistoryMessage } from "../src/server/modules/agent/history-store.js";
import { writeWordsRow } from "../src/server/modules/agent/history-words.js";
import { closeInterruptedDreamRuns } from "../src/server/modules/memory/dream.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";
import { historyEnv } from "./helpers/history-env.js";
import { watchStatements } from "./helpers/sql-watch.js";

// A transaction that reads and then writes takes the write lock when it
// starts. Taken only at its first write, another connection's commit in
// between (a worker's, or a second process's) leaves what it read stale, and
// SQLite fails the write at once instead of waiting for the lock.

type Env = ReturnType<typeof historyEnv>;

/** Runs `operation` on `db` with a second connection trying to commit a write
 *  just before the operation's first write statement, inside its transaction:
 *  whether that write got in, and what the operation returned. */
function withWriterBetween<T>(env: Env, operation: () => T): { otherWrote: boolean; result: T } {
  const db = env.store.db;
  const other = new Database(path.join(env.dir, "mandate.db"));
  other.exec("pragma busy_timeout = 0");
  other.exec("create table if not exists elsewhere (x integer)");
  let tried = false;
  let otherWrote = false;
  const watch = watchStatements(db, undefined, (sql) => {
    if (!tried && db.inTransaction && /^\s*(insert|update|delete)\b/i.test(sql)) {
      tried = true;
      try {
        other.prepare("insert into elsewhere (x) values (1)").run();
        otherWrote = true;
      } catch {
        // Kept out: the operation holds the write lock.
      }
    }
  });
  try {
    const result = operation();
    expect(tried).toBe(true);
    return { otherWrote, result };
  } finally {
    watch.stop();
    other.close();
  }
}

const say = (env: Env, text: string) =>
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text } });

test("indexing a message holds the write lock from its start", () => {
  const env = historyEnv();
  const message = say(env, "release checklist");
  expect(withWriterBetween(env, () => indexAgentHistoryMessage(env.store.db, message)).otherWrote).toBe(false);
});

test("writing a message's words holds the write lock from its start", () => {
  const env = historyEnv();
  const message = say(env, "release checklist");
  const entry = { id: message.id, createdAt: message.createdAt, contentText: "release checklist again", toolNames: [], indexedAt: message.createdAt };
  expect(withWriterBetween(env, () => writeWordsRow(env.store.db, entry)).otherWrote).toBe(false);
});

test("writing a worker's record, and reading every record's words again, hold the write lock from their start", () => {
  const env = historyEnv();
  const records = new WorkerRecordStore(env.store.db);
  const write = () => records.write({ workerId: env.workerId, projectId: env.projectId, content: "Draft the release notes"});
  expect(withWriterBetween(env, write).otherWrote).toBe(false);
  expect(withWriterBetween(env, write).otherWrote).toBe(false);
  expect(withWriterBetween(env, () => records.reindex()).otherWrote).toBe(false);
});

test("closing the dream runs a restart interrupted holds the write lock from its start", () => {
  const env = historyEnv();
  env.store.db.prepare("insert into memory_dream_runs (id, trigger, status, phase, started_at) values ('dr_1', 'schedule', 'running', 'user', '2026-05-08T00:00:00.000Z')").run();
  const { otherWrote, result } = withWriterBetween(env, () => closeInterruptedDreamRuns(env.store.db));
  expect([otherWrote, result]).toEqual([false, 1]);
});
