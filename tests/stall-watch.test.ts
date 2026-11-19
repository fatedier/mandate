import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createStallWatch, httpStallLabel, watchDatabase } from "../src/server/platform/diagnostics/stall-watch.js";

// The server runs everything on one thread: work that holds it holds every
// request. The watch notices afterwards that its own timer came late, and
// says for how long and what ran then, so a stall seen in the log has a name.

function setup(over: { thresholdMs?: number; keepMinMs?: number } = {}) {
  let now = 0;
  let heap = 400 * 1024 * 1024;
  // Time it spent before the watch's first look is not the stall's.
  let cpu = 5_000;
  const lines: string[] = [];
  const watch = createStallWatch({
    thresholdMs: over.thresholdMs ?? 300,
    tickMs: 50,
    keepMinMs: over.keepMinMs ?? 50,
    now: () => now,
    clock: () => new Date(2026, 9, 30, 13, 5, 21),
    heapUsed: () => heap,
    cpuMs: () => cpu,
    loadAverage: () => 3.24,
    log: (line) => { lines.push(line); }
  });
  return {
    watch, lines,
    advance: (ms: number) => { now += ms; },
    /** The process's own CPU time goes on too: busy, it keeps up with the clock. */
    busy: (ms: number) => { now += ms; cpu += ms; },
    setHeapMb: (mb: number) => { heap = mb * 1024 * 1024; }
  };
}

test("a block past the threshold says how long, what ran in it, what was under way, and the heap", () => {
  const t = setup();
  t.watch.check();
  const endRequest = t.watch.begin("GET /api/agents/threads/:id/messages");
  t.advance(10);
  t.watch.run("sqlite select * from agent_messages where thread_id = ?", () => { t.busy(400); });
  t.watch.run("git diff --name-status", () => { t.advance(70); });
  t.setHeapMb(198);
  t.advance(20);
  t.watch.check();
  endRequest();
  expect(t.lines).toEqual([
    "[mandate] stall: blocked 450 ms at 13:05:21; ran then: sqlite select * from agent_messages where thread_id = ? 400 ms, git diff --name-status 70 ms;"
      + " under way: GET /api/agents/threads/:id/messages 0.5 s; heap 400 → 198 MB; cpu 400 ms; load 3.2"
  ]);
});

test("a short delay says nothing, short work is not kept, and work before the last tick is not named", () => {
  const t = setup();
  t.watch.check();
  t.watch.run("sqlite before the stall", () => { t.advance(60); });
  t.advance(10);
  t.watch.check();
  t.watch.run("tmux list-panes", () => { t.advance(30); });
  t.advance(320);
  t.watch.check();
  expect(t.lines).toEqual(["[mandate] stall: blocked 300 ms at 13:05:21; nothing recorded ran then; heap 400 → 400 MB; cpu 0 ms; load 3.2"]);
});

test("watched work is under way until it settles, and its synchronous start is kept when long", async () => {
  const t = setup();
  t.watch.check();
  let settle!: () => void;
  const job = t.watch.watched("retention pass", () => {
    t.advance(120);
    return new Promise<void>((resolve) => { settle = resolve; });
  });
  t.advance(300);
  t.watch.check();
  settle();
  await job;
  t.advance(400);
  t.watch.check();
  expect(t.lines).toEqual([
    "[mandate] stall: blocked 370 ms at 13:05:21; ran then: retention pass 120 ms; under way: retention pass 0.4 s; heap 400 → 400 MB; cpu 0 ms; load 3.2",
    "[mandate] stall: blocked 350 ms at 13:05:21; nothing recorded ran then; heap 400 → 400 MB; cpu 0 ms; load 3.2"
  ]);
});

test("work that ended before the late look is named while it overlapped the stall, not once it ended before it", () => {
  const t = setup();
  t.watch.check();
  t.watch.begin("GET /api/memory/briefs")();
  t.advance(10);
  const end = t.watch.begin("GET /api/workers/:id/changes");
  t.watch.run("git diff", () => { t.busy(400); });
  end();
  t.advance(200);
  t.watch.check();
  // Its own 0.4 s, not the time until the look.
  expect(t.lines).toEqual(["[mandate] stall: blocked 560 ms at 13:05:21; ran then: git diff 400 ms; under way: GET /api/workers/:id/changes 0.4 s; heap 400 → 400 MB; cpu 400 ms; load 3.2"]);
});

