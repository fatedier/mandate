import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import * as fsModule from "node:fs";
import path from "node:path";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { ThreadDeletion } from "../src/server/modules/agent/thread-delete.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { newId } from "../src/server/platform/ids.js";
import { SSE_EVENTS } from "../src/shared/api/sse.js";
import { freshStoresEnv, seedWorker, seedProject, withTempDataDir } from "./helpers/fixtures.js";
import { threadNotesDir, threadResourcesDir, toolOutputDir } from "../src/server/platform/fs/resources.js";
import { WorkerRecordStore } from "../src/server/modules/plans/record-store.js";
import { Hono } from "hono";
import { ReplyTabStore, mountReplyTabRoutes } from "../src/server/modules/agent/reply-tabs.js";
import { ThreadTabStore } from "../src/server/modules/personal/thread-tabs.js";
import { API_PATHS } from "../src/shared/api/routes.js";
import { getJson } from "./helpers/test-app.js";

// Deleting an archived thread for good: the thread, its workers' threads and
// workers, their canvases and everything kept per thread go; usage numbers,
// memories and the personal agent's records stay; nothing of another thread moves.

function setup(prefix: string) {
  const env = freshStoresEnv(prefix);
  const db = env.store.db;
  const agent = env.agentStore;
  const canvases = new CanvasStore(db, env.dir);
  const plans = new PlanStore(db);
  const records = new WorkerRecordStore(db);
  const events: Array<{ event: string; data: unknown }> = [];
  const busy = new Set<string>();
  // Schedules still there when asked, gone when told.
  const deleting: Array<[string, number, number]> = [];
  const schedulesOf = (threadId: string) => (db.prepare("select count(*) as n from agent_schedules where thread_id = ?").get(threadId) as { n: number }).n;
  const deletion = new ThreadDeletion({
    db, agentStore: agent, canvases, isBusy: (threadId) => busy.has(threadId), sse: { emit: (event, data) => { events.push({ event, data }); } },
    onDelete: (threadId) => { const before = schedulesOf(threadId); return () => { deleting.push([threadId, before, schedulesOf(threadId)]); }; }
  });
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
    env.store.finishLlmCall(call.id, { status: "succeeded", responseJson: { text: "reply" }, outputJson: { text: "reply" }, inputTokens: 120, outputTokens: 30 });
    return { taskId: task.id, child };
  };

  /** A thread with one worker and everything a thread can leave behind. */
  const seedThread = (title: string) => {
    const thread = agent.createManagerThread(title).id;
    const messageId = say(thread, `${title}: fix the cache expiry`);
    const workerId = seedWorker(env.workers, projectId, { name: `${title}-worker`, tmuxWindowName: `w-${thread}`, ownerThreadId: thread });
    const worker = agent.getOrCreateThread("worker", workerId).id;
    say(worker, "Read the TTL per request.");
    plans.update(workerId, { goal: "Read the TTL per request" });
    records.write({ workerId, projectId, content: "Read the TTL per request: done"});
    const recordRowid = (db.prepare("select rowid as r from worker_records where worker_id = ?").get(workerId) as { r: number }).r;
    db.prepare("insert into pane_metadata (pane_id, worker_id, session_name, window_name, name, description, created_at, updated_at) values (?, ?, 's', 'w', 'n', 'd', ?, ?)").run(`%${workerId}`, workerId, now, now);
    const wake = agent.createWake({ threadId: thread, reason: "user", triggerMessageId: messageId });
    agent.finishWake(wake.id, "finished");
    agent.enqueueMailboxMessage({ threadId: worker, role: "user", source: "worker-message", content: { type: "text", text: "note" }, triggerTurn: false });
    db.prepare("insert into agent_alarms (id, thread_id, fire_at, note, status, created_at) values (?, ?, ?, 'n', 'pending', ?)").run(`alm_${thread}`, thread, now, now);
    db.prepare("insert into agent_monitors (id, thread_id, command, cwd, every_ms, wake_when, note, timeout_ms, created_at, timeout_at, next_run_at) values (?, ?, 'true', '/tmp', 1000, 'changed', 'n', 60000, ?, ?, ?)").run(`mon_${worker}`, worker, now, now, now);
    db.prepare("insert into agent_monitor_runs (monitor_id, thread_id, at, exit_code, line) values (?, ?, ?, 0, 'ok')").run(`mon_${worker}`, worker, now);
    db.prepare("insert into agent_pane_monitors (id, thread_id, window_key, pane_id, note, created_at, timeout_at) values (?, ?, 'k', '%1', 'n', ?, ?)").run(`mon_pane_${worker}`, worker, now, now);
    db.prepare("insert into manager_stop_checks (thread_id, reply_seq, outcome, judged_at) values (?, 2, 'decision', ?)").run(thread, now);
    // A duty thread's schedule, its runs, its own row and a report mark.
    db.prepare("insert into agent_schedules (id, thread_id, name, cron, timezone, check_script, check_timeout_ms, brief, status, created_at, updated_at) values (?, ?, 'n', '0 9 * * *', 'UTC', 'c', 60000, 'b', 'active', ?, ?)").run(`sch_${thread}`, thread, now, now);
    db.prepare("insert into agent_schedule_runs (schedule_id, thread_id, due_at, started_at, finished_at, outcome) values (?, ?, ?, ?, ?, 'quiet')").run(`sch_${thread}`, thread, now, now, now);
    db.prepare("insert into agent_duty_threads (thread_id, level, notes_dir, created_at) values (?, 'investigate', '/tmp/notes', ?)").run(thread, now);
    db.prepare("insert into agent_duty_reports (message_id, thread_id, outcome, at) values (?, ?, 'sent', ?)").run(`msg_dr_${thread}`, thread, now);
    db.prepare("insert into agent_duty_sidebar (thread_id, added_at) values (?, ?)").run(thread, now);
    db.prepare("insert into agent_message_deletions (message_id, thread_id, deleted_at) values (?, ?, ?)").run(`msg_gone_${thread}`, thread, now);
    db.prepare("insert into agent_message_seq_floors (thread_id, seq) values (?, 9)").run(thread);
    const threadCanvas = canvases.create({ title: "Expiry report", scope: "manager", scopeId: thread, threadId: thread });
    const workerCanvas = canvases.create({ title: "Design", scope: "worker", scopeId: workerId, threadId: worker, kind: "design" });
    // A worker's memory extraction is recorded under the project scope with the worker's id.
    for (const [scopeType, scopeId] of [["agent_thread", thread], ["agent_thread", worker], ["worker", workerId], ["project", workerId]] as const) {
      const call = env.store.startLlmCall({ purpose: "agent_wake_step", scopeType, scopeId, provider: "openai", model: "gpt-5.5", requestJson: { input: `${title} secret words` } });
      env.store.finishLlmCall(call.id, { status: "succeeded", responseJson: { text: "reply" }, outputJson: { text: "reply" }, inputTokens: 120, outputTokens: 30 });
    }
    db.prepare("insert into memory_entries (id, scope, project_id, type, source, user_quote, content, status, source_thread_id, created_at, updated_at) values (?, 'project', ?, 'preference', 'user', 'keep it short', 'Prefers short answers', 'available', ?, ?, ?)").run(`mem_${thread}`, projectId, thread, now, now);
    db.prepare("insert into personal_handoffs (id, personal_thread_id, kind, state, text, spoken, target_thread_id, created_at, updated_at) values (?, ?, 'thread', 'delivered', 't', 0, ?, ?, ?)").run(`hof_${thread}`, agent.getOrCreatePersonalThread().id, thread, now, now);
    return { thread, worker, workerId, recordRowid, canvases: [threadCanvas, workerCanvas] };
  };

  const count = (table: string, where: string, ...args: string[]) =>
    (db.prepare(`select count(*) as n from ${table} where ${where}`).get(...args) as { n: number }).n;
  /** Every row kept for a thread or worker set, by table. */
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
      agent_pane_monitors: count("agent_pane_monitors", `thread_id in (${q})`, ...threads),
      manager_stop_checks: count("manager_stop_checks", `thread_id in (${q})`, ...threads),
      agent_schedules: count("agent_schedules", `thread_id in (${q})`, ...threads),
      agent_schedule_runs: count("agent_schedule_runs", `thread_id in (${q})`, ...threads),
      agent_duty_threads: count("agent_duty_threads", `thread_id in (${q})`, ...threads),
      agent_duty_reports: count("agent_duty_reports", `thread_id in (${q})`, ...threads),
      agent_duty_sidebar: count("agent_duty_sidebar", `thread_id in (${q})`, ...threads),
      agent_message_deletions: count("agent_message_deletions", `thread_id in (${q})`, ...threads),
      agent_message_seq_floors: count("agent_message_seq_floors", `thread_id in (${q})`, ...threads),
      agent_message_search_entries: count("agent_message_search_entries", `thread_id in (${q})`, ...threads),
      canvas_documents: count("canvas_documents", `id in (?, ?)`, s.canvases[0]!.id, s.canvases[1]!.id),
      workers: count("workers", "id = ?", s.workerId),
      worker_plans: count("worker_plans", "worker_id = ?", s.workerId),
      worker_records: count("worker_records", "worker_id = ?", s.workerId),
      worker_record_words: count("worker_record_words", "rowid = ?", String(s.recordRowid)),
      pane_metadata: count("pane_metadata", "worker_id = ?", s.workerId)
    };
  };
  const llmCalls = (s: ReturnType<typeof seedThread>) => db.prepare(
    "select scope_id, request_json, response_json, output_json, input_tokens, output_tokens, model from llm_calls where scope_id in (?, ?, ?) order by scope_id, scope_type"
  ).all(s.thread, s.worker, s.workerId) as Array<Record<string, unknown>>;
  return { env, db, agent, deletion, events, busy, seedThread, seedChild, leftOf, llmCalls, count, say, deleting };
}

