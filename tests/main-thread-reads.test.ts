import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { HandoffStore } from "../src/server/modules/personal/handoff-store.js";
import { BackgroundTaskStore } from "../src/server/modules/agent/background-task-store.js";
import { CanvasStore } from "../src/server/modules/canvas/canvas-store.js";
import { AgentAlarmManager } from "../src/server/modules/agent/agent-alarm-manager.js";
import { AgentHistoryStore } from "../src/server/modules/agent/history-store.js";
import { initializeAgentSchema } from "../src/server/modules/agent/schema.js";
import { threadNoticeMetadata } from "../src/shared/thread-notice.js";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { historyEnv } from "./helpers/history-env.js";
import { plansOf, preparedBy } from "./helpers/sql-watch.js";
import { stub } from "./helpers/typed.js";
import type { AgentSseEmitter } from "../src/server/modules/sse/sse-events.js";

// Every read here runs on the server's one thread, and the tables they read
// only grow: a few rows are wanted, and an index of their own finds them
// without reading every row: a walk of a large table holds the server's
// thread for as long as it takes.

test("the notice that told the personal agent of a question is found by the question's id, not by reading the personal agent's thread", () => {
  const env = freshStoresEnv("md-reads-notice-");
  const personal = env.agentStore.getOrCreatePersonalThread();
  const target = env.agentStore.createManagerThread("Release");
  for (let i = 0; i < 5; i++) env.agentStore.appendMessage({ threadId: personal.id, role: "assistant", source: "self", content: { type: "assistant", text: `step ${i}`, toolCalls: [] } as never });
  const notice = (id: string) => threadNoticeMetadata({ handoffIds: [], kind: "thread", targetThreadId: target.id, workerId: null, title: "Release", stop: "asked", reason: null, question: { id, text: "Ship it?", options: [] } });
  env.agentStore.appendMessage({ threadId: personal.id, role: "user", source: "thread-notice", content: { type: "text", text: "asked", metadata: notice("q_one") } });
  env.agentStore.appendMessage({ threadId: personal.id, role: "user", source: "thread-notice", content: { type: "text", text: "asked", metadata: notice("q_two") } });
  const store = new HandoffStore(env.store.db);
  let told: string[] = [];
  const plans = plansOf(env.store.db, /from agent_messages/, () => { told = store.toldOfQuestion(target.id, "q_two"); });
  expect(told).toEqual([personal.id]);
  expect(store.toldOfQuestion(target.id, "q_none")).toStrictEqual([]);
  expect(plans).toHaveLength(1);
  expect(plans[0]).toContain("idx_agent_messages_notice_question");
});

test("a thread notice whose content is not JSON neither stops the schema from opening nor its own write", () => {
  const env = freshStoresEnv("md-reads-notice-bad-");
  const personal = env.agentStore.getOrCreatePersonalThread();
  env.store.db.prepare("insert into agent_messages (id, thread_id, seq, role, source, content, created_at) values ('msg_bad', ?, 999, 'user', 'thread-notice', 'not json', '2026-11-02T00:00:00.000Z')").run(personal.id);
  expect(() => initializeAgentSchema(env.store.db)).not.toThrow();
  expect(new HandoffStore(env.store.db).toldOfQuestion("thr_x", "q_one")).toStrictEqual([]);
});

test("the open handoffs are found by their state", () => {
  const env = freshStoresEnv("md-reads-handoffs-");
  const plans = plansOf(env.store.db, /from personal_handoffs where state in/, () => new HandoffStore(env.store.db).listByState(["pending", "sent", "waiting"] as never));
  expect(plans).toHaveLength(1);
  expect(plans[0]).toContain("idx_personal_handoffs_state");
});

test("whether a thread runs, and which wakes run, are read from the running wakes alone", () => {
  const env = freshStoresEnv("md-reads-wakes-");
  const thread = env.agentStore.createManagerThread("Release");
  const running = plansOf(env.store.db, /status = 'running'/, () => env.agentStore.getRunningWakeForThread(thread.id));
  const all = plansOf(env.store.db, /w\.status = 'running'/, () => env.agentStore.listRunningWakesWithScope());
  expect(running[0]).toContain("idx_agent_wakes_running");
  expect(all[0]).toContain("idx_agent_wakes_running");
});

