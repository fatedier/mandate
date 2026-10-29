import { expect, test } from "bun:test";
import { AgentHistoryStore, indexAgentHistoryMessage } from "../src/server/modules/agent/history-store.js";
import { fillHistoryWords, historyWordsReady, historyWordsVersion, resetHistoryWordsAvailability, runHistoryWordsFill, WORD_KEY_SLOTS, writeWordsRow } from "../src/server/modules/agent/history-words.js";
import { createHistoryOldIndex } from "../src/server/modules/agent/history-schema.js";
import { historyEnv } from "./helpers/history-env.js";

// The words index: every write keeps it; a background fill reads in what it
// lacks (a rollback's rows, a new ICU's split). The old index is kept only
// where an SQLite too old for the words index runs.

type Env = ReturnType<typeof historyEnv>;
const wordRows = (env: Env) => env.store.db.prepare(`
  select k.entry_id, w.rowid as word_rowid
  from agent_message_search_word_keys k join agent_message_search_words w on w.rowid = k.word_rowid
  order by w.rowid`).all() as Array<{ entry_id: string; word_rowid: number }>;
/** The entries a words-index query finds. */
const matches = (env: Env, fts: string) => (env.store.db.prepare(`
  select k.entry_id from agent_message_search_words w join agent_message_search_word_keys k on k.word_rowid = w.rowid
  where agent_message_search_words match ?`).all(fts) as Array<{ entry_id: string }>).map((r) => r.entry_id);
const say = (env: Env, text: string) =>
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text } });

test("indexing a message writes its words; an edit writes them again; a message no longer indexed loses them", () => {
  const env = historyEnv();
  try {
    const message = say(env, "我们讨论了数据库迁移的方案");
    const entry = `hidx_${message.id}`;
    // Found by its words, one at a time and in order.
    expect([matches(env, '"数据 库"'), matches(env, '"迁移"'), matches(env, '"方案"')]).toEqual([[entry], [entry], [entry]]);
    indexAgentHistoryMessage(env.store.db, { ...message, content: { type: "text", text: "改成先迁移日志表" } });
    expect(wordRows(env)).toHaveLength(1);
    expect([matches(env, '"日志"'), matches(env, '"数据 库"')]).toEqual([[entry], []]);
    indexAgentHistoryMessage(env.store.db, { ...message, content: { type: "text", text: "   " } });
    expect(wordRows(env)).toEqual([]);
    expect(env.store.db.prepare("select count(*) as n from agent_message_search_word_keys").get()).toEqual({ n: 0 });
  } finally {
    env.cleanup();
  }
});

test("a word row's rowid runs in time: its second, then the next free slot in that second", () => {
  const env = historyEnv();
  try {
    const first = say(env, "first note");
    const second = say(env, "second note");
    const rows = wordRows(env);
    const base = Math.floor(Date.parse(first.createdAt) / 1000) * WORD_KEY_SLOTS;
    expect(rows[0]!.word_rowid).toBe(base);
    // Written within the same second, the next slot; a later second, its own base.
    const secondBase = Math.floor(Date.parse(second.createdAt) / 1000) * WORD_KEY_SLOTS;
    expect(rows[1]!.word_rowid).toBe(secondBase === base ? base + 1 : secondBase);
  } finally {
    env.cleanup();
  }
});

/** Runs fill steps until the index is ready: the steps taken and rows filled. */
function fillAll(env: Env, opts: { batch: number; version: string; reset?: boolean }) {
  let steps = 0, filled = 0;
  for (;;) {
    const r = fillHistoryWords(env.store.db, opts);
    steps += 1; filled += r.filled;
    if (r.ready) return { steps, filled };
    if (steps > 1000) throw new Error("no end");
  }
}
const clearWords = (env: Env) => env.store.db.exec("insert into agent_message_search_words (agent_message_search_words) values ('delete-all'); delete from agent_message_search_word_keys; delete from agent_message_search_words_state");
/** Watches which entries each fill step reads, by the entries query's shape. */
function watchReads(env: Env): string[] {
  const read: string[] = [];
  const db = env.store.db;
  const prepare = db.prepare.bind(db);
  (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("e.content_text, e.tool_names_json")) return statement;
    const all = statement.all.bind(statement);
    return Object.assign(statement, { all: (...args: unknown[]) => { const rows = all(...(args as [])) as Array<{ id: string }>; read.push(...rows.map((r) => r.id)); return rows; } });
  }) as typeof db.prepare;
  return read;
}