test("work of one kind that ran many times is named once, with how often and how long in all", () => {
  const t = setup({ keepMinMs: 10, thresholdMs: 100 });
  t.watch.check();
  for (let i = 0; i < 12; i++) t.watch.run("sqlite select seq from agent_messages", () => { t.busy(20); });
  t.watch.run("git diff", () => { t.busy(60); });
  t.watch.run("sqlite select one", () => { t.busy(5); });
  t.watch.check();
  expect(t.lines).toEqual(["[mandate] stall: blocked 255 ms at 13:05:21; ran then: sqlite select seq from agent_messages 12× 240 ms, git diff 60 ms; heap 400 → 400 MB; cpu 305 ms; load 3.2"]);
});

test("the process's watch logs a stall from 100 ms and keeps work from 10 ms", () => {
  const lines: string[] = [];
  let now = 0;
  const watch = createStallWatch({ now: () => now, heapUsed: () => 0, cpuMs: () => 0, loadAverage: () => 0, clock: () => new Date(2026, 9, 30, 13, 5, 21), log: (line) => { lines.push(line); } });
  watch.check();
  watch.run("short read", () => { now += 12; });
  now += 99 + 50 - 12;
  watch.check();
  expect(lines).toEqual([]);
  watch.run("short read", () => { now += 12; });
  now += 100 + 50 - 12;
  watch.check();
  expect(lines).toEqual(["[mandate] stall: blocked 100 ms at 13:05:21; ran then: short read 12 ms; heap 0 → 0 MB; cpu 0 ms; load 0.0"]);
});

test("a long list keeps the four longest and counts the rest", () => {
  const t = setup();
  t.watch.check();
  for (const [label, ms] of [["a", 60], ["b", 90], ["c", 70], ["d", 80], ["e", 100], ["f", 55]] as const) t.watch.run(label, () => { t.advance(ms); });
  t.watch.check();
  expect(t.lines[0]).toContain("ran then: e 100 ms, b 90 ms, d 80 ms, c 70 ms, and 2 more;");
});

// BEGIN and COMMIT are issued by bun:sqlite itself, past the statements the
// watch times: a commit that waited (on the disk, on a checkpoint) showed as
// nothing. A transaction is timed whole; what its statements do not account
// for is its BEGIN and COMMIT.
test("a watched database times each transaction whole, in every mode, and the transaction still commits", () => {
  const t = setup();
  const db = watchDatabase(new Database(":memory:"), {
    run: (label, fn) => t.watch.run(label, () => { const r = fn(); if (label === "sqlite transaction") t.advance(90); return r; })
  });
  t.watch.check();
  db.exec("create table notes (id integer primary key, text text)");
  const insert = db.prepare("insert into notes (text) values (?)");
  const write = db.transaction((text: string) => { insert.run(text); return text.length; });
  expect(write("one")).toBe(3);
  write.immediate("two");
  write.deferred("three");
  write.exclusive("four");
  expect(db.prepare("select count(*) n from notes").get()).toEqual({ n: 4 });
  t.advance(250);
  t.watch.check();
  expect(t.lines[0]).toContain("sqlite transaction 4× 360 ms");
});

test("a watched database names a slow statement by its SQL, and every statement answers as before", () => {
  const t = setup();
  const db = watchDatabase(new Database(":memory:"), {
    run: (label, fn) => t.watch.run(label, () => { const r = fn(); if (label.includes("count(*)")) t.advance(120); return r; })
  });
  t.watch.check();
  db.exec("create table notes (id integer primary key, text text)");
  db.prepare("insert into notes (text) values (?)").run("one");
  const insert = db.prepare("insert into notes (text) values (?)");
  db.transaction(() => { insert.run("two"); })();
  expect(db.prepare("select text from notes order by id").all()).toEqual([{ text: "one" }, { text: "two" }]);
  expect(db.prepare("select text from notes where id = ?").get(2)).toEqual({ text: "two" });
  expect(db.prepare("select text from notes order by id").values()).toEqual([["one"], ["two"]]);
  expect(db.prepare("select count(*)   n\n  from notes").get()).toEqual({ n: 2 });
  t.advance(250);
  t.watch.check();
  expect(t.lines[0]).toContain("ran then: sqlite select count(*) n from notes 120 ms;");
});