const none = (left: Record<string, number>) => Object.fromEntries(Object.keys(left).map((k) => [k, 0]));

test("deleting an archived thread removes it, its workers and everything kept for them, and nothing of another thread", () => {
  const s = setup("md-del-one-");
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
  // Each canvas gone is told of, as a canvas deleted on its own is (a tag or
  // a title naming it elsewhere turns back into words), then the thread.
  const byCanvas = (a: { data: unknown }, b: { data: unknown }) => String((a.data as { canvasId: string }).canvasId).localeCompare(String((b.data as { canvasId: string }).canvasId));
  expect(s.events.slice(0, -1).sort(byCanvas)).toStrictEqual([
    { event: SSE_EVENTS.canvasUpdated, data: { canvasId: gone.canvases[0]!.id, workerId: null } },
    { event: SSE_EVENTS.canvasUpdated, data: { canvasId: gone.canvases[1]!.id, workerId: gone.workerId } }
  ].sort(byCanvas));
  expect(s.events.at(-1)).toStrictEqual({ event: SSE_EVENTS.managerThreadDeleted, data: { threadId: gone.thread } });
  // Asked before its rows went (a schedule was there), told after (none is).
  expect(s.deleting).toEqual([[gone.thread, 1, 0]]);
});

test("thread delete removes its reply tabs; an archived thread still lists them", async () => {
  const s = setup("md-del-reply-tabs-");
  const gone = s.seedThread("project-1 release");
  const kept = s.seedThread("project-1 docs layout");
  const tabs = new ReplyTabStore(s.db);
  const app = new Hono();
  mountReplyTabRoutes(app, { store: tabs, agentStore: s.agent, sse: { emit: () => {} } });
  for (const thread of [gone.thread, kept.thread]) {
    const reply = s.agent.appendMessage({ threadId: thread, role: "assistant", source: "self", wakeId: "wake_1", content: { type: "assistant", text: "Ready for review." } });
    tabs.add({ threadId: thread, messageId: reply.id, text: "Ready for review.", repliedAt: reply.createdAt });
  }
  s.agent.archiveThread(gone.thread);
  expect((await getJson(app, API_PATHS.agentThreadReplyTabs(gone.thread))).body.tabs).toHaveLength(1);
  expect(s.deletion.delete(gone.thread)).toMatchObject({ ok: true });
  expect(s.count("agent_reply_tabs", "thread_id = ?", gone.thread)).toBe(0);
  expect(s.count("agent_reply_tabs", "thread_id = ?", kept.thread)).toBe(1);
});