test("the fill reads in what the words index lacks, a window of entries per step, and only at the pass's end is it ready", () => {
  const env = historyEnv();
  try {
    for (let k = 0; k < 5; k++) say(env, `note ${k} 数据库`);
    // As after a deploy over an index the old binary wrote: no word rows, no state.
    clearWords(env);
    const read = watchReads(env);
    expect(historyWordsReady(env.store.db, "icu-test")).toBe(false);
    const order = (env.store.db.prepare("select id from agent_message_search_entries order by rowid").all() as Array<{ id: string }>).map((r) => r.id);
    // Each step reads at most its window of entries, in order, never the ones before.
    expect(fillHistoryWords(env.store.db, { batch: 2, version: "icu-test" })).toEqual({ ready: false, filled: 2 });
    expect(read).toEqual(order.slice(0, 2));
    expect(fillHistoryWords(env.store.db, { batch: 2, version: "icu-test" })).toEqual({ ready: false, filled: 2 });
    expect(read).toEqual(order.slice(0, 4));
    expect(fillAll(env, { batch: 2, version: "icu-test" }).filled).toBe(1);
    expect(read).toEqual(order);
    expect(historyWordsReady(env.store.db, "icu-test")).toBe(true);
    expect(wordRows(env)).toHaveLength(5);
  } finally {
    env.cleanup();
  }
});

test("a new segmenter reads everything again; a row an older binary changed is read again, one it removed is dropped", () => {
  const env = historyEnv();
  try {
    say(env, "first 数据库");
    const changed = say(env, "second 数据库");
    const removed = say(env, "third 数据库");
    fillAll(env, { batch: 10, version: "icu-a" });
    expect(historyWordsReady(env.store.db, "icu-a")).toBe(true);
    // Another ICU: not ready until all is read again with it.
    expect(historyWordsReady(env.store.db, "icu-b")).toBe(false);
    expect(fillAll(env, { batch: 10, version: "icu-b" }).filled).toBe(3);
    // An older binary, run in between, edits one entry and removes another without touching the words.
    env.store.db.prepare("update agent_message_search_entries set content_text = 'second 日志表', indexed_at = '2099-01-01T00:00:00.000Z' where message_id = ?").run(changed.id);
    env.store.db.prepare("delete from agent_message_search_entries where message_id = ?").run(removed.id);
    expect(fillAll(env, { batch: 10, version: "icu-b" }).filled).toBe(1);
    expect(wordRows(env)).toHaveLength(2);
    expect(matches(env, '"日志"')).toEqual([`hidx_${changed.id}`]);
  } finally {
    env.cleanup();
  }
});

// The removed entries' rows are not all dropped in one step, however many.
test("rows of removed entries are dropped a window at a time", () => {
  const env = historyEnv();
  try {
    const messages = Array.from({ length: 5 }, (_, k) => say(env, `note ${k}`));
    fillAll(env, { batch: 2, version: "icu-test" });
    // An older binary removed every entry; start-up passes over the index again.
    env.store.db.prepare(`delete from agent_message_search_entries where message_id in (${messages.map(() => "?").join(",")})`).run(...messages.map((m) => m.id));
    const kept = () => (env.store.db.prepare("select count(*) as n from agent_message_search_word_keys").get() as { n: number }).n;
    const queue: Array<() => void> = [];
    runHistoryWordsFill(env.store.db, { schedule: (step) => queue.push(step), batch: 2, version: "icu-test" });
    const seen: number[] = [];
    while (queue.length > 0) {
      queue.shift()!();
      seen.push(kept());
    }
    // Never more than a window dropped in one step.
    expect(seen.every((n, k) => (k === 0 ? 5 : seen[k - 1]!) - n <= 2)).toBe(true);
    expect(kept()).toBe(0);
    expect(wordRows(env)).toEqual([]);
  } finally {
    env.cleanup();
  }
});

