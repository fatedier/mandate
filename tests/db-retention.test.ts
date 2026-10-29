import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runRetentionPass } from "../src/server/platform/db/retention.js";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    create table agent_messages (
      id text primary key,
      thread_id text not null,
      seq integer not null,
      role text not null,
      source text not null default 'user',
      source_thread_id text,
      wake_id text,
      content text not null,
      created_at text not null
    );
    create index idx_agent_messages_thread_seq on agent_messages(thread_id, seq);
    create table llm_calls (
      id text primary key,
      purpose text not null,
      request_json text,
      metadata_json text,
      usage_json text,
      error_json text,
      created_at text not null,
      -- The price columns: retention must leave them as they are.
      cost_micros integer,
      cost_source text,
      reported_cost_micros integer,
      provider_name text
    );
    -- The tool-result unit's idle gate probes this table for a thread that has
    -- gone silent; no rows are inserted here, so that gate stays shut and these
    -- tests exercise only the two units they are about.
    create table agent_threads (
      id text primary key,
      scope text not null default 'overview',
      created_at text not null,
      updated_at text not null
    );
  `);
  return db;
}

let seq = 0;
function addMessage(db: Database, threadId: string, source: string, content: string) {
  seq += 1;
  db.prepare(
    `insert into agent_messages (id, thread_id, seq, role, source, content, created_at)
     values (?, ?, ?, 'user', ?, ?, '2026-07-01T00:00:00.000Z')`
  ).run(`m${seq}`, threadId, seq, source, content);
  return `m${seq}`;
}
const initial = (n: number) => `{"type":"text","metadata":{"runtimeContextKind":"initial"},"text":"[initial_context] ${n}"}`;
const update = (n: number) => `{"type":"text","text":"update ${n}"}`;

function remaining(db: Database, threadId: string): string[] {
  return (db.prepare(
    "select content from agent_messages where thread_id = ? order by seq"
  ).all(threadId) as Array<{ content: string }>).map((r) => r.content);
}

test("runtime-context before the latest initial is deleted, the rest is kept", () => {
  const db = freshDb();
  addMessage(db, "t1", "runtime-context", initial(1));
  addMessage(db, "t1", "runtime-context", update(1));
  addMessage(db, "t1", "runtime-context", initial(2));
  addMessage(db, "t1", "runtime-context", update(2));

  const result = runRetentionPass(db);

  expect(result.runtimeContextDeleted).toBe(2);
  expect(remaining(db, "t1")).toEqual([initial(2), update(2)]);
});

test("plan reminders before the latest initial go with the runtime context; later ones stay", () => {
  const db = freshDb();
  const old = `{"type":"text","text":"<plan-reminder>old</plan-reminder>"}`;
  const recent = `{"type":"text","text":"<plan-reminder>new</plan-reminder>"}`;
  addMessage(db, "t9", "runtime-context", initial(1));
  addMessage(db, "t9", "plan-reminder", old);
  addMessage(db, "t9", "runtime-context", initial(2));
  addMessage(db, "t9", "plan-reminder", recent);

  runRetentionPass(db);

  expect(remaining(db, "t9")).toEqual([initial(2), recent]);
});

test("a thread with no initial keeps every row", () => {
  const db = freshDb();
  addMessage(db, "t2", "runtime-context", update(1));
  addMessage(db, "t2", "runtime-context", update(2));

  expect(runRetentionPass(db).runtimeContextDeleted).toBe(0);
  expect(remaining(db, "t2").length).toBe(2);
});

test("messages that are not runtime-context are never touched", () => {
  const db = freshDb();
  addMessage(db, "t3", "self", `{"type":"text","text":"real work"}`);
  addMessage(db, "t3", "runtime-context", initial(1));
  addMessage(db, "t3", "runtime-context", initial(2));

  runRetentionPass(db);

  // The self-note message sits before the latest initial and must survive.
  expect(remaining(db, "t3")).toEqual([`{"type":"text","text":"real work"}`, initial(2)]);
});

// Rows that sit after a genuine initial marker and must not count as a newer
// one: a row that counted would delete the real marker behind it. The kind
// decides, never the text.
const notMarkers: { name: string; content: string }[] = [
  { name: "text that opens with the marker but carries no kind is not a marker",
    content: `{"type":"text","text":"[initial_context] quoted"}` },
  { name: "an update kind is not a marker, whatever its text says",
    content: `{"type":"text","metadata":{"runtimeContextKind":"update"},"text":"[initial_context] quoted"}` }
];

test.each(notMarkers)("$name", ({ content }) => {
  const db = freshDb();
  addMessage(db, "t-decoy", "runtime-context", initial(1));
  addMessage(db, "t-decoy", "runtime-context", content);

  expect(runRetentionPass(db).runtimeContextDeleted).toBe(0);
  expect(remaining(db, "t-decoy")).toEqual([initial(1), content]);
});

test("content that is not readable JSON is skipped, not fatal", () => {
  const db = freshDb();
  addMessage(db, "t8", "runtime-context", update(1));
  addMessage(db, "t8", "runtime-context", initial(1));
  // Sits after the real marker, so the backwards walk reads it first: json_extract
  // raises on malformed JSON, and an unguarded predicate would abort the pass.
  addMessage(db, "t8", "runtime-context", "not json at all");

  expect(runRetentionPass(db).runtimeContextDeleted).toBe(1);
  expect(remaining(db, "t8")).toEqual([initial(1), "not json at all"]);
});

test("a pass deletes at most the per-tick cap", () => {
  const db = freshDb();
  for (let i = 0; i < 250; i += 1) addMessage(db, "t5", "runtime-context", update(i));
  addMessage(db, "t5", "runtime-context", initial(99));

  expect(runRetentionPass(db).runtimeContextDeleted).toBe(200);
  expect(runRetentionPass(db).runtimeContextDeleted).toBe(50);
  expect(runRetentionPass(db).runtimeContextDeleted).toBe(0);
});

const NOW = new Date("2026-07-31T00:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z"; // past the 90-day window
const RECENT = "2026-07-30T00:00:00.000Z"; // inside it

/** Shaped as a wake step's row is: `stream` is by far the largest part of its
 *  metadata and is what the window reclaims; the rest is kept, read today
 *  (`phase`, `promptMaxSeq`) or not. */
const wakeMetadata = {
  providerName: "provider-1",
  wakeId: "wake_Tg5yHn3uJm8",
  threadScope: "worker",
  wakeReason: "alarm",
  allowTools: true,
  messageCount: 18,
  phase: "delivering",
  promptMaxSeq: 8500,
  stream: {
    status: "succeeded",
    partCount: 140,
    elapsedMs: 14000,
    partTypes: { start: 1, "tool-input-delta": 121, finish: 1 }
  }
};

function insertCall(db: Database, id: string, createdAt: string, metadata: unknown, request = "{}") {
  db.prepare(
    `insert into llm_calls (id, purpose, request_json, metadata_json, usage_json, error_json, created_at)
     values (?, 'agent_wake_step', ?, ?, '{usage}', '{err}', ?)`
  ).run(id, request, typeof metadata === "string" ? metadata : JSON.stringify(metadata), createdAt);
}

function readCall(db: Database, id: string): Record<string, any> {
  return db.prepare("select * from llm_calls where id = ?").get(id) as Record<string, any>;
}

test("a call past the window keeps all its metadata but the stream statistics", () => {
  const db = freshDb();
  insertCall(db, "old", OLD, wakeMetadata, "{req}");

  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(1);

  const row = readCall(db, "old");
  const kept = JSON.parse(row.metadata_json) as Record<string, unknown>;

  // CallDetailPanel.tsx -- the Phase field on the call the reader opened.
  expect(typeof kept.phase === "string" ? kept.phase : null).toBe("delivering");
  // agent-compression-controller.ts:377-392 -- the one non-UI reader of this column.
  expect(kept.promptMaxSeq).toBe(8500);
  expect(kept.providerName).toBe("provider-1");
  // Activity's ledger -- whose wake a call was, for what, and in which kind of thread.
  expect(kept.wakeId).toBe("wake_Tg5yHn3uJm8");
  expect(kept.threadScope).toBe("worker");
  expect(kept.wakeReason).toBe("alarm");

  // Only the stream statistics are gone, and the row itself is intact.
  const { stream: _stream, ...rest } = wakeMetadata;
  expect(kept).toEqual({ _retention: 1, ...rest });
  expect(Object.keys(kept)[0]).toBe("_retention");
  expect(row.request_json).toBeNull();
  expect(row.usage_json).toBe("{usage}");
  expect(row.error_json).toBe("{err}");
  expect(row.purpose).toBe("agent_wake_step");
  expect(row.metadata_json.length).toBeLessThan(JSON.stringify(wakeMetadata).length);
});

test("retention leaves the price columns", () => {
  const db = freshDb();
  insertCall(db, "old", OLD, wakeMetadata, "{req}");
  db.prepare("update llm_calls set cost_micros = 4200, cost_source = 'reported', reported_cost_micros = 4200, provider_name = 'provider-1' where id = 'old'").run();
  runRetentionPass(db, NOW);
  expect(db.prepare("select cost_micros, cost_source, reported_cost_micros, provider_name from llm_calls where id = 'old'").get())
    .toEqual({ cost_micros: 4200, cost_source: "reported", reported_cost_micros: 4200, provider_name: "provider-1" });
});

test("a field no reader was written for yet is kept past the window, nested values and all", () => {
  const db = freshDb();
  const judgement = { options: ["done", "cannot", "working"], answer: "done", subject: { replySeq: 412 }, probabilities: { done: 0.9, cannot: 0.02, working: 0.08 } };
  insertCall(db, "old", OLD, { providerName: "provider-1", judgement, stream: { partCount: 3 } });
  runRetentionPass(db, NOW);
  expect(JSON.parse(readCall(db, "old").metadata_json)).toEqual({ _retention: 1, providerName: "provider-1", judgement });
});

test("metadata that is json but not an object is kept as it is, and never takes a slot twice", () => {
  const db = freshDb();
  insertCall(db, "old", OLD, "[1,2,3]", "{req}");
  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(1);
  expect(readCall(db, "old")).toMatchObject({ request_json: null, metadata_json: "[1,2,3]" });
  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(0);
});

test("a call reduced under the earlier rule is not rewritten", () => {
  const db = freshDb();
  insertCall(db, "old", OLD, '{"_retention":1,"phase":"delivering"}');
  db.prepare("update llm_calls set request_json = null").run();
  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(0);
  expect(readCall(db, "old").metadata_json).toBe('{"_retention":1,"phase":"delivering"}');
});

test("a call inside the window is not touched", () => {
  const db = freshDb();
  insertCall(db, "new", RECENT, wakeMetadata, "{req}");

  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(0);

  const row = readCall(db, "new");
  expect(row.metadata_json).toBe(JSON.stringify(wakeMetadata));
  expect(row.request_json).toBe("{req}");
});

test("a second pass rewrites nothing it has already reduced", () => {
  const db = freshDb();
  insertCall(db, "old", OLD, wakeMetadata, "{req}");

  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(1);
  const afterFirst = readCall(db, "old").metadata_json;

  // A row that stays non-null cannot be recognised by `is not null`, and a row rewritten
  // every pass would hold a slot in the cap forever -- the rows behind it would never be
  // reached, and the pass would never converge.
  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(0);
  expect(readCall(db, "old").metadata_json).toBe(afterFirst);
});

test("metadata that is not readable json is kept, and never takes a slot twice", () => {
  const db = freshDb();
  insertCall(db, "old", OLD, "not json at all", "{req}");

  // The request payload still goes; the metadata cannot be read, so it is left alone
  // rather than guessed at or dropped.
  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(1);
  expect(readCall(db, "old").request_json).toBeNull();
  expect(readCall(db, "old").metadata_json).toBe("not json at all");

  // It can never come to look reduced, so it must not keep asking to be reduced.
  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(0);
});

test("rewriting llm payloads stops at the same per-tick cap", () => {
  const db = freshDb();
  for (let i = 0; i < 250; i += 1) insertCall(db, `c${i}`, OLD, wakeMetadata, "{req}");

  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(200);
  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(50);
  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(0);
});

test("an empty database is a no-op", () => {
  const db = freshDb();
  expect(runRetentionPass(db)).toEqual({
    runtimeContextDeleted: 0,
    llmPayloadsCleared: 0,
    toolResultsTruncated: 0
  });
});