// Many reads share one long column list: cut at its first 80 characters,
// every one of them read the same, and a slow one could not be told apart.
test("a statement with a long column list is named by its last column, its table and its condition, so two of them are told apart", () => {
  const labels: string[] = [];
  const db = watchDatabase(new Database(":memory:"), { run: (label, fn) => { labels.push(label); return fn(); } });
  db.exec("create table messages (id text, thread_id text, seq integer, role text, source text, source_thread_id text, wake_id text, content text)");
  const columns = "m.id, m.thread_id, m.seq, m.role, m.source, m.source_thread_id, m.wake_id, m.content";
  db.prepare(`select ${columns} from messages m where m.thread_id = ? and m.seq >= ? order by m.seq`).all("t", 1);
  db.prepare(`select ${columns} from messages m where m.id in (?) and +m.thread_id = ?`).all("x", "t");
  db.prepare("select text from (select 'a' as text) where text = ?").get("a");
  // A short list is kept, and the table is the one after its first "from",
  // never one in a subquery further on.
  db.exec("create table wakes (id text, reason text, thread_id text)");
  db.prepare("select id, reason from wakes where id in (select value from json_each(?))").all("[]");
  // Two reads of one table and condition that select different columns (a
  // revision probe, then the vectors themselves) keep their last column apart.
  db.exec("create table vectors (entry_id text, model text, revision integer, vector_json text)");
  db.prepare("select e.entry_id as entry_id, e.revision as revision from vectors e where e.model = ?").all("m");
  db.prepare("select e.entry_id as entry_id, e.revision as revision, e.vector_json as vector_json from vectors e where e.model = ?").all("m");
  // Reads that share a long join differ late, in their order.
  const joined = `select ${columns} from messages m left join wakes w on w.id = m.wake_id and w.thread_id = m.thread_id where m.thread_id = ? order by m.seq`;
  db.prepare(`${joined} asc, m.id asc`).all("t");
  db.prepare(`${joined} desc, m.id desc`).all("t");
  // A last column that is an expression is not cut inside it.
  db.prepare("select coalesce(sum(case when m.role = 'assistant' then 1 else 0 end), 0) as n from messages m where m.thread_id = ?").get("t");
  const reads = labels.filter((label) => label.startsWith("sqlite select"));
  expect(reads).toEqual([
    "sqlite select …, m.content from messages m where m.thread_id = ? and m.seq >= ? order by m.seq",
    "sqlite select …, m.content from messages m where m.id in (?) and +m.thread_id = ?",
    "sqlite select text from (select 'a' as text) where text = ?",
    "sqlite select id, reason from wakes where id in (select value from json_each(?))",
    "sqlite select …, e.revision as revision from vectors e where e.model = ?",
    "sqlite select …, e.vector_json as vector_json from vectors e where e.model = ?",
    "sqlite select …, m.content from messages m left join wakes w on w.id = m.wake_id and w.thread_id = m.thread_id where m.thread_id = ? order by m.seq asc, m.id asc",
    "sqlite select …, m.content from messages m left join wakes w on w.id = m.wake_id and w.thread_id = m.thread_id where m.thread_id = ? order by m.seq desc, m.id desc",
    "sqlite select … from messages m where m.thread_id = ?"
  ]);
});

test("a request is named by its route: ids and numbers become :id, the query goes", () => {
  expect(httpStallLabel("GET", "/api/agents/threads/thr_qwer1234a/reply-tabs/rtab_x1y2z3w4?after=3")).toBe("GET /api/agents/threads/:id/reply-tabs/:id");
  expect(httpStallLabel("POST", "/api/workers/wkr_aB3dE6gH9/changes/12")).toBe("POST /api/workers/:id/changes/:id");
  expect(httpStallLabel("GET", "/api/memory/briefs")).toBe("GET /api/memory/briefs");
});

test("work under way under one label is named once, with how many and the oldest's age, so other work stays in view", () => {
  const t = setup();
  t.watch.check();
  const streams = [0, 1, 2, 3].map(() => { const end = t.watch.begin("model stream (in process)"); t.advance(1_000); return end; });
  t.advance(60_000);
  t.watch.check();
  const endRequest = t.watch.begin("POST /api/agents/threads/:id/messages");
  t.advance(10);
  t.busy(400);
  t.watch.check();
  endRequest();
  for (const end of streams) end();
  expect(t.lines.at(-1)).toBe(
    "[mandate] stall: blocked 360 ms at 13:05:21; nothing recorded ran then;"
      + " under way: model stream (in process) 4× 64.4 s, POST /api/agents/threads/:id/messages 0.4 s; heap 400 → 400 MB; cpu 400 ms; load 3.2"
  );
});

test("a label's entries under way show the longest of them, an ended one beside one still going", () => {
  const t = setup();
  t.watch.check();
  const first = t.watch.begin("GET /api/state");
  t.advance(10);
  const second = t.watch.begin("GET /api/state");
  t.advance(10);
  first();
  t.busy(480);
  t.watch.check();
  second();
  expect(t.lines.at(-1)).toContain("under way: GET /api/state 2× 0.5 s;");
});