// A search's fill does not wipe the whole index when the ICU changes.
test("a fill that may not reset leaves an index of another segmenter as it is", () => {
  const env = historyEnv();
  try {
    for (let k = 0; k < 3; k++) say(env, `note ${k} 数据库`);
    fillAll(env, { batch: 10, version: "icu-a" });
    expect(fillHistoryWords(env.store.db, { batch: 10, version: "icu-b", reset: false })).toEqual({ ready: false, filled: 0 });
    expect(wordRows(env)).toHaveLength(3);
    expect(historyWordsReady(env.store.db, "icu-a")).toBe(true);
  } finally {
    env.cleanup();
  }
});

// A word row written without its key (stopped part way) would take its
// second's slot for good, and every later write there would fail.
test("a word row and its key are written together, and a slot taken by a stray row is passed over", () => {
  const env = historyEnv();
  try {
    const db = env.store.db;
    db.exec("create temp trigger refuse_key before insert on agent_message_search_word_keys begin select raise(abort, 'refused'); end");
    const entry = { id: "hidx_x", createdAt: "2026-10-26T10:00:00.000Z", contentText: "数据库", toolNames: [], indexedAt: "2026-10-26T10:00:00.000Z" };
    expect(() => writeWordsRow(db, entry)).toThrow("refused");
    expect((db.prepare("select count(*) as n from agent_message_search_words").get() as { n: number }).n).toBe(0);
    db.exec("drop trigger refuse_key");
    // A stray row in the second's first slot, as an older crash could leave.
    const base = Date.parse(entry.createdAt) / 1000 * WORD_KEY_SLOTS;
    db.prepare("insert into agent_message_search_words (rowid, content_words, tool_names) values (?, 'stray', '')").run(base);
    writeWordsRow(db, entry);
    expect(db.prepare("select word_rowid from agent_message_search_word_keys where entry_id = 'hidx_x'").get()).toEqual({ word_rowid: base + 1 });
  } finally {
    env.cleanup();
  }
});

// Counts and the newest write can agree although an older binary added one
// entry and removed another, so start-up does not stop at them.
test("at start-up the fill reads the whole index again in scheduled steps before search uses it", () => {
  const env = historyEnv();
  try {
    const messages = Array.from({ length: 5 }, (_, k) => say(env, `note ${k} 数据库`));
    clearWords(env);
    const queue: Array<() => void> = [];
    const logs: string[] = [];
    const startUp = (first: boolean) => {
      runHistoryWordsFill(env.store.db, { schedule: (step) => queue.push(step), log: (line) => logs.push(line), batch: 2, version: "icu-test" });
      // The first step begins the pass. A first fill is not searched until it
      // ends; a later pass reads again an index that was whole, which search
      // goes on reading meanwhile.
      queue.shift()!();
      expect(historyWordsReady(env.store.db, "icu-test")).toBe(!first);
      let steps = 1;
      while (queue.length > 0) { queue.shift()!(); steps += 1; }
      expect(historyWordsReady(env.store.db, "icu-test")).toBe(true);
      return steps;
    };
    expect(startUp(true)).toBeGreaterThan(2);
    expect(logs).toEqual(["[mandate] chat history: read 5 messages into the words index"]);
    // An older binary added one entry without words and removed another's
    // entry, and the added one carries an older write time: counts and the
    // newest write agree, so only reading the entries tells.
    const db = env.store.db;
    const removedAt = (db.prepare("select indexed_at from agent_message_search_entries where message_id = ?").get(messages[0]!.id) as { indexed_at: string }).indexed_at;
    db.prepare("delete from agent_message_search_entries where message_id = ?").run(messages[0]!.id);
    const added = say(env, "note 5 数据库");
    db.prepare("delete from agent_message_search_words where rowid = (select word_rowid from agent_message_search_word_keys where entry_id = ?)").run(`hidx_${added.id}`);
    db.prepare("delete from agent_message_search_word_keys where entry_id = ?").run(`hidx_${added.id}`);
    db.prepare("update agent_message_search_entries set indexed_at = ? where message_id = ?").run(removedAt, added.id);
    const totals = (table: string) => db.prepare(`select count(*) as n, max(indexed_at) as at from ${table}`).get();
    expect(totals("agent_message_search_entries")).toEqual(totals("agent_message_search_word_keys"));
    startUp(false);
    expect(matches(env, '"note"').sort()).toEqual(messages.slice(1).map((m) => `hidx_${m.id}`).concat(`hidx_${added.id}`).sort());
  } finally {
    env.cleanup();
  }
});

