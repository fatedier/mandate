import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { sweepToolOutputs, toolOutputDirsOfThread } from "../src/server/platform/db/tool-output-retention.js";
import { toolOutputDir } from "../src/server/platform/fs/resources.js";
import { onCleanup } from "./helpers/cleanup.js";
import { freshStoresEnv, withTempDataDir } from "./helpers/fixtures.js";

// Tool output files (spooled large results, background commands' output):
// gone after a quiet week, a month at most, and with their thread.

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-19T12:00:00.000Z");

function scene() {
  const env = freshStoresEnv("md-tool-output-retention-");
  const data = withTempDataDir();
  onCleanup(() => { data.restore(); env.cleanup(); });
  /** A file in a thread's folder, last written `daysAgo` days ago. */
  const file = (threadId: string, name: string, daysAgo: number, owner: { kind: "global" } | { kind: "project"; projectId: string } = { kind: "global" }) => {
    const dir = toolOutputDir({ owner, threadId, dataDir: data.dataDir });
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, name);
    fs.writeFileSync(f, "output\n");
    const at = new Date(NOW.getTime() - daysAgo * DAY);
    fs.utimesSync(f, at, at);
    return f;
  };
  /** A thread whose last message was `daysAgo` days ago. */
  const thread = (daysAgo: number, id?: string) => {
    const t = env.agentStore.createManagerThread("t");
    const threadId = id ?? t.id;
    if (id) env.store.db.prepare("update agent_threads set id = ? where id = ?").run(id, t.id);
    const m = env.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text: "hi" } });
    const at = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
    env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(at, m.id);
    env.store.db.prepare("update agent_threads set updated_at = ? where id = ?").run(at, threadId);
    return threadId;
  };
  return { env, data, file, thread };
}

test("a thread quiet for 7 days loses its tool outputs; a file older than 30 days goes even in an active thread; a running command's file stays; a folder whose thread is gone goes", () => {
  const s = scene();
  const quiet = s.thread(8);
  const active = s.thread(0);
  const quietFile = s.file(quiet, "a.txt", 8);
  const oldActive = s.file(active, "old.txt", 31);
  const youngActive = s.file(active, "young.txt", 29);
  const running = s.file(active, "task_run.log", 40);
  const projectFile = s.file(quiet, "p.txt", 1, { kind: "project", projectId: "proj_1" });
  const orphan = s.file("thr_gone", "x.txt", 0);
  expect(sweepToolOutputs({ db: s.env.store.db, dataDir: s.data.dataDir, now: NOW, runningPaths: [running] })).toEqual({ deleted: 4 });
  expect([quietFile, oldActive, youngActive, running, projectFile, orphan].map((f) => fs.existsSync(f))).toEqual([false, false, true, true, false, false]);
  // An emptied folder goes with its files.
  expect(fs.existsSync(path.dirname(quietFile))).toBe(false);
  expect(fs.existsSync(path.dirname(orphan))).toBe(false);
});

test("a thread whose id ends in an underscore is found by its folder: its fresh files stay", () => {
  const s = scene();
  const id = s.thread(0, "thr_endsWith_");
  const f = s.file(id, "fresh.txt", 0);
  expect(path.basename(path.dirname(f))).toBe("thr_endsWith");
  expect(sweepToolOutputs({ db: s.env.store.db, dataDir: s.data.dataDir, now: NOW, runningPaths: [] })).toEqual({ deleted: 0 });
  expect(fs.existsSync(f)).toBe(true);
});

test("a thread's tool-output folders under every owner are what its deletion removes", () => {
  const s = scene();
  const a = s.file("thr_x_", "g.txt", 0);
  const b = s.file("thr_x_", "p.txt", 0, { kind: "project", projectId: "proj_2" });
  expect(toolOutputDirsOfThread("thr_x_", s.data.dataDir).sort()).toEqual([path.dirname(a), path.dirname(b)].sort());
});

test("a thread's activity is its newest message: a fresh message keeps its files though its row was last touched long ago", () => {
  const s = scene();
  const id = s.thread(0);
  s.env.store.db.prepare("update agent_threads set updated_at = ? where id = ?").run(new Date(NOW.getTime() - 20 * DAY).toISOString(), id);
  const f = s.file(id, "fresh.txt", 1);
  expect(sweepToolOutputs({ db: s.env.store.db, dataDir: s.data.dataDir, now: NOW, runningPaths: [] })).toEqual({ deleted: 0 });
  expect(fs.existsSync(f)).toBe(true);
});

// An idle compaction's summary (written ~55 min after the last message)
// restarts no quiet week; a compaction by hand still does.
test("an idle compaction's summary is not activity: the quiet week counts from the message before it", () => {
  const s = scene();
  const summaryAt = (threadId: string, trigger: "idle" | undefined) => {
    const m = s.env.agentStore.appendMessage({
      threadId, role: "user", source: "compression",
      content: { type: "summary", summary: "The release notes are drafted.", replacedRange: [1, 1], replacedCount: 1, retained: [], ...(trigger ? { trigger, idleMinutes: 55 } : {}) }
    });
    s.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(NOW.getTime() - 7 * DAY + 25 * 60_000).toISOString(), m.id);
  };
  const idle = s.thread(7 + 30 / (24 * 60));
  const byHand = s.thread(7 + 30 / (24 * 60));
  summaryAt(idle, "idle");
  summaryAt(byHand, undefined);
  const idleFile = s.file(idle, "a.txt", 8);
  const byHandFile = s.file(byHand, "b.txt", 8);
  expect(sweepToolOutputs({ db: s.env.store.db, dataDir: s.data.dataDir, now: NOW, runningPaths: [] })).toEqual({ deleted: 1 });
  expect([fs.existsSync(idleFile), fs.existsSync(byHandFile)]).toEqual([false, true]);
});
