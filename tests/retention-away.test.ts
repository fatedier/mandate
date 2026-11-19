import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resourceDir, segment } from "../src/server/platform/fs/resources.js";
import { runRetentionAway, type RetentionRequest } from "../src/server/platform/db/retention-away.js";
import { applyRetentionWork, type RetentionWork } from "../src/server/platform/db/retention.js";
import { removeToolOutputs, type StaleToolOutputs } from "../src/server/platform/db/tool-output-retention.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { allMessages } from "./helpers/thread-messages.js";

// The hourly retention pass scanned the whole chat table on the server's one
// thread, for seconds every hour on a long-used database, while every request,
// terminal and agent waited. Its work is found on a thread of its own now,
// reading only; the server's connection does it, a few hundred rows.

const RETENTION = { chatRetentionDays: 90, chatMaxTableBytes: 512 * 1024 * 1024, chatToolResultHeadChars: 2000 };

function seeded() {
  const env = freshStoresEnv("md-retention-away-");
  const thread = env.agentStore.createManagerThread("Release");
  const say = (text: string, initial: boolean) => env.agentStore.appendMessage({
    threadId: thread.id, role: "user", source: "runtime-context",
    content: { type: "text", text, ...(initial ? { metadata: { runtimeContextKind: "initial" } } : {}) }
  });
  say("[initial_context] 1", true);
  say("update 1", false);
  say("[initial_context] 2", true);
  say("update 2", false);
  // Tool output: one folder no thread owns any more (it goes), one file a
  // running command still writes (it stays).
  const outputs = resourceDir({ kind: "global" }, "tool-output", env.dir);
  fs.mkdirSync(path.join(outputs, "gone-thread"), { recursive: true });
  const orphan = path.join(outputs, "gone-thread", "old.txt");
  const running = path.join(outputs, "gone-thread", "running.txt");
  fs.writeFileSync(orphan, "x");
  fs.writeFileSync(running, "y");
  const request = (over: Partial<RetentionRequest> = {}): RetentionRequest => ({
    dbPath: env.store.db.filename, nowMs: Date.now(), retention: RETENTION, ceiling: null,
    dataDir: env.dir, runningPaths: [running], ...over
  });
  const texts = () => allMessages(env.agentStore, thread.id).map((m) => (m.content as { text: string }).text);
  const sweep = { db: env.store.db, dataDir: env.dir, now: new Date(), runningPaths: [running] };
  return { env, request, orphan, running, texts, sweep, outputs };
}

test("an hourly pass finds its work on its own thread, writing nothing; the server's connection does it: superseded runtime context and orphaned tool output go, a running command's file stays", async () => {
  const s = seeded();
  const outcome = await runRetentionAway(s.request()).done;
  expect(s.texts()).toHaveLength(4);
  expect(fs.existsSync(s.orphan)).toBe(true);
  expect(applyRetentionWork(s.env.store.db, outcome.work as RetentionWork)).toEqual({ runtimeContextDeleted: 2, llmPayloadsCleared: 0, toolResultsTruncated: 0, replayStateCleared: 0, mailboxDeleted: 0, skipMarkersDeleted: 0 });
  expect(removeToolOutputs(s.sweep, outcome.toolOutputs as StaleToolOutputs)).toEqual({ deleted: 1 });
  expect(s.texts()).toEqual(["[initial_context] 2", "update 2"]);
  expect([fs.existsSync(s.orphan), fs.existsSync(s.running)]).toEqual([false, true]);
});

// A second writer would fail a transaction of the server's that read before
// the write landed (SQLITE_BUSY_SNAPSHOT: no wait can save it).
test("a transaction of the server's that read before the pass and writes after it still commits", async () => {
  const s = seeded();
  const db = s.env.store.db;
  db.exec("begin");
  db.prepare("select count(*) from agent_messages").get();
  await runRetentionAway(s.request()).done;
  db.prepare("update agent_threads set title = 'Renamed' where 1").run();
  db.exec("commit");
  expect(s.env.agentStore.listOpenManagerThreads().map((t) => t.title)).toEqual(["Renamed"]);
});