test("without a words index (an SQLite too old to make it), the old index is kept, and messages, search and fills go on", () => {
  const env = historyEnv();
  try {
    // As the schema leaves such a database: the old index in its place.
    env.store.db.exec("drop table agent_message_search_words");
    createHistoryOldIndex(env.store.db);
    resetHistoryWordsAvailability(env.store.db);
    const message = say(env, "我们讨论了数据库迁移的方案");
    expect(env.store.db.prepare("select message_id from agent_message_search_entries").all()).toEqual([{ message_id: message.id }]);
    const oldIndex = () => env.store.db.prepare("select content_text from agent_message_search_fts").all();
    expect(oldIndex()).toEqual([{ content_text: "我们讨论了数据库迁移的方案" }]);
    // Indexing itself does not fail on the missing table (appendMessage would hide it).
    expect(() => indexAgentHistoryMessage(env.store.db, { ...message, content: { type: "text", text: "改成先迁移日志表" } })).not.toThrow();
    expect(oldIndex()).toEqual([{ content_text: "改成先迁移日志表" }]);
    expect(fillHistoryWords(env.store.db, { batch: 10, version: "icu-test" })).toEqual({ ready: false, filled: 0 });
    const queue: Array<() => void> = [];
    runHistoryWordsFill(env.store.db, { schedule: (step) => queue.push(step), version: "icu-test" });
    expect(queue).toEqual([]);
    expect(historyWordsReady(env.store.db, "icu-test")).toBe(false);
  } finally {
    env.cleanup();
  }
});

// The old index is large, and every write scans it whole to drop an entry's
// row (its entry id is not indexed).
test("with the words index there is no old index: none is made, and one an earlier build left is not written", () => {
  const env = historyEnv();
  try {
    const db = env.store.db;
    const oldIndexMade = () => Boolean(db.prepare("select 1 from sqlite_master where name = 'agent_message_search_fts'").get());
    expect(oldIndexMade()).toBe(false);
    // An install from before keeps its old index until the deploy drops it.
    createHistoryOldIndex(db);
    const message = say(env, "我们讨论了数据库迁移的方案");
    indexAgentHistoryMessage(db, { ...message, content: { type: "text", text: "改成先迁移日志表" } });
    expect(db.prepare("select count(*) as n from agent_message_search_fts").get()).toEqual({ n: 0 });
    expect(matches(env, '"日志"')).toEqual([`hidx_${message.id}`]);
  } finally {
    env.cleanup();
  }
});

// Until a first fill or a new segmenter's pass ends, nothing is searched by
// word: each term is looked for as text.
test("while the words index is not whole yet, search finds a message by its text", () => {
  const env = historyEnv();
  try {
    const message = say(env, "我们讨论了数据库迁移的方案");
    // Whole once, then read by another segmenter, which a search may not reset.
    fillAll(env, { batch: 10, version: "icu-another" });
    expect(historyWordsReady(env.store.db, historyWordsVersion())).toBe(false);
    const search = (query: string) => (new AgentHistoryStore(env.store.db).search({ callerThreadId: env.caller.id, projectId: env.projectId, query }) as { results: Array<{ hits: Array<{ messageId: string }> }> })
      .results.flatMap((r) => r.hits.map((h) => h.messageId));
    expect(search("迁移")).toEqual([message.id]);
    // An old index an earlier build left, no longer written, holds what the
    // first message said before: it is not read, so the message that says it
    // now is found.
    createHistoryOldIndex(env.store.db);
    env.store.db.prepare("insert into agent_message_search_fts (entry_id, content_text, tool_names) values (?, 'an earlier draft about rollback', '')").run(`hidx_${message.id}`);
    const now = say(env, "the rollback plan is agreed");
    expect(search("rollback")).toEqual([now.id]);
  } finally {
    env.cleanup();
  }
});

