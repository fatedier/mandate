import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runRetentionPass, truncateChatToolResults } from "../src/server/platform/db/retention.js";
import { truncateToolResultContent } from "../src/server/platform/db/tool-result-truncate.js";

function seed(db: Database): void {
  db.exec(`
    create table agent_messages (
      id text primary key, thread_id text not null, seq integer not null,
      role text not null, source text not null default 'user',
      content text not null, created_at text not null
    )
  `);
}

function addRow(
  db: Database,
  id: string, threadId: string, createdAt: string, result: unknown
): void {
  db.prepare(
    "insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values (?,?,?,?,?,?,?)"
  ).run(id, threadId, 1, "tool", "tool",
    JSON.stringify({ type: "tool_result", toolCallId: `c_${id}`, toolName: "bash", result }),
    createdAt);
}

function resultOf(db: Database, id: string): unknown {
  const row = db.prepare("select content from agent_messages where id = ?").get(id) as { content: string };
  return JSON.parse(row.content).result;
}

/** How many rows the pass still has work on, answered by the JS guard itself
 *  rather than by a restatement of its rules -- truncateToolResultContent() is
 *  what actually decides whether a row changes, so it is the only honest oracle
 *  for "the backlog is drained". */
function backlog(db: Database, headChars = 2000): number {
  const rows = db.prepare("select content from agent_messages").all() as Array<{ content: string }>;
  return rows.filter((r) => truncateToolResultContent(r.content, headChars) !== null).length;
}

const SILENT_THREAD = {
  headChars: 2000, cutoffIso: "2100-01-01T00:00:00.000Z", maxRows: 200, overCeiling: false
};

test("the backlog drains across ticks instead of stalling after the first one", () => {
  const db = new Database(":memory:");
  seed(db);
  for (let i = 0; i < 250; i += 1) {
    addRow(db, `r${i}`, "t-old", "2020-01-01T00:00:00.000Z", "h".repeat(5000));
  }
  expect(backlog(db)).toBe(250);

  // A shortened row is head + marker = 2,113 characters against a 2,000-character
  // threshold, so it still satisfies `length(content) > headChars`. Its thread is
  // silent, so `order by l.la asc` sorts it first: without a "not already
  // shortened" term the 200 rows tick one wrote fill the whole cap on tick two,
  // every one of them is refused by the JS guard, and the 50 behind them are
  // never reached -- 200 / 0 / 0, forever.
  expect(truncateChatToolResults(db, SILENT_THREAD)).toBe(200);
  expect(truncateChatToolResults(db, SILENT_THREAD)).toBe(50);
  expect(truncateChatToolResults(db, SILENT_THREAD)).toBe(0);
  expect(backlog(db)).toBe(0);
});

test("rows the JS guard refuses never occupy a slot in the cap", () => {
  // The other half of the same trap, and the one that is worse in production: a
  // row the query selects and truncateToolResultContent() then refuses holds a
  // slot in this tick and in every tick after it. Object results are the common
  // case -- 34,701 of them -- and measured against the production database the
  // first tick of 200 rows in this query's own order was 200 object results and
  // zero rewritable ones. The pass returned 0 while 11,428 rows waited behind
  // them.
  const db = new Database(":memory:");
  seed(db);
  for (let i = 0; i < 250; i += 1) {
    addRow(db, `obj${i}`, "t-old", "2020-01-01T00:00:00.000Z", { stdout: "o".repeat(9000) });
  }
  // Long envelope, short string: `length(content)` is over the head while the
  // result the guard measures is under it. 281 production rows look like this.
  addRow(db, "envelope", "t-old", "2020-01-01T00:00:00.000Z", "p".repeat(1999));
  addRow(db, "real", "t-old", "2020-01-01T00:00:00.000Z", "s".repeat(5000));
  expect(backlog(db)).toBe(1);

  // Written as "run until it stops" rather than as fixed tick counts so it holds
  // whichever of the tied rows the query happens to order first.
  for (let tick = 0; tick < 5 && truncateChatToolResults(db, SILENT_THREAD) > 0; tick += 1);

  expect(backlog(db)).toBe(0);
  expect(String(resultOf(db, "real"))).toContain("[truncated, original 5000 chars]");
  // ...and the rows it could not shorten are still whole.
  expect((resultOf(db, "obj0") as { stdout: string }).stdout).toBe("o".repeat(9000));
  expect(resultOf(db, "envelope")).toBe("p".repeat(1999));
});

test("content that is not readable JSON is skipped rather than aborting the pass", () => {
  const db = new Database(":memory:");
  seed(db);
  db.prepare(
    "insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values (?,?,?,?,?,?,?)"
  ).run("bad", "t-old", 1, "tool", "tool", `{not json at all${"!".repeat(3000)}`, "2020-01-01T00:00:00.000Z");
  addRow(db, "good", "t-old", "2020-01-01T00:00:00.000Z", "s".repeat(5000));

  // json_extract() raises "malformed JSON" rather than returning null, so an
  // unguarded predicate would take the whole pass down on this row.
  expect(truncateChatToolResults(db, SILENT_THREAD)).toBe(1);
  expect(String(resultOf(db, "good"))).toContain("[truncated, original 5000 chars]");
  expect(backlog(db)).toBe(0);
});