// The walk runs while the server goes on: a thread made, or a command started,
// after it looked keeps its output.
test("output of a thread made, or a command started, after the walk looked is kept", async () => {
  const s = seeded();
  const late = path.join(s.outputs, segment("thr_late"), "log.txt");
  fs.mkdirSync(path.dirname(late), { recursive: true });
  fs.writeFileSync(late, "z");
  const outcome = await runRetentionAway(s.request()).done;
  const found = outcome.toolOutputs as StaleToolOutputs;
  expect(found.files).toContain(late);
  expect(found.files).toContain(s.orphan);
  // Meanwhile: the thread is made, and the orphan's folder gets a running command.
  const now = new Date().toISOString();
  s.env.store.db.prepare("insert into agent_threads (id, scope, title, created_at, updated_at) values ('thr_late', 'manager', 'Late', ?, ?)").run(now, now);
  expect(removeToolOutputs({ ...s.sweep, runningPaths: [s.running, s.orphan] }, found)).toEqual({ deleted: 0 });
  expect([fs.existsSync(late), fs.existsSync(s.orphan)]).toEqual([true, true]);
});

test("the main thread goes on while the pass runs", async () => {
  const s = seeded();
  const order: string[] = [];
  setTimeout(() => order.push("main thread"), 0);
  await runRetentionAway(s.request()).done.then(() => order.push("pass"));
  expect(order).toEqual(["main thread", "pass"]);
});

// Measuring the chat table is a full scan (seconds on a large one), done once
// a day; a worker per pass has a new connection each time, so the reading is
// carried from pass to pass.
test("the day's reading of the table size is carried to the next pass, not taken again", async () => {
  const s = seeded();
  const first = await runRetentionAway(s.request()).done;
  expect(typeof first.ceiling?.bytes).toBe("number");
  const anHourLater = await runRetentionAway(s.request({ nowMs: Date.now() + 3_600_000, ceiling: first.ceiling })).done;
  expect(anHourLater.ceiling).toEqual(first.ceiling);
  const aDayLater = await runRetentionAway(s.request({ nowMs: Date.now() + 25 * 3_600_000, ceiling: first.ceiling })).done;
  expect(aDayLater.ceiling!.checkedAtMs).toBeGreaterThan(first.ceiling!.checkedAtMs);
});

test("a pass stopped at shutdown ends its thread and says so", async () => {
  const s = seeded();
  const run = runRetentionAway(s.request());
  run.stop();
  await expect(run.done).rejects.toThrow("stopped");
});

test("a database the pass cannot open is an error for each part, not a hang", async () => {
  const s = seeded();
  const outcome = await runRetentionAway(s.request({ dbPath: path.join(s.env.dir, "no-such-dir", "mandate.db") })).done;
  expect(outcome.work).toEqual({ error: expect.stringMatching(/unable to open/) });
  expect(outcome.toolOutputs).toEqual({ error: expect.stringMatching(/unable to open/) });
});

// The worker logs at this thread's level: a pass that cannot read a file in
// a thread's folder says so at "error", and nothing at "silent".
test.skipIf(process.getuid?.() === 0)("the retention worker logs at this thread's level", async () => {
  const env = freshStoresEnv("md-retention-log-");
  const thread = env.agentStore.createManagerThread("Release");
  const dir = path.join(resourceDir({ kind: "global" }, "tool-output", env.dir), segment(thread.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "out.txt"), "x");
  // Listed but not searchable: each file's stat fails with EACCES.
  fs.chmodSync(dir, 0o644);
  try {
    const run = async (level: string) => {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "helpers", "retention-log-probe.ts"), env.store.db.filename, env.dir, level], { stdout: "pipe", stderr: "pipe" });
      const limit = setTimeout(() => child.kill(), 15_000);
      try {
        const [stderr, status] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        return { status, said: stderr.includes("[mandate] tool-output retention:") };
      } finally {
        clearTimeout(limit);
      }
    };
    expect(await run("error")).toEqual({ status: 0, said: true });
    expect(await run("silent")).toEqual({ status: 0, said: false });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
}, 30_000);