// The words index keeps only the index: the text is in the entries table, and
// a second copy of it would be most of the index's size.
test("the words index keeps no text of its own", () => {
  const env = historyEnv();
  try {
    say(env, "我们讨论了数据库迁移的方案");
    expect(env.store.db.prepare("select content_words, tool_names from agent_message_search_words").all()).toEqual([{ content_words: null, tool_names: null }]);
  } finally {
    env.cleanup();
  }
});

// Without brackets the cursor would bound only the stale rows, and every step
// would read missing ones from the first entry on.
test("a step reads only the entries in its window, missing and stale alike", () => {
  const env = historyEnv();
  try {
    const messages = Array.from({ length: 5 }, (_, k) => say(env, `note ${k}`));
    fillAll(env, { batch: 10, version: "icu-test" });
    const db = env.store.db;
    // The first entry lost its words, the last one's are stale.
    db.prepare("delete from agent_message_search_words where rowid = (select word_rowid from agent_message_search_word_keys where entry_id = ?)").run(`hidx_${messages[0]!.id}`);
    db.prepare("delete from agent_message_search_word_keys where entry_id = ?").run(`hidx_${messages[0]!.id}`);
    db.prepare("update agent_message_search_word_keys set indexed_at = 'older' where entry_id = ?").run(`hidx_${messages[4]!.id}`);
    const read = watchReads(env);
    const queue: Array<() => void> = [];
    runHistoryWordsFill(db, { schedule: (step) => queue.push(step), batch: 2, version: "icu-test" });
    queue.shift()!();
    expect(read).toEqual([`hidx_${messages[0]!.id}`]);
    while (queue.length > 0) queue.shift()!();
    expect(read).toEqual([`hidx_${messages[0]!.id}`, `hidx_${messages[4]!.id}`]);
  } finally {
    env.cleanup();
  }
});

// A words write that fails after the entry is in would leave the message out
// of words searches until the next start-up.
test("a message whose words fail to write is not indexed at all, and the next search's backfill indexes it whole", () => {
  const env = historyEnv();
  try {
    const db = env.store.db;
    fillAll(env, { batch: 10, version: "icu-test" });
    db.exec("create temp trigger refuse_key before insert on agent_message_search_word_keys begin select raise(abort, 'refused'); end");
    const message = say(env, "我们讨论了数据库迁移的方案");
    // appendMessage hid the failure: nothing of it is indexed.
    expect(db.prepare("select count(*) as n from agent_message_search_entries where message_id = ?").get(message.id)).toEqual({ n: 0 });
    db.exec("drop trigger refuse_key");
    new AgentHistoryStore(db).backfill();
    expect(matches(env, '"数据 库"')).toEqual([`hidx_${message.id}`]);
  } finally {
    env.cleanup();
  }
});

// A failed background step does not stop the fill for good, and a search may
// not reset another segmenter's index.
test("a failed background step is tried again later, sooner first, until the fill ends", () => {
  const env = historyEnv();
  try {
    const db = env.store.db;
    say(env, "note 数据库");
    fillAll(env, { batch: 10, version: "icu-old" });
    const queue: Array<{ step: () => void; delay: number }> = [];
    const errors: unknown[] = [];
    db.exec("create temp trigger refuse_key before insert on agent_message_search_word_keys begin select raise(abort, 'locked'); end");
    runHistoryWordsFill(db, { schedule: (step, delay = 0) => queue.push({ step, delay }), onError: (e) => errors.push(e), batch: 10, version: "icu-new" });
    queue.shift()!.step();
    expect(errors).toHaveLength(1);
    expect(queue.map((q) => q.delay)).toEqual([60_000]);
    queue.shift()!.step();
    expect(queue.map((q) => q.delay)).toEqual([120_000]);
    db.exec("drop trigger refuse_key");
    while (queue.length > 0) queue.shift()!.step();
    expect(historyWordsReady(db, "icu-new")).toBe(true);
    expect(matches(env, '"数据 库"')).toHaveLength(1);
  } finally {
    env.cleanup();
  }
});

