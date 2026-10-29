import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import { freshStoresEnv, seedFeature, seedProject, withTempDataDir } from "./helpers/fixtures.js";
import { toolOutputDir } from "../src/server/platform/fs/resources.js";
import { FeatureRecordStore } from "../src/server/modules/plans/record-store.js";

// Deleting an archived thread for good: the thread, its workers' threads and
// features, their canvases and everything kept per thread go; usage numbers,
// memories and the global agent's records stay; nothing of another thread moves.

function setup(prefix: string) {
  const env = freshStoresEnv(prefix);
  const db = env.store.db;
  const agent = env.agentStore;
  const canvases = new CanvasStore(db, env.dir);
  const plans = new PlanStore(db);
  const records = new FeatureRecordStore(db);
  const events: Array<{ event: string; data: unknown }> = [];
  const busy = new Set<string>();
  const deletion = new ThreadDeletion({ db, agentStore: agent, canvases, isBusy: (threadId) => busy.has(threadId), sse: { emit: (event, data) => { events.push({ event, data }); } } });
  const projectId = seedProject(env.projects, { name: "project-1" });
  const say = (threadId: string, text: string) => agent.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text } }).id;
  const now = new Date().toISOString();
  const tasks = new BackgroundTaskStore(db);
  /** A subagent of a thread as the service leaves one: its hidden thread,
   *  made for the task's id, with its brief, a finished turn and that turn's
   *  model call; and its task naming that thread. */
  const seedChild = (parentThreadId: string, title: string) => {
    const taskId = newId("task");
    const child = agent.createSubagentThread(taskId).id;
    const task = tasks.create({ id: taskId, parentThreadId, childThreadId: child, type: "general", title, task: `${title}: find it in the notes` });
    say(child, `${title}: the brief`);
    const wake = agent.createWake({ threadId: child, reason: "subagent-task", triggerMessageId: null });
    agent.finishWake(wake.id, "finished");
    const call = env.store.startLlmCall({ purpose: "subagent_step", scopeType: "agent_thread", scopeId: child, provider: "openai", model: "gpt-5.5", requestJson: { input: `${title} secret words` } });
    env.store.finishLlmCall(call.id, { status: "succeeded", responseJson: { text: "reply" }, outputJson: { text: "reply" }, inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    return { taskId: task.id, child };
  };

  /** A thread with one worker and everything a thread can leave behind. */
  const seedThread = (title: string) => {
    const thread = agent.createManagerThread(title).id;
    const messageId = say(thread, `${title}: fix the cache expiry`);
    const featureId = seedFeature(env.features, projectId, { name: `${title}-worker`, tmuxWindowName: `w-${thread}`, ownerThreadId: thread });
    const worker = agent.getOrCreateThread("worker", featureId).id;
    say(worker, "Read the TTL per request.");
    plans.update(featureId, { goal: "Read the TTL per request" });
    records.write({ featureId, projectId, content: "Read the TTL per request: done", sourceThreadId: worker, metadata: null });
    const recordRowid = (db.prepare("select rowid as r from feature_records where feature_id = ?").get(featureId) as { r: number }).r;
    db.prepare("insert into pane_metadata (pane_id, feature_id, session_name, window_name, name, description, created_by_thread_id, created_at, updated_at) values (?, ?, 's', 'w', 'n', 'd', ?, ?, ?)").run(`%${featureId}`, featureId, worker, now, now);
    const wake = agent.createWake({ threadId: thread, reason: "user", triggerMessageId: messageId });
    agent.finishWake(wake.id, "finished");
    agent.enqueueMailboxMessage({ threadId: worker, role: "user", source: "feature-message", content: { type: "text", text: "note" }, triggerTurn: false });
    db.prepare("insert into agent_alarms (id, thread_id, fire_at, note, status, created_at) values (?, ?, ?, 'n', 'pending', ?)").run(`alm_${thread}`, thread, now, now);
    db.prepare("insert into agent_monitors (id, thread_id, command, cwd, every_ms, wake_when, note, timeout_ms, created_at, timeout_at, next_run_at) values (?, ?, 'true', '/tmp', 1000, 'changed', 'n', 60000, ?, ?, ?)").run(`mon_${worker}`, worker, now, now, now);
    db.prepare("insert into agent_monitor_runs (monitor_id, thread_id, at, exit_code, line) values (?, ?, ?, 0, 'ok')").run(`mon_${worker}`, worker, now);
    db.prepare("insert into agent_window_watches (id, thread_id, window_key, pane_id, stable_ms, note, created_at, timeout_at) values (?, ?, 'k', '%1', 1000, 'n', ?, ?)").run(`ww_${worker}`, worker, now, now);
    db.prepare("insert into manager_stop_checks (thread_id, reply_seq, outcome, judged_at) values (?, 2, 'decision', ?)").run(thread, now);
    db.prepare("insert into agent_history_audit (id, caller_thread_id, wake_id, tool_name, project_id, target_thread_id, time_preset, query_preview, result_count, chars_returned, created_at) values (?, ?, ?, 'chat_history_search', ?, ?, '90d', 'stale cache', 1, 10, ?)").run(`aud_${thread}`, thread, wake.id, projectId, worker, now);
    // Another manager searched this worker's history by its feature alone.
    db.prepare("insert into agent_history_audit (id, caller_thread_id, wake_id, tool_name, project_id, feature_id, time_preset, query_preview, result_count, chars_returned, created_at) values (?, ?, null, 'chat_history_search', ?, ?, '90d', 'ttl bug', 1, 10, ?)").run(`audf_${thread}`, agent.createManagerThread(`${title} reader`).id, projectId, featureId, now);
    const threadCanvas = canvases.create({ title: "Expiry report", scope: "manager", scopeId: thread, threadId: thread });
    const workerCanvas = canvases.create({ title: "Design", scope: "worker", scopeId: featureId, threadId: worker, kind: "design" });
    // A worker's memory extraction is recorded under the project scope with the feature's id.
    for (const [scopeType, scopeId] of [["agent_thread", thread], ["agent_thread", worker], ["feature", featureId], ["project", featureId]] as const) {
      const call = env.store.startLlmCall({ purpose: "agent_wake_step", scopeType, scopeId, provider: "openai", model: "gpt-5.5", requestJson: { input: `${title} secret words` } });
      env.store.finishLlmCall(call.id, { status: "succeeded", responseJson: { text: "reply" }, outputJson: { text: "reply" }, inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    }
    db.prepare("insert into memory_entries (id, scope, project_id, type, source, user_quote, content, status, source_thread_id, created_at, updated_at) values (?, 'project', ?, 'preference', 'user', 'keep it short', 'Prefers short answers', 'available', ?, ?, ?)").run(`mem_${thread}`, projectId, thread, now, now);
    db.prepare("insert into global_handoffs (id, global_thread_id, kind, state, text, spoken, target_thread_id, created_at, updated_at) values (?, ?, 'thread', 'delivered', 't', 0, ?, ?, ?)").run(`hof_${thread}`, agent.getOrCreateGlobalThread().id, thread, now, now);
    return { thread, worker, featureId, recordRowid, canvases: [threadCanvas, workerCanvas] };
  };

  const count = (table: string, where: string, ...args: string[]) =>
    (db.prepare(`select count(*) as n from ${table} where ${where}`).get(...args) as { n: number }).n;
  /** Every row kept for a thread or feature set, by table. */
  const leftOf = (s: ReturnType<typeof seedThread>) => {
    const threads = [s.thread, s.worker];
    const q = threads.map(() => "?").join(",");
    return {
      agent_threads: count("agent_threads", `id in (${q})`, ...threads),
      agent_messages: count("agent_messages", `thread_id in (${q})`, ...threads),
      agent_wakes: count("agent_wakes", `thread_id in (${q})`, ...threads),
      agent_mailbox: count("agent_mailbox", `thread_id in (${q})`, ...threads),
      agent_alarms: count("agent_alarms", `thread_id in (${q})`, ...threads),
      agent_monitors: count("agent_monitors", `thread_id in (${q})`, ...threads),
      agent_monitor_runs: count("agent_monitor_runs", `thread_id in (${q})`, ...threads),
      agent_window_watches: count("agent_window_watches", `thread_id in (${q})`, ...threads),
      manager_stop_checks: count("manager_stop_checks", `thread_id in (${q})`, ...threads),
      agent_history_audit: count("agent_history_audit", `caller_thread_id in (${q}) or target_thread_id in (${q}) or feature_id = ?`, ...threads, ...threads, s.featureId),
      agent_message_search_entries: count("agent_message_search_entries", `thread_id in (${q})`, ...threads),
      canvas_documents: count("canvas_documents", `id in (?, ?)`, s.canvases[0]!.id, s.canvases[1]!.id),
      features: count("features", "id = ?", s.featureId),
      feature_plans: count("feature_plans", "feature_id = ?", s.featureId),
      feature_records: count("feature_records", "feature_id = ?", s.featureId),
      feature_record_words: count("feature_record_words", "rowid = ?", String(s.recordRowid)),
      pane_metadata: count("pane_metadata", "feature_id = ?", s.featureId)
    };
  };
  const llmCalls = (s: ReturnType<typeof seedThread>) => db.prepare(
    "select scope_id, request_json, response_json, output_json, input_tokens, total_tokens, model from llm_calls where scope_id in (?, ?, ?) order by scope_id, scope_type"
  ).all(s.thread, s.worker, s.featureId) as Array<Record<string, unknown>>;
  return { env, db, agent, deletion, events, busy, seedThread, seedChild, leftOf, llmCalls, count, say };
}

const none = (left: Record<string, number>) => Object.fromEntries(Object.keys(left).map((k) => [k, 0]));

test("deleting an archived thread removes it, its workers and everything kept for them, and nothing of another thread", () => {
  const s = setup("md-del-one-");
  try {
    const gone = s.seedThread("project-1 cache expiry");
    const other = s.seedThread("project-1 docs layout");
    const open = s.seedThread("project-1 release notes");
    s.agent.archiveThread(gone.thread);
    s.agent.archiveThread(other.thread);
    const otherBefore = s.leftOf(other);
    const openBefore = s.leftOf(open);
    expect(Object.values(otherBefore).every((n) => n > 0)).toBe(true);
    const files = gone.canvases.map((c) => c.filePath!);
    expect(files.every((f) => fs.existsSync(path.dirname(f)))).toBe(true);

    const result = s.deletion.delete(gone.thread);
    expect(result).toEqual({ ok: true, deleted: { threads: 2, workers: 1, canvases: 2 } });
    const left = s.leftOf(gone);
    expect(left).toEqual(none(left) as typeof left);
    expect(files.some((f) => fs.existsSync(path.dirname(f)))).toBe(false);
    // Another archived thread and an open one are as they were.
    expect(s.leftOf(other)).toEqual(otherBefore);
    expect(s.leftOf(open)).toEqual(openBefore);
    expect(s.events).toStrictEqual([{ event: SSE_EVENTS.managerThreadDeleted, data: { threadId: gone.thread } }]);
  } finally { s.env.cleanup(); }
});

test("a deleted thread's search entries take their words index rows with them", () => {
  const s = setup("md-del-words-");
  try {
    const gone = s.seedThread("project-1 数据库迁移");
    const kept = s.seedThread("project-1 docs layout");
    s.agent.archiveThread(gone.thread);
    const entriesOf = (threads: string[]) => (s.db.prepare(`select id from agent_message_search_entries where thread_id in (${threads.map(() => "?").join(",")})`)
      .all(...threads) as Array<{ id: string }>).map((r) => r.id);
    const ids = entriesOf([gone.thread, gone.worker]);
    const keptIds = entriesOf([kept.thread, kept.worker]);
    expect(ids.length).toBeGreaterThan(0);
    const rowidsOf = (entryIds: string[]) => (s.db.prepare(`select word_rowid from agent_message_search_word_keys where entry_id in (${entryIds.map(() => "?").join(",")})`)
      .all(...entryIds) as Array<{ word_rowid: number }>).map((r) => String(r.word_rowid));
    const goneRowids = rowidsOf(ids);
    const keptRowids = rowidsOf(keptIds);
    const wordsAt = (rowids: string[]) => s.count("agent_message_search_words", `rowid in (${rowids.map(() => "?").join(",")})`, ...rowids);
    expect([goneRowids.length, wordsAt(goneRowids)]).toEqual([ids.length, ids.length]);
    expect(s.deletion.delete(gone.thread)).toMatchObject({ ok: true });
    expect([rowidsOf(ids).length, wordsAt(goneRowids)]).toEqual([0, 0]);
    expect([rowidsOf(keptIds).length, wordsAt(keptRowids)]).toEqual([keptIds.length, keptIds.length]);
  } finally { s.env.cleanup(); }
});

test("usage numbers stay and the words go; memories and the global agent's records stay", () => {
  const s = setup("md-del-kept-");
  try {
    const gone = s.seedThread("project-1 cache expiry");
    s.agent.archiveThread(gone.thread);
    s.deletion.delete(gone.thread);
    const calls = s.llmCalls(gone);
    expect(calls.length).toBe(4);
    for (const call of calls) {
      expect([call.request_json, call.response_json, call.output_json]).toEqual([null, null, null]);
      expect([call.input_tokens, call.total_tokens, call.model]).toEqual([120, 150, "gpt-5.5"]);
    }
    expect(s.count("memory_entries", "source_thread_id = ?", gone.thread)).toBe(1);
    expect(s.count("global_handoffs", "target_thread_id = ?", gone.thread)).toBe(1);
  } finally { s.env.cleanup(); }
});

test("an open thread is refused until it is archived, and a missing one is not found; nothing moves", () => {
  const s = setup("md-del-refused-");
  try {
    const open = s.seedThread("project-1 release notes");
    const before = s.leftOf(open);
    expect(s.deletion.delete(open.thread)).toEqual({ ok: false, status: 409, error: "Archive the thread first." });
    expect(s.deletion.delete("thr_missing")).toEqual({ ok: false, status: 404, error: "thread not found" });
    // A worker's own thread, or the global agent's, is not a manager thread.
    expect(s.deletion.delete(open.worker)).toEqual({ ok: false, status: 404, error: "thread not found" });
    expect(s.leftOf(open)).toEqual(before);
    expect(s.events).toStrictEqual([]);
  } finally { s.env.cleanup(); }
});

test("the archived threads are listed newest archived first, with their workers and canvases counted", () => {
  const s = setup("md-del-list-");
  try {
    const first = s.seedThread("project-1 cache expiry");
    const second = s.seedThread("project-2 flaky upload");
    s.seedThread("project-1 release notes");
    s.agent.archiveThread(first.thread);
    s.db.prepare("update agent_threads set archived_at = '2026-10-11T08:00:00.000Z' where id = ?").run(first.thread);
    s.agent.archiveThread(second.thread);
    expect(s.deletion.archivedThreads().map((t) => [t.id, t.title, t.workers, t.canvases])).toEqual([
      [second.thread, "project-2 flaky upload", 1, 2],
      [first.thread, "project-1 cache expiry", 1, 2]
    ]);
    expect(s.deletion.archivedThreads()[1]!.archivedAt).toBe("2026-10-11T08:00:00.000Z");
  } finally { s.env.cleanup(); }
});

test("delete all removes every archived thread and leaves the open ones", () => {
  const s = setup("md-del-all-");
  try {
    const a = s.seedThread("project-1 cache expiry");
    const b = s.seedThread("project-2 flaky upload");
    const open = s.seedThread("project-1 release notes");
    s.agent.archiveThread(a.thread);
    s.agent.archiveThread(b.thread);
    const openBefore = s.leftOf(open);
    expect(s.deletion.deleteAllArchived()).toEqual({ ok: true, count: 2, skipped: 0 });
    for (const gone of [a, b]) {
      const left = s.leftOf(gone);
      expect(left).toEqual(none(left) as typeof left);
    }
    expect(s.leftOf(open)).toEqual(openBefore);
    expect(s.deletion.archivedThreads()).toEqual([]);
    expect(s.events.map((e) => (e.data as { threadId: string }).threadId).sort()).toStrictEqual([a.thread, b.thread].sort());
  } finally { s.env.cleanup(); }
});

test("a thread whose work is still stopping is not deleted yet: a running turn, a model call in flight, or work the runtime holds", () => {
  const s = setup("md-del-busy-");
  try {
    const gone = s.seedThread("project-1 cache expiry");
    s.agent.archiveThread(gone.thread);
    const before = s.leftOf(gone);
    const refused = { ok: false, status: 409, error: "Its work is still stopping. Try again in a moment." } as const;
    // A worker's turn still running (archive asked it to stop; it has not yet).
    const wake = s.agent.createWake({ threadId: gone.worker, reason: "user", triggerMessageId: null });
    expect(s.deletion.delete(gone.thread)).toEqual(refused);
    s.agent.finishWake(wake.id, "canceled");
    // A model call not yet answered, whose answer would be written back.
    const call = s.env.store.startLlmCall({ purpose: "agent_compression", scopeType: "agent_thread", scopeId: gone.thread, provider: "openai", model: "gpt-5.5" });
    expect(s.deletion.delete(gone.thread)).toEqual(refused);
    s.env.store.finishLlmCall(call.id, { status: "succeeded" });
    // One made for its worker's task (a memory extraction is kept under the feature).
    const extraction = s.env.store.startLlmCall({ purpose: "memory_extraction", scopeType: "project", scopeId: gone.featureId, provider: "openai", model: "gpt-5.5" });
    expect(s.deletion.delete(gone.thread)).toEqual(refused);
    s.env.store.finishLlmCall(extraction.id, { status: "failed" });
    // Work the runtime holds for one of its threads (a memory extraction under way).
    s.busy.add(gone.worker);
    expect(s.deletion.delete(gone.thread)).toEqual(refused);
    expect(s.leftOf(gone)).toEqual({ ...before, agent_wakes: before.agent_wakes + 1 });
    s.busy.clear();
    expect(s.deletion.delete(gone.thread).ok).toBe(true);
  } finally { s.env.cleanup(); }
});

test("delete all leaves a thread whose work is still stopping, and says how many it left", () => {
  const s = setup("md-del-all-busy-");
  try {
    const a = s.seedThread("project-1 cache expiry");
    const b = s.seedThread("project-2 flaky upload");
    s.agent.archiveThread(a.thread);
    s.agent.archiveThread(b.thread);
    s.busy.add(b.thread);
    expect(s.deletion.deleteAllArchived()).toEqual({ ok: true, count: 1, skipped: 1 });
    expect(s.deletion.archivedThreads().map((t) => t.id)).toEqual([b.thread]);
  } finally { s.env.cleanup(); }
});

test("a thread's subagents go with it, and its workers' too: their threads, tasks and rows; their model calls keep their numbers and lose their words", () => {
  const s = setup("md-del-subagents-");
  try {
    const gone = s.seedThread("project-1 cache expiry");
    const children = [s.seedChild(gone.thread, "project-1 expiry survey"), s.seedChild(gone.worker, "project-1 ttl survey")];
    const other = s.seedThread("project-1 docs layout");
    const kept = s.seedChild(other.thread, "project-1 docs survey");
    s.agent.archiveThread(gone.thread);
    s.agent.archiveThread(other.thread);

    expect(s.deletion.delete(gone.thread)).toEqual({ ok: true, deleted: { threads: 4, workers: 1, canvases: 2 } });
    const ids = children.map((c) => c.child);
    const q = ids.map(() => "?").join(",");
    expect({
      threads: s.count("agent_threads", `id in (${q})`, ...ids),
      messages: s.count("agent_messages", `thread_id in (${q})`, ...ids),
      wakes: s.count("agent_wakes", `thread_id in (${q})`, ...ids),
      tasks: s.count("background_tasks", "id in (?, ?)", children[0]!.taskId, children[1]!.taskId)
    }).toEqual({ threads: 0, messages: 0, wakes: 0, tasks: 0 });
    const calls = s.db.prepare(`select request_json, response_json, output_json, total_tokens from llm_calls where scope_id in (${q})`).all(...ids);
    expect(calls).toStrictEqual([
      { request_json: null, response_json: null, output_json: null, total_tokens: 150 },
      { request_json: null, response_json: null, output_json: null, total_tokens: 150 }
    ]);
    // Another thread's subagent is as it was.
    expect([s.count("background_tasks", "id = ?", kept.taskId), s.count("agent_threads", "id = ?", kept.child)]).toEqual([1, 1]);
  } finally { s.env.cleanup(); }
});

test("a thread whose subagent is still stopping is not deleted yet: its turn, or work the runtime holds for it", () => {
  const s = setup("md-del-subagent-busy-");
  try {
    const gone = s.seedThread("project-1 cache expiry");
    const { child } = s.seedChild(gone.worker, "project-1 ttl survey");
    s.agent.archiveThread(gone.thread);
    const refused = { ok: false, status: 409, error: "Its work is still stopping. Try again in a moment." } as const;
    // Its turn, asked to stop by the archive, has not stopped yet.
    const wake = s.agent.createWake({ threadId: child, reason: "subagent-task", triggerMessageId: null });
    expect(s.deletion.delete(gone.thread)).toEqual(refused);
    s.agent.finishWake(wake.id, "canceled");
    s.busy.add(child);
    expect(s.deletion.delete(gone.thread)).toEqual(refused);
    s.busy.clear();
    expect(s.deletion.delete(gone.thread).ok).toBe(true);
  } finally { s.env.cleanup(); }
});

test("a thread's tool output goes with it: its own folder, its workers' under their project, its subagents'; another thread's stays", () => {
  const data = withTempDataDir();
  const s = setup("md-del-tool-output-");
  try {
    const gone = s.seedThread("project-1 cache expiry");
    const child = s.seedChild(gone.thread, "project-1 expiry survey");
    const other = s.seedThread("project-1 docs layout");
    const projectId = s.env.features.getById(s.env.agentStore.getThreadById(gone.worker)!.scopeId!)!.projectId;
    const write = (owner: { kind: "global" } | { kind: "project"; projectId: string }, threadId: string) => {
      const dir = toolOutputDir({ owner, threadId, dataDir: data.dataDir });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "task_x.log"), "output\n");
      return dir;
    };
    const dirs = [write({ kind: "global" }, gone.thread), write({ kind: "project", projectId }, gone.worker), write({ kind: "global" }, child.child)];
    const kept = write({ kind: "global" }, other.thread);
    s.agent.archiveThread(gone.thread);
    expect(s.deletion.delete(gone.thread).ok).toBe(true);
    expect(dirs.map((d) => fs.existsSync(d))).toEqual([false, false, false]);
    expect(fs.existsSync(kept)).toBe(true);
  } finally { s.env.cleanup(); data.restore(); }
});