test("running and queued subagents are counted from their own indexes, not every task ever run", () => {
  const env = freshStoresEnv("md-reads-tasks-");
  const tasks = new BackgroundTaskStore(env.store.db);
  const plans = plansOf(env.store.db, /from background_tasks/, () => {
    tasks.countRunningSubagents("page");
    tasks.oldestQueued(null, "page");
    tasks.countRunning("thr_parent");
  });
  expect(plans).toHaveLength(3);
  expect(plans[0]).toContain("idx_background_tasks_running");
  expect(plans[1]).toContain("idx_background_tasks_queued");
  expect(plans[2]).toContain("idx_background_tasks_running");
});

test("the canvas list is read from an index holding its columns, never the pages' HTML", () => {
  const env = freshStoresEnv("md-reads-canvases-");
  const plans = plansOf(env.store.db, /from canvas_documents c/, () => new CanvasStore(env.store.db, env.dir).listAll(50));
  expect(plans).toHaveLength(1);
  expect(plans[0]).toContain("COVERING INDEX idx_canvas_documents_list");
});

test("a thread's pending alarms are found among its pending ones", () => {
  const env = freshStoresEnv("md-reads-alarms-");
  const thread = env.agentStore.createManagerThread("Release");
  const alarms = new AgentAlarmManager({ db: env.store.db, agentStore: env.agentStore, sse: stub<AgentSseEmitter>({ emit: () => {} }), onWake: () => null });
  const plans = plansOf(env.store.db, /status = 'pending' order by fire_at/, () => alarms.list(thread.id));
  expect(plans).toHaveLength(1);
  expect(plans[0]).toContain("idx_agent_alarms_thread_pending");
});

test("a search keeps to the asked project inside an index, without reading other projects' rows", () => {
  const env = historyEnv();
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "rollout notes for the release" } });
  const plans = plansOf(env.store.db, /bm25\(agent_message_search_words\)/, () =>
    new AgentHistoryStore(env.store.db).search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "rollout", includeOwnThread: true }));
  expect(plans.length).toBeGreaterThan(0);
  // Each match's thread and time come from the index; its whole row is read
  // only once it is in the asked place.
  expect(plans[0]).toContain("idx_agent_message_search_entries_place");
});

test("a text match reads only the asked place's threads' rows", () => {
  const env = historyEnv();
  env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: "rollout notes for the release" } });
  const plans = plansOf(env.store.db, /e\.content_text like/, () =>
    new AgentHistoryStore(env.store.db).search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "ollout", includeOwnThread: true }));
  expect(plans.length).toBeGreaterThan(0);
  for (const plan of plans) expect(plan).toMatch(/SEARCH e USING INDEX idx_agent_message_search_thread_seq \(thread_id=\?\)/);
});

/** The bytecode opcodes of the statements `run` prepares whose SQL matches. */
function opcodesOf(db: Database, match: RegExp, run: () => unknown): string[][] {
  return preparedBy(db, run).filter((sql) => match.test(sql)).map((sql) => (db.prepare(`explain ${sql}`).all() as Array<{ opcode: string }>).map((r) => r.opcode));
}

// A read's "is there more before / after" asks for one row near the window.
// Walking the thread from its first row instead read every row older than the
// search's time range first, which on a long thread holds the server for a
// noticeable time.
test("a history read looks for an earlier message from its window back, and for a later one from its window on", () => {
  const env = historyEnv();
  const rows = Array.from({ length: 7 }, (_, i) => env.agentStore.appendMessage({ threadId: env.thread.id, role: "user", source: "user", content: { type: "text", text: i === 3 ? "rollout notes" : `step ${i}` } }));
  const history = new AgentHistoryStore(env.store.db);
  const found = history.search({ callerThreadId: env.caller.id, projectId: env.projectId, query: "rollout", includeOwnThread: true });
  const at = { threadId: found.threads[0]!.id, seq: found.threads[0]!.hits.find((h) => h.messageId === rows[3]!.id)!.seq };
  let read: ReturnType<AgentHistoryStore["read"]> | null = null;
  const [before, after] = opcodesOf(env.store.db, /m\.seq [<>] \?[\s\S]*limit 1/, () => { read = history.read({ callerThreadId: env.caller.id, ...at, limitBefore: 1, limitAfter: 1 }); });
  expect([read!.hasMoreBefore, read!.hasMoreAfter]).toEqual([true, true]);
  // Backward from the window for the earlier one; forward for the later one.
  expect([before!.includes("Prev"), after!.includes("Next")]).toEqual([true, true]);
});

test("the server's connection keeps 64 MB of pages, not SQLite's 8 MB", () => {
  const env = freshStoresEnv("md-reads-cache-");
  expect(env.store.db.prepare("pragma cache_size").get()).toEqual({ cache_size: -65536 });
});