test("thread delete closes its tab beside the personal agent; another thread's stays", () => {
  const s = setup("md-del-thread-tabs-");
  const gone = s.seedThread("project-1 release");
  const kept = s.seedThread("project-1 docs layout");
  const tabs = new ThreadTabStore(s.db);
  tabs.add(gone.thread);
  tabs.add(kept.thread);
  s.agent.archiveThread(gone.thread);
  expect(s.deletion.delete(gone.thread)).toMatchObject({ ok: true });
  expect(tabs.list().map((tab) => tab.threadId)).toEqual([kept.thread]);
});

test("a deleted thread's search entries take their words index rows with them", () => {
  const s = setup("md-del-words-");
  const gone = s.seedThread("project-1 photo import");
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
});

test("usage numbers stay and the words go; memories and the personal agent's records stay", () => {
  const s = setup("md-del-kept-");
  const gone = s.seedThread("project-1 cache expiry");
  s.agent.archiveThread(gone.thread);
  s.deletion.delete(gone.thread);
  const calls = s.llmCalls(gone);
  expect(calls.length).toBe(4);
  for (const call of calls) {
    expect([call.request_json, call.response_json, call.output_json]).toEqual([null, null, null]);
    expect([call.input_tokens, call.output_tokens, call.model]).toEqual([120, 30, "gpt-5.5"]);
  }
  expect(s.count("memory_entries", "source_thread_id = ?", gone.thread)).toBe(1);
  expect(s.count("personal_handoffs", "target_thread_id = ?", gone.thread)).toBe(1);
});

