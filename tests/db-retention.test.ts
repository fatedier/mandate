import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  featureEventStatus,
  firstFeatureEventFromCallMetadata,
  formatFeatureEventSourceLabel
} from "../src/client/lib/feature-event-source.js";
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
      created_at text not null
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
const initial = (n: number) => `{"type":"text","text":"[initial_context] ${n}"}`;
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

test("the metadata form of the initial marker is recognised too", () => {
  const db = freshDb();
  addMessage(db, "t4", "runtime-context", update(1));
  addMessage(db, "t4", "runtime-context", `{"type":"text","metadata":{"runtimeContextKind":"initial"},"text":"x"}`);

  expect(runRetentionPass(db).runtimeContextDeleted).toBe(1);
});

test("a message that only mentions the marker never supersedes a real one", () => {
  const db = freshDb();
  // A digest that quotes the marker mid-sentence. Matching the marker anywhere in
  // the row instead of at the start of the text would make this the thread's
  // "latest initial" and delete the genuine one behind it.
  const mention = `{"type":"text","text":"[runtime_context] the [initial_context] block above is stale"}`;
  addMessage(db, "t6", "runtime-context", initial(1));
  addMessage(db, "t6", "runtime-context", mention);

  expect(runRetentionPass(db).runtimeContextDeleted).toBe(0);
  expect(remaining(db, "t6")).toEqual([initial(1), mention]);
});

// Each decoy differs from the marker only where a LIKE pattern would not care: the
// two underscores are LIKE single-character wildcards, and LIKE is ASCII
// case-insensitive. startsWith() rejects all three, so the retention rule must too --
// placed after a genuine marker, a decoy that counted would delete the real one.
for (const [name, text] of [
  ["a hyphen where the marker has an underscore", "[initial-context] decoy"],
  ["a space where the marker has an underscore", "[initial context] decoy"],
  ["the marker in upper case", "[INITIAL_CONTEXT] decoy"]
] as const) {
  test(`${name} is not a marker`, () => {
    const db = freshDb();
    const decoy = JSON.stringify({ type: "text", text });
    addMessage(db, `t-decoy-${name}`, "runtime-context", initial(1));
    addMessage(db, `t-decoy-${name}`, "runtime-context", decoy);

    expect(runRetentionPass(db).runtimeContextDeleted).toBe(0);
    expect(remaining(db, `t-decoy-${name}`)).toEqual([initial(1), decoy]);
  });
}

test("an explicit update kind wins over marker-looking text", () => {
  const db = freshDb();
  const looksInitial = `{"type":"text","metadata":{"runtimeContextKind":"update"},"text":"[initial_context] quoted"}`;
  addMessage(db, "t7", "runtime-context", initial(1));
  addMessage(db, "t7", "runtime-context", looksInitial);

  expect(runRetentionPass(db).runtimeContextDeleted).toBe(0);
  expect(remaining(db, "t7")).toEqual([initial(1), looksInitial]);
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

/** A feature event in the shape the Activity row actually renders: the type guard in
 *  feature-event-source.ts reads type/featureId/label/kind/taskId, and the source label
 *  reads two levels down from `source`. Anything the retention rewrite flattens or drops
 *  here shows up as a changed helper result below, not as a changed key list. */
const featureEvent = {
  type: "feature_event",
  kind: "completion",
  featureId: "feat_Do_vu8YZJCM",
  workItemId: "wi_al1s_2hBIqU",
  source: {
    project: { id: "ebf44b48-f36d-4fa4-878f-2313e4134a3e", name: "frp" },
    feature: { id: "feat_Do_vu8YZJCM", name: "research-frps-v2-api-schema-review" },
    workItem: { id: "wi_al1s_2hBIqU", title: "frps/frpc proxy spec comparison added" },
    capturedAt: "2026-07-09T08:41:44.586Z"
  },
  label: "Add frps vs frpc proxy spec comparison to schema Canvas",
  taskId: "task_96K0JlZXi5A"
};

/** Modelled on a real agent_wake_step row: `stream` is 20.5 MB of the 25.7 MB of metadata
 *  measured in production and is what the window is meant to reclaim; `phase`,
 *  `featureEvents` and `promptMaxSeq` are what readers still ask for. */
const wakeMetadata = {
  providerName: "nova",
  wakeId: "wake_8llLQwARoM8",
  allowTools: true,
  messageCount: 18,
  phase: "delivering",
  promptMaxSeq: 8537,
  featureEvents: [featureEvent],
  stream: {
    status: "succeeded",
    partCount: 140,
    elapsedMs: 14059,
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

test("a call past the window keeps every metadata field its readers still need", () => {
  const db = freshDb();
  insertCall(db, "old", OLD, wakeMetadata, "{req}");

  expect(runRetentionPass(db, NOW).llmPayloadsCleared).toBe(1);

  const row = readCall(db, "old");
  const kept = JSON.parse(row.metadata_json) as Record<string, unknown>;

  // CallDetailPanel.tsx -- the Phase field on the call the reader opened.
  expect(typeof kept.phase === "string" ? kept.phase : null).toBe("delivering");
  // CallDetailPanel.tsx -- the feature-event annotation, read back through the helper the
  // panel itself calls rather than through a restatement of which keys it needs.
  const event = firstFeatureEventFromCallMetadata(kept);
  expect(event).toEqual(firstFeatureEventFromCallMetadata(wakeMetadata as never));
  expect(featureEventStatus(event!)).toBe("completed");
  expect(formatFeatureEventSourceLabel(event!.source)).toBe("frp / research-frps-v2-api-schema-review");
  // agent-compression-controller.ts:377-392 -- the one non-UI reader of this column.
  expect(kept.promptMaxSeq).toBe(8537);
  expect(kept.providerName).toBe("nova");

  // Everything nothing reads is gone, and the row itself is intact.
  expect(Object.keys(kept).sort()).toEqual(["_retention", "featureEvents", "phase", "promptMaxSeq", "providerName"]);
  expect(row.request_json).toBeNull();
  expect(row.usage_json).toBe("{usage}");
  expect(row.error_json).toBe("{err}");
  expect(row.purpose).toBe("agent_wake_step");
  expect(row.metadata_json.length).toBeLessThan(JSON.stringify(wakeMetadata).length);
});

test("a feature event nested under wakeMetadata survives where the helper looks for it", () => {
  const db = freshDb();
  // The helper's second lookup path. Hoisting the array to the top level would satisfy the
  // helper too, which is exactly why this asserts the shape as well as the result.
  insertCall(db, "old", OLD, {
    wakeMetadata: { featureEvents: [featureEvent], stream: { partCount: 140 } },
    stream: { partCount: 140 }
  });

  runRetentionPass(db, NOW);

  const kept = JSON.parse(readCall(db, "old").metadata_json) as Record<string, any>;
  expect(firstFeatureEventFromCallMetadata(kept)).toEqual(featureEvent as never);
  expect(kept.wakeMetadata.featureEvents).toEqual([featureEvent]);
  expect(kept.wakeMetadata.stream).toBeUndefined();
  expect(kept.featureEvents).toBeUndefined();
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
