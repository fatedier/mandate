import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { LlmCallStore } from "../src/server/modules/activity/llm-call-store.js";
import { initializeActivitySliceSchema, sliceOf, sliceStartMs } from "../src/server/modules/activity/slice-schema.js";
import { ANSWER_COLUMNS, WINDOW_META_PATHS } from "../src/server/modules/activity/window-calls.js";
import { summarizeActivity } from "../src/server/modules/activity/activity-summary-away.js";
import { ACTIVITY_GROUP_KEYS } from "../src/shared/api/activity.js";
import { createPriceCatalog } from "../src/server/modules/pricing/catalog.js";
import { PricingPass } from "../src/server/modules/pricing/pricing-pass.js";
import type { ProviderConfig } from "../src/server/config/types.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { freshLedgerDb, ledgerDeps, seedVaried } from "./helpers/ledger-seed.js";
import { preparedBy } from "./helpers/sql-watch.js";
import { runRetentionPass } from "./helpers/retention.js";

// Every change to a stored call that the Overview's answer reads is counted,
// and written to the hour the call was created in: a kept slice of that hour
// is then known to be out of date. A change the answer does not read (a
// payload emptied, the stream statistics dropped) counts nothing.

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

function state(db: Database): { seq: number; changes: Map<string, number> } {
  const seq = (db.prepare("select seq from activity_rollup_state where id = 1").get() as { seq: number }).seq;
  const rows = db.prepare("select start, seq from activity_slice_changes").all() as Array<{ start: string; seq: number }>;
  return { seq, changes: new Map(rows.map((row) => [row.start, row.seq])) };
}

/** The slices whose change `run` raised, and by how much the counter went up. */
function changed(db: Database, run: () => unknown): { slices: string[]; by: number } {
  const before = state(db);
  run();
  const after = state(db);
  const slices = [...after.changes].filter(([start, seq]) => seq > (before.changes.get(start) ?? -1)).map(([start]) => start).sort();
  // A slice's mark is the counter's value when its call changed: the last
  // change's is the counter as it stands, and none is ahead of it.
  for (const seq of after.changes.values()) expect(seq).toBeLessThanOrEqual(after.seq);
  if (slices.length) expect(Math.max(...slices.map((start) => after.changes.get(start)!))).toBe(after.seq);
  return { slices, by: after.seq - before.seq };
}