test("an open thread is refused until it is archived, and a missing one is not found; nothing moves", () => {
  const s = setup("md-del-refused-");
  const open = s.seedThread("project-1 release notes");
  const before = s.leftOf(open);
  expect(s.deletion.delete(open.thread)).toEqual({ ok: false, status: 409, error: "Archive the thread first." });
  expect(s.deletion.delete("thr_missing")).toEqual({ ok: false, status: 404, error: "thread not found" });
  // A worker's own thread, or the personal agent's, is not a manager thread.
  expect(s.deletion.delete(open.worker)).toEqual({ ok: false, status: 404, error: "thread not found" });
  expect(s.leftOf(open)).toEqual(before);
  expect(s.events).toStrictEqual([]);
});

test("the archived threads are listed newest archived first, with their workers and canvases counted", () => {
  const s = setup("md-del-list-");
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
});

test("an archived thread says when it was last active, not when it was archived: its last message, else when it began", () => {
  const s = setup("md-del-activity-");
  const talked = s.seedThread("project-1 cache expiry");
  s.agent.appendMessage({ threadId: talked.thread, role: "user", source: "user", content: { type: "text", text: "Look at the cache." } });
  s.db.prepare("update agent_messages set created_at = '2026-10-09T08:00:00.000Z' where thread_id = ?").run(talked.thread);
  const quiet = s.agent.createManagerThread("project-2 never started").id;
  s.db.prepare("update agent_threads set created_at = '2026-10-08T08:00:00.000Z' where id = ?").run(quiet);
  for (const id of [talked.thread, quiet]) s.agent.archiveThread(id);
  const at = new Map(s.deletion.archivedThreads().map((t) => [t.id, t.lastActivityAt]));
  expect([at.get(talked.thread), at.get(quiet)]).toEqual(["2026-10-09T08:00:00.000Z", "2026-10-08T08:00:00.000Z"]);
});

test("delete all removes every archived thread and leaves the open ones", () => {
  const s = setup("md-del-all-");
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
  expect(s.events.filter((e) => e.event === SSE_EVENTS.managerThreadDeleted).map((e) => (e.data as { threadId: string }).threadId).sort()).toStrictEqual([a.thread, b.thread].sort());
});

test("a thread whose work is still stopping is not deleted yet: a running turn, a model call in flight, or work the runtime holds", () => {
  const s = setup("md-del-busy-");
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
  // One made for its worker's task (a memory extraction is kept under the worker).
  const extraction = s.env.store.startLlmCall({ purpose: "memory_extraction", scopeType: "project", scopeId: gone.workerId, provider: "openai", model: "gpt-5.5" });
  expect(s.deletion.delete(gone.thread)).toEqual(refused);
  s.env.store.finishLlmCall(extraction.id, { status: "failed" });
  // Work the runtime holds for one of its threads (a memory extraction under way).
  s.busy.add(gone.worker);
  expect(s.deletion.delete(gone.thread)).toEqual(refused);
  expect(s.leftOf(gone)).toEqual({ ...before, agent_wakes: before.agent_wakes + 1 });
  s.busy.clear();
  expect(s.deletion.delete(gone.thread).ok).toBe(true);
});

test("delete all leaves a thread whose work is still stopping, and says how many it left", () => {
  const s = setup("md-del-all-busy-");
  const a = s.seedThread("project-1 cache expiry");
  const b = s.seedThread("project-2 flaky upload");
  s.agent.archiveThread(a.thread);
  s.agent.archiveThread(b.thread);
  s.busy.add(b.thread);
  expect(s.deletion.deleteAllArchived()).toEqual({ ok: true, count: 1, skipped: 1 });
  expect(s.deletion.archivedThreads().map((t) => t.id)).toEqual([b.thread]);
});