test("age trigger: truncates a silent thread and leaves an active one alone", () => {
  const db = new Database(":memory:");
  seed(db);
  addRow(db, "old", "t-old", "2020-01-01T00:00:00.000Z", "a".repeat(5000));
  addRow(db, "new", "t-new", "2999-01-01T00:00:00.000Z", "b".repeat(5000));

  const n = truncateChatToolResults(db, {
    headChars: 2000, cutoffIso: "2100-01-01T00:00:00.000Z", maxRows: 100, overCeiling: false
  });

  expect(n).toBe(1);
  expect(String(resultOf(db, "old"))).toContain("[truncated, original 5000 chars]");
  // The positive half: an active thread must be untouched, or an implementation
  // that truncates everything would satisfy the assertion above.
  expect(resultOf(db, "new")).toBe("b".repeat(5000));
});

test("ceiling trigger: ignores age and takes the oldest first", () => {
  const db = new Database(":memory:");
  seed(db);
  addRow(db, "recent", "t-recent", "2999-01-01T00:00:00.000Z", "c".repeat(5000));

  const n = truncateChatToolResults(db, {
    headChars: 2000, cutoffIso: "2000-01-01T00:00:00.000Z", maxRows: 100, overCeiling: true
  });

  expect(n).toBe(1);
  expect(String(resultOf(db, "recent"))).toContain("[truncated, original 5000 chars]");
});

test("under the ceiling and inside the window: touches nothing", () => {
  const db = new Database(":memory:");
  seed(db);
  addRow(db, "recent", "t-recent", "2999-01-01T00:00:00.000Z", "d".repeat(5000));

  const n = truncateChatToolResults(db, {
    headChars: 2000, cutoffIso: "2000-01-01T00:00:00.000Z", maxRows: 100, overCeiling: false
  });

  expect(n).toBe(0);
  expect(resultOf(db, "recent")).toBe("d".repeat(5000));
});

test("respects maxRows so one tick cannot block the loop", () => {
  const db = new Database(":memory:");
  seed(db);
  for (let i = 0; i < 5; i += 1) {
    addRow(db, `r${i}`, "t-old", "2020-01-01T00:00:00.000Z", "e".repeat(5000));
  }
  const n = truncateChatToolResults(db, {
    headChars: 2000, cutoffIso: "2100-01-01T00:00:00.000Z", maxRows: 2, overCeiling: false
  });
  expect(n).toBe(2);
});

test("a second pass over the same data changes nothing", () => {
  const db = new Database(":memory:");
  seed(db);
  addRow(db, "old", "t-old", "2020-01-01T00:00:00.000Z", "f".repeat(5000));
  const opts = {
    headChars: 2000, cutoffIso: "2100-01-01T00:00:00.000Z", maxRows: 100, overCeiling: false
  };
  expect(truncateChatToolResults(db, opts)).toBe(1);
  expect(truncateChatToolResults(db, opts)).toBe(0);
});

test("object results are left alone even in a silent thread", () => {
  const db = new Database(":memory:");
  seed(db);
  addRow(db, "obj", "t-old", "2020-01-01T00:00:00.000Z", { stdout: "g".repeat(9000) });
  const n = truncateChatToolResults(db, {
    headChars: 2000, cutoffIso: "2100-01-01T00:00:00.000Z", maxRows: 100, overCeiling: false
  });
  expect(n).toBe(0);
  expect((resultOf(db, "obj") as { stdout: string }).stdout).toBe("g".repeat(9000));
});

// runRetentionPass() also touches runtime-context and llm_calls, so this needs
// the fuller schema rather than the two-column `seed()` above.
function seedFullSchema(db: Database): void {
  db.exec(`
    create table agent_messages (
      id text primary key, thread_id text not null, seq integer not null,
      role text not null, source text not null default 'user',
      source_thread_id text, wake_id text,
      content text not null, created_at text not null
    );
    create index idx_agent_messages_thread_seq on agent_messages(thread_id, seq);
    create table llm_calls (
      id text primary key, purpose text not null,
      request_json text, metadata_json text, usage_json text, error_json text,
      created_at text not null
    );
    create table agent_threads (
      id text primary key, scope text not null default 'overview',
      created_at text not null, updated_at text not null
    );
  `);
}

function addThread(db: Database, id: string): void {
  db.prepare(
    "insert into agent_threads (id, scope, created_at, updated_at) values (?, 'overview', ?, ?)"
  ).run(id, "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
}

/** Records the SQL every statement in a pass prepares, so a test can assert that
 *  the expensive candidate query was not one of them. */
function recordPreparedSql(db: Database): string[] {
  const seen: string[] = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    seen.push(sql);
    return original(sql);
  };
  return seen;
}