/** Makes the next statements matching `sql` fail as SQLite does when the
 *  database is full or locked, `times` times. */
function failing(env: Env, sql: string, code: string, times: number): void {
  const db = env.store.db;
  const prepare = db.prepare.bind(db);
  let left = times;
  (db as { prepare: typeof db.prepare }).prepare = ((text: string) => {
    if (left > 0 && text.includes(sql)) {
      left -= 1;
      throw Object.assign(new Error(`${code}: injected`), { code });
    }
    return prepare(text);
  }) as typeof db.prepare;
}

// A backfill that fails on a full or locked database does not mark the
// message skipped, which nothing would index again.
test("a message the backfill could not index for a full or locked database is tried again, not skipped", () => {
  const env = historyEnv();
  try {
    const db = env.store.db;
    const message = say(env, "我们讨论了数据库迁移的方案");
    // As if its indexing had failed when it was written: no entry yet.
    db.prepare("delete from agent_message_search_words where rowid = (select word_rowid from agent_message_search_word_keys where entry_id = ?)").run(`hidx_${message.id}`);
    db.prepare("delete from agent_message_search_word_keys where entry_id = ?").run(`hidx_${message.id}`);
    db.prepare("delete from agent_message_search_entries where message_id = ?").run(message.id);
    failing(env, "insert into agent_message_search_words (", "SQLITE_FULL", 1);
    new AgentHistoryStore(db).backfill();
    expect(db.prepare("select count(*) as n from agent_message_search_skipped where message_id = ?").get(message.id)).toEqual({ n: 0 });
    new AgentHistoryStore(db).backfill();
    expect(matches(env, '"数据 库"')).toEqual([`hidx_${message.id}`]);
  } finally {
    env.cleanup();
  }
});

// The start-up pass begins inside the retried step: a lock there would
// otherwise leave the last pass's "ready" standing.
test("starting the start-up pass is tried again when the database is locked", () => {
  const env = historyEnv();
  try {
    const db = env.store.db;
    say(env, "note 数据库");
    fillAll(env, { batch: 10, version: "icu-test" });
    failing(env, "insert into agent_message_search_words_state", "SQLITE_BUSY", 1);
    const queue: Array<{ step: () => void; delay: number }> = [];
    runHistoryWordsFill(db, { schedule: (step, delay = 0) => queue.push({ step, delay }), batch: 10, version: "icu-test" });
    queue.shift()!.step();
    expect(queue.map((q) => q.delay)).toEqual([60_000]);
    while (queue.length > 0) queue.shift()!.step();
    expect(historyWordsReady(db, "icu-test")).toBe(true);
  } finally {
    env.cleanup();
  }
});

// A pass cut short at the last stop is not taken up where it stopped: an
// older binary may have changed what it had already read.
test("start-up begins a new pass from the first entry, whatever the last pass reached", () => {
  const env = historyEnv();
  try {
    const db = env.store.db;
    const messages = Array.from({ length: 4 }, (_, k) => say(env, `note ${k} 数据库`));
    fillAll(env, { batch: 10, version: "icu-test" });
    // The last run stopped mid-pass, past the first entry; then the first entry lost its words.
    const lastEntry = (db.prepare("select max(rowid) as m from agent_message_search_entries").get() as { m: number }).m;
    db.prepare("update agent_message_search_words_state set value = ? where key = 'cursor'").run(String(lastEntry));
    db.prepare("update agent_message_search_words_state set value = '0' where key = 'ready'").run();
    db.prepare("delete from agent_message_search_words where rowid = (select word_rowid from agent_message_search_word_keys where entry_id = ?)").run(`hidx_${messages[0]!.id}`);
    db.prepare("delete from agent_message_search_word_keys where entry_id = ?").run(`hidx_${messages[0]!.id}`);
    const queue: Array<() => void> = [];
    runHistoryWordsFill(db, { schedule: (step) => queue.push(step), batch: 10, version: "icu-test" });
    while (queue.length > 0) queue.shift()!();
    expect(matches(env, '"note"')).toHaveLength(4);
  } finally {
    env.cleanup();
  }
});