test("a thread's subagents go with it, and its workers' too: their threads, tasks and rows; their model calls keep their numbers and lose their words", () => {
  const s = setup("md-del-subagents-");
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
  const calls = s.db.prepare(`select request_json, response_json, output_json, output_tokens from llm_calls where scope_id in (${q})`).all(...ids);
  expect(calls).toStrictEqual([
    { request_json: null, response_json: null, output_json: null, output_tokens: 30 },
    { request_json: null, response_json: null, output_json: null, output_tokens: 30 }
  ]);
  // Another thread's subagent is as it was.
  expect([s.count("background_tasks", "id = ?", kept.taskId), s.count("agent_threads", "id = ?", kept.child)]).toEqual([1, 1]);
});

test("a thread whose subagent is still stopping is not deleted yet: its turn, or work the runtime holds for it", () => {
  const s = setup("md-del-subagent-busy-");
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
});

test("a thread's tool output goes with it: its own folder, its workers' under their project, its subagents'; another thread's stays", () => {
  const data = withTempDataDir();
  const s = setup("md-del-tool-output-");
  try {
    const gone = s.seedThread("project-1 cache expiry");
    const child = s.seedChild(gone.thread, "project-1 expiry survey");
    const other = s.seedThread("project-1 docs layout");
    const projectId = s.env.workers.getById(s.env.agentStore.getThreadById(gone.worker)!.scopeId!)!.projectId;
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
  } finally { data.restore(); }
});

// A folder that cannot go (a permission, a file held open) does not stop the
// delete: the thread and its rows go, the folder stays for the retention
// pass, and the log says which one.
test("a notes folder that cannot be removed: the thread is still deleted, and the log names the folder", () => {
  const data = withTempDataDir();
  const s = setup("md-del-notes-stuck-");
  const stuck = (dir: string) => dir.includes(path.join("resources", "threads"));
  const realRm = fs.rmSync;
  // The module's own export: thread-delete imports node:fs as a namespace.
  const rm = spyOn(fsModule, "rmSync").mockImplementation(((dir: fs.PathLike, options?: fs.RmOptions) => {
    if (stuck(String(dir))) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    return realRm(dir, options);
  }) as typeof fs.rmSync);
  const said = spyOn(console, "error").mockImplementation(() => {});
  try {
    const gone = s.seedThread("project-1 cache expiry").thread;
    fs.mkdirSync(threadNotesDir(gone), { recursive: true });
    fs.writeFileSync(path.join(threadNotesDir(gone), "index.md"), "- cache expiry: waits on the user\n");
    s.agent.archiveThread(gone);
    expect(s.deletion.delete(gone).ok).toBe(true);
    expect(s.env.agentStore.getThreadById(gone)).toBe(null);
    expect(fs.existsSync(path.join(threadNotesDir(gone), "index.md"))).toBe(true);
    expect(said.mock.calls.map((call) => call.map(String).join(" ")).some((line) => line.includes(threadResourcesDir(gone)))).toBe(true);
  } finally {
    rm.mockRestore();
    said.mockRestore();
    data.restore();
  }
});

test("a thread's notes go with it; an archived thread's that is not deleted stay", () => {
  const data = withTempDataDir();
  const s = setup("md-del-notes-");
  try {
    const gone = s.seedThread("project-1 cache expiry").thread;
    const kept = s.seedThread("project-1 docs layout").thread;
    const write = (dir: string) => {
      fs.mkdirSync(path.join(dir, "matters"), { recursive: true });
      fs.writeFileSync(path.join(dir, "index.md"), "- cache expiry: waits on the user\n");
      fs.writeFileSync(path.join(dir, "matters", "expiry.md"), "what was seen\n");
    };
    for (const id of [gone, kept]) write(threadNotesDir(id));
    s.agent.archiveThread(gone);
    s.agent.archiveThread(kept);
    expect(s.deletion.delete(gone).ok).toBe(true);
    expect(fs.existsSync(threadResourcesDir(gone))).toBe(false);
    expect(fs.existsSync(path.join(threadNotesDir(kept), "index.md"))).toBe(true);
  } finally { data.restore(); }
});