function insertCall(db: Database, id: string, createdAt: string, columns: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, purpose: "agent_wake_step", scope_type: "agent_thread", scope_id: "t-1", provider: "openai-compatible", provider_name: "gw",
    model: "model-test", base_url: "https://gw.example.test/v1", status: "succeeded", started_at: createdAt, finished_at: createdAt, created_at: createdAt, updated_at: createdAt,
    input_tokens: 1000, output_tokens: 10, metadata_json: JSON.stringify({ wakeId: "w-1", wakeReason: "user", threadScope: "manager", stream: { partCount: 9 } }),
    request_json: "{\"messages\":[]}", ...columns
  };
  const names = Object.keys(row);
  db.prepare(`insert into llm_calls (${names.join(", ")}) values (${names.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
}

test("a slice is the hour a call was created in", () => {
  expect(sliceOf("2026-03-04T05:06:07.890Z")).toBe("2026-03-04T05");
  expect(sliceStartMs("2026-03-04T05")).toBe(Date.UTC(2026, 2, 4, 5));
});

test("a call starting and finishing counts twice in its hour", () => {
  const { store } = freshStoresEnv();
  let id = "";
  const started = changed(store.db, () => { id = store.startLlmCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: "t-1", provider: "openai", model: "model-test" }).id; });
  const hour = sliceOf(new Date().toISOString());
  // (A test run across the turn of an hour sees the next one too.)
  expect(started.by).toBe(1);
  expect(started.slices.length).toBe(1);
  const finished = changed(store.db, () => store.finishLlmCall(id, { status: "succeeded", inputTokens: 120, outputTokens: 30 }));
  expect([finished.by, finished.slices]).toEqual([1, started.slices]);
  expect(started.slices[0]! <= hour).toBe(true);
});

test("the start-up sweep of interrupted calls counts in each one's hour", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  insertCall(db, "running-a", "2026-03-04T05:10:00.000Z", { status: "running", finished_at: null });
  insertCall(db, "running-b", "2026-03-04T07:10:00.000Z", { status: "running", finished_at: null });
  insertCall(db, "done", "2026-03-04T06:10:00.000Z");
  expect(changed(db, () => new LlmCallStore(db).markInterruptedLiveCallsFailed())).toEqual({ slices: ["2026-03-04T05", "2026-03-04T07"], by: 2 });
});

test("a metadata merge counts when it changes a key the answer reads, and not otherwise", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  insertCall(db, "a", "2026-03-04T05:10:00.000Z");
  expect(changed(db, () => store.mergeLlmCallMetadata("a", { cacheTtl: "5m" }))).toEqual({ slices: ["2026-03-04T05"], by: 1 });
  expect(changed(db, () => store.mergeLlmCallMetadata("a", { stream: { partCount: 3 } }))).toEqual({ slices: [], by: 0 });
  // The same value written again is no change.
  expect(changed(db, () => store.mergeLlmCallMetadata("a", { cacheTtl: "5m" }))).toEqual({ slices: [], by: 0 });
  for (const patch of [{ threadScope: "worker" }, { wakeId: "w-2" }, { wakeReason: "alarm" }, { contextInputTokens: 5000 }, { fallbackAttempt: true }]) {
    expect(changed(db, () => store.mergeLlmCallMetadata("a", patch)), JSON.stringify(patch)).toEqual({ slices: ["2026-03-04T05"], by: 1 });
  }
});

test("the pricing pass counts each call it prices, prices again or clears", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  const FILL = "https://fill.example.test/v1";
  const catalogWith = (input: number) => createPriceCatalog({ litellm: null, modelsDev: { date: "2026-03-01", plans: [], providers: [{ id: "fill", name: "Fill", api: FILL, models: [{ id: "m1", rates: { base: { input, output: 2 } } }] }] } });
  let catalog = catalogWith(1);
  let providers: Record<string, ProviderConfig> = { fill: { type: "openai-compatible", baseURL: FILL, apiKey: "", models: [{ id: "m1" }, { id: "m2" }] } as never };
  const now = Date.UTC(2026, 2, 10);
  const pass = new PricingPass({ db, data: { catalog: () => catalog }, providers: () => providers, now: () => now });
  insertCall(db, "priced", "2026-03-04T05:10:00.000Z", { model: "m1", base_url: FILL, provider_name: "fill" });
  insertCall(db, "unknown", "2026-03-05T09:10:00.000Z", { model: "m2", base_url: FILL, provider_name: "fill" });
  // The first price: one call priced from the catalog, the other Unpriced.
  expect(changed(db, () => pass.tick()).slices).toEqual(["2026-03-04T05", "2026-03-05T09"]);
  expect((db.prepare("select group_concat(cost_source) s from (select cost_source from llm_calls order by id)").get() as { s: string }).s).toBe("catalog,unpriced");
  expect(changed(db, () => pass.tick())).toEqual({ slices: [], by: 0 });
  // The list changes and now has the other model: the Unpriced call is priced again.
  catalog = createPriceCatalog({ litellm: null, modelsDev: { date: "2026-03-02", plans: [], providers: [{ id: "fill", name: "Fill", api: FILL, models: [{ id: "m1", rates: { base: { input: 1, output: 2 } } }, { id: "m2", rates: { base: { input: 3, output: 4 } } }] }] } });
  const repriced = changed(db, () => { for (let i = 0; i < 4; i += 1) pass.tick(); });
  expect(repriced.slices).toEqual(["2026-03-05T09"]);
  // The connection's price for one model changes: its calls are cleared, then priced again.
  providers = { fill: { type: "openai-compatible", baseURL: FILL, apiKey: "", models: [{ id: "m1", price: { input: 9, output: 9 } }, { id: "m2" }] } as never };
  const cleared = changed(db, () => { for (let i = 0; i < 6; i += 1) pass.tick(); });
  expect(cleared.slices).toEqual(["2026-03-04T05"]);
  expect(cleared.by).toBeGreaterThanOrEqual(2);
});

test("retention's rewrite of an old call's payload counts nothing", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  const now = new Date();
  insertCall(db, "old", iso(now.getTime() - 100 * DAY));
  const run = changed(db, () => expect(runRetentionPass(db, now).llmPayloadsCleared).toBe(1));
  expect(run).toEqual({ slices: [], by: 0 });
  // It did rewrite the row: the payload is gone and the stream statistics with it.
  const row = db.prepare("select request_json, metadata_json from llm_calls where id = 'old'").get() as { request_json: string | null; metadata_json: string };
  expect([row.request_json, JSON.parse(row.metadata_json).stream, JSON.parse(row.metadata_json).wakeReason]).toEqual([null, undefined, "user"]);
});

test("a deleted thread and an ended side chat count nothing", () => {
  const env = freshStoresEnv();
  const db = env.store.db;
  const deletion = new ThreadDeletion({ db, agentStore: env.agentStore, canvases: new CanvasStore(db, env.dir), isBusy: () => false, sse: { emit: () => {} } });
  const thread = env.agentStore.createManagerThread("Invented thread").id;
  const wake = env.agentStore.createWake({ threadId: thread, reason: "user", triggerMessageId: null });
  env.agentStore.finishWake(wake.id, "finished");
  const call = env.store.startLlmCall({ purpose: "agent_wake_step", scopeType: "agent_thread", scopeId: thread, provider: "openai", model: "model-test", requestJson: { input: "words" }, metadataJson: { wakeId: wake.id, wakeReason: "user", threadScope: "manager" } });
  env.store.finishLlmCall(call.id, { status: "succeeded", responseJson: { text: "reply" }, inputTokens: 120, outputTokens: 30 });
  env.agentStore.archiveThread(thread);
  const run = changed(db, () => expect(deletion.delete(thread)).toMatchObject({ ok: true }));
  expect(run).toEqual({ slices: [], by: 0 });
  // The thread's wake and the call's payload went; the call stayed.
  expect((db.prepare("select count(*) n from agent_wakes").get() as { n: number }).n).toBe(0);
  expect(db.prepare("select request_json, status from llm_calls where id = ?").get(call.id)).toEqual({ request_json: null, status: "succeeded" });
});

test("a call written into an older hour counts there", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  insertCall(db, "now", "2026-03-06T05:10:00.000Z");
  expect(changed(db, () => insertCall(db, "late", "2026-03-04T05:10:00.000Z"))).toEqual({ slices: ["2026-03-04T05"], by: 1 });
  expect(changed(db, () => db.prepare("delete from llm_calls where id = 'late'").run())).toEqual({ slices: ["2026-03-04T05"], by: 1 });
  // A call moved to another hour counts in both.
  expect(changed(db, () => db.prepare("update llm_calls set created_at = '2026-03-07T01:00:00.000Z' where id = 'now'").run()).slices).toEqual(["2026-03-06T05", "2026-03-07T01"]);
});

// SQLite removes the row a REPLACE collides with without running its delete
// trigger: the hour that call was in must be counted all the same.
test("a call replaced by one of the same id in another hour counts in the hour it left", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  insertCall(db, "a", "2026-03-04T05:10:00.000Z");
  const replace = (createdAt: string) => db.prepare(`insert or replace into llm_calls (id, purpose, status, started_at, created_at, updated_at) values ('a', 'agent_wake_step', 'succeeded', ?, ?, ?)`).run(createdAt, createdAt, createdAt);
  expect(changed(db, () => replace("2026-03-04T07:10:00.000Z")).slices).toEqual(["2026-03-04T05", "2026-03-04T07"]);
  expect((db.prepare("select count(*) n from llm_calls").get() as { n: number }).n).toBe(1);
  // Replaced within its hour, that hour.
  expect(changed(db, () => replace("2026-03-04T07:20:00.000Z")).slices).toEqual(["2026-03-04T07"]);
  // A new call is one change, not two.
  expect(changed(db, () => insertCall(db, "b", "2026-03-04T09:10:00.000Z"))).toEqual({ slices: ["2026-03-04T09"], by: 1 });
});

// A statement's own conflict clause rules the statements its triggers run:
// a mark written with a conflict clause of its own was skipped under
// `or ignore` and failed under an upsert. A writer added later (an import, a
// data fix) may use any of these.
test("a call written under any conflict clause counts in its hour", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  insertCall(db, "a", "2026-03-04T05:10:00.000Z");
  insertCall(db, "far", "2026-03-04T09:10:00.000Z");
  const price = (clause: string, micros: number) => () => db.prepare(`update ${clause} llm_calls set cost_micros = ? where id = 'a'`).run(micros);
  for (const [clause, micros] of [["or ignore", 1], ["or fail", 2], ["or abort", 3], ["or rollback", 4], ["or replace", 5], ["", 6]] as const) {
    expect(changed(db, price(clause, micros)), `update ${clause}`).toEqual({ slices: ["2026-03-04T05"], by: 1 });
  }
  for (const clause of ["or ignore", "or abort", "or fail", "or rollback"]) {
    const id = `new-${clause.slice(3)}`;
    expect(changed(db, () => db.prepare(`insert ${clause} into llm_calls (id, purpose, status, started_at, created_at, updated_at) values (?, 'agent_wake_step', 'succeeded', ?, ?, ?)`)
      .run(id, "2026-03-04T06:10:00.000Z", "2026-03-04T06:10:00.000Z", "2026-03-04T06:10:00.000Z")), `insert ${clause}`).toEqual({ slices: ["2026-03-04T06"], by: 1 });
  }
  // An upsert of a call that is there: its hour, and no error.
  const upsert = () => db.prepare(`insert into llm_calls (id, purpose, status, started_at, created_at, updated_at) values ('a', 'agent_wake_step', 'succeeded', ?, ?, ?)
    on conflict(id) do update set cost_micros = 99`).run("2026-03-04T05:10:00.000Z", "2026-03-04T05:10:00.000Z", "2026-03-04T05:10:00.000Z");
  expect(changed(db, upsert).slices).toEqual(["2026-03-04T05"]);
  expect(db.prepare("select cost_micros from llm_calls where id = 'a'").get()).toEqual({ cost_micros: 99 });
  // An update that takes another call's id removes that call without its
  // delete trigger: the hour it was in counts too.
  expect(changed(db, () => db.prepare("update or replace llm_calls set id = 'far' where id = 'a'").run()).slices).toEqual(["2026-03-04T05", "2026-03-04T09"]);
  expect((db.prepare("select count(*) n from llm_calls where id in ('a', 'far')").get() as { n: number }).n).toBe(1);
});

test("every column the answer reads is watched, and the payload columns are not", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  insertCall(db, "a", "2026-03-04T05:10:00.000Z");
  expect(ANSWER_COLUMNS).toContain("error_json");
  for (const column of ANSWER_COLUMNS) {
    expect(changed(db, () => db.prepare(`update llm_calls set ${column} = ${column} where id = 'a'`).run()), column).toEqual({ slices: ["2026-03-04T05"], by: 1 });
  }
  for (const column of ["request_json", "response_json", "output_json", "usage_json", "updated_at", "reasoning_tokens", "cost_note"]) {
    expect(changed(db, () => db.prepare(`update llm_calls set ${column} = ${column} where id = 'a'`).run()), column).toEqual({ slices: [], by: 0 });
  }
});

// The watch and the reads are built from the same names; this is what keeps
// them so: a column or a metadata key an answer starts to read without being
// watched shows here.
test("no statement of an answer reads a column or a metadata key of a call that is not watched", () => {
  const { db } = freshLedgerDb();
  seedVaried(db);
  const columns = (db.prepare("select name from pragma_table_info('llm_calls')").all() as Array<{ name: string }>).map((row) => row.name);
  const statements = ACTIVITY_GROUP_KEYS.flatMap((group) =>
    preparedBy(db, () => summarizeActivity(db, { days: 7, group, now: Date.now(), zone: "Asia/Singapore", day: null }, ledgerDeps))).filter((sql) => /\bllm_calls\b/.test(sql));
  // The window's read, the failures' reasons, a thread's step before the window, the period before.
  expect(new Set(statements).size).toBeGreaterThanOrEqual(4);
  const read = new Set(statements.flatMap((sql) => columns.filter((column) => new RegExp(`\\b${column}\\b`).test(sql))));
  expect([...read].filter((column) => column !== "metadata_json" && !(ANSWER_COLUMNS as readonly string[]).includes(column))).toEqual([]);
  expect(read.has("error_json") && read.has("metadata_json")).toBe(true);
  const keys = new Set(statements.flatMap((sql) => sql.match(/'\$\.[A-Za-z0-9_.]+'/g) ?? []).map((quoted) => quoted.slice(1, -1)));
  // `$.message` is read from error_json, not from the metadata.
  expect([...keys].filter((key) => key !== "$.message" && !(WINDOW_META_PATHS as readonly string[]).includes(key))).toEqual([]);
});

test("the triggers are made again at every start, one set of them", () => {
  const { store } = freshStoresEnv();
  const db = store.db;
  const triggers = () => (db.prepare("select name from sqlite_master where type = 'trigger' and name like 'activity_slice_%' order by name").all() as Array<{ name: string }>).map((row) => row.name);
  const first = triggers();
  expect(first.length).toBeGreaterThanOrEqual(4);
  // A trigger an older version left under the same prefix goes.
  db.exec("create trigger activity_slice_stale after insert on llm_calls begin select 1; end");
  insertCall(db, "a", "2026-03-04T05:10:00.000Z");
  const before = state(db);
  initializeActivitySliceSchema(db);
  expect(triggers()).toEqual(first);
  // What was counted stays counted.
  expect(state(db)).toEqual(before);
});