const CANDIDATE_QUERY_FINGERPRINT = "with last as (select thread_id, max(created_at) la";

test("the idle gate skips the candidate query when no thread has expired", () => {
  // Under the ceiling with every thread still active, neither trigger can be
  // armed, so there is nothing for the candidate query to find -- and finding
  // that out costs 200-1000 ms against the production database, every hour,
  // forever. The probe that replaces it costs about 1 ms.
  const now = new Date("2026-06-01T00:00:00.000Z");
  const db = new Database(":memory:");
  seedFullSchema(db);
  addThread(db, "t-active");
  addRow(db, "fresh", "t-active", now.toISOString(), "z".repeat(5000));

  const sql = recordPreparedSql(db);
  expect(runRetentionPass(db, now).toolResultsTruncated).toBe(0);

  expect(sql.some((s) => s.includes(CANDIDATE_QUERY_FINGERPRINT))).toBe(false);
  expect(resultOf(db, "fresh")).toBe("z".repeat(5000));
});

test("the idle gate skips when an expired thread holds nothing it can shorten", () => {
  // The case the production database is actually in, and the reason the gate
  // cannot just ask "is any thread expired": threads expire permanently, so a
  // gate asking only that is open forever from the first one onward. Here the
  // thread is a year past the window and every row in it is a kind this pass
  // never rewrites -- an object result and a string already under the head.
  const now = new Date("2026-06-01T00:00:00.000Z");
  const db = new Database(":memory:");
  seedFullSchema(db);
  addThread(db, "t-silent");
  addRow(db, "obj", "t-silent", "2020-01-01T00:00:00.000Z", { stdout: "o".repeat(9000) });
  addRow(db, "short", "t-silent", "2020-01-01T00:00:00.000Z", "s".repeat(100));

  const sql = recordPreparedSql(db);
  expect(runRetentionPass(db, now).toolResultsTruncated).toBe(0);

  expect(sql.some((s) => s.includes(CANDIDATE_QUERY_FINGERPRINT))).toBe(false);
  expect((resultOf(db, "obj") as { stdout: string }).stdout).toBe("o".repeat(9000));
});

test("the idle gate opens as soon as one thread is past the window", () => {
  // The positive half: a gate that never opens would satisfy the assertion above
  // and would also never shorten anything again.
  const now = new Date("2026-06-01T00:00:00.000Z");
  const db = new Database(":memory:");
  seedFullSchema(db);
  addThread(db, "t-silent");
  addRow(db, "stale", "t-silent", "2020-01-01T00:00:00.000Z", "z".repeat(5000));

  const sql = recordPreparedSql(db);
  expect(runRetentionPass(db, now).toolResultsTruncated).toBe(1);

  expect(sql.some((s) => s.includes(CANDIDATE_QUERY_FINGERPRINT))).toBe(true);
  expect(String(resultOf(db, "stale"))).toContain("[truncated, original 5000 chars]");
});

test("the ceiling trigger runs the query even with no expired thread", () => {
  // The gate asks two questions and only skips when both say no. Over the
  // ceiling the age gate is dropped entirely, so an all-active database must
  // still be worked on.
  const now = new Date("2026-06-01T00:00:00.000Z");
  const retention = { chatRetentionDays: 90, chatMaxTableBytes: 500, chatToolResultHeadChars: 50 };
  const db = new Database(":memory:");
  seedFullSchema(db);
  addThread(db, "t-active");
  addRow(db, "big", "t-active", now.toISOString(), "y".repeat(600));

  expect(runRetentionPass(db, now, retention).toolResultsTruncated).toBe(1);
  expect(String(resultOf(db, "big"))).toContain("[truncated, original 600 chars]");
});

test("the ceiling cache is keyed per database, not shared across databases", () => {
  // Two active (non-silent) threads, same `now`, same retention config: only
  // their table size differs. db1's row is well under chatMaxTableBytes; db2's
  // is well over it. Both threads are "recently active" so the age gate alone
  // would exclude both rows -- only overCeiling can make db2's row eligible.
  const now = new Date("2026-06-01T00:00:00.000Z");
  const nowIso = now.toISOString();
  const retention = { chatRetentionDays: 90, chatMaxTableBytes: 500, chatToolResultHeadChars: 50 };

  const db1 = new Database(":memory:");
  seedFullSchema(db1);
  addRow(db1, "small", "t-active-1", nowIso, "x".repeat(30));
  runRetentionPass(db1, now, retention);

  const db2 = new Database(":memory:");
  seedFullSchema(db2);
  addRow(db2, "big", "t-active-2", nowIso, "y".repeat(600));
  runRetentionPass(db2, now, retention);

  // db2 is genuinely over the ceiling. A cache shared across databases (rather
  // than keyed by the Database instance) would answer db2's check with db1's
  // "under ceiling" result, computed moments earlier at the same `now`, and
  // this row would be left untouched.
  expect(String(resultOf(db2, "big"))).toContain("[truncated, original 600 chars]");
});
