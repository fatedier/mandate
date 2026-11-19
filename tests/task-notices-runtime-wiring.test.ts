import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { configJson } from "./helpers/config-file.js";
import { waitUntil } from "./helpers/wait.js";

let env: StoresEnv | null = null;

/** Every thread notice the personal agent has: landed, or waiting in its mail. */
function noticesTo(personalId: string): string[] {
  const landed = env!.agentStore.getMessagesSince(personalId, 0).filter((m) => m.source === "thread-notice").map((m) => (m.content as { text: string }).text);
  const mail = env!.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'thread-notice' order by rowid").all(personalId) as Array<{ content: string }>;
  return [...landed, ...mail.map((row) => (JSON.parse(row.content) as { text: string }).text)];
}

function linkedThread(runtimeEnv: StoresEnv, taskBoard: TaskBoardService) {
  const thread = runtimeEnv.agentStore.createManagerThread("Catalogue search source");
  const task = taskBoard.create({ title: "Book data from one source" }, "owner");
  taskBoard.link(task.id, thread.id);
  return { thread, task };
}
let dispose: (() => void) | null = null;
afterEach(() => { dispose?.(); dispose = null; env?.cleanup(); env = null; });

// With the manager stop check off, a linked thread that stops tells the
// personal agent at once, as a note naming the task.
test("the runtime tells the personal agent of a task-linked thread that stopped", async () => {
  env = freshStoresEnv("md-task-notices-runtime-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson({ agent: { managerStopCheckEnabled: false } }));
  const taskBoard = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map() });
  const runtime = testAgentRuntime(env, { taskBoard });
  dispose = () => runtime.dispose();
  const thread = env.agentStore.createManagerThread("Catalogue search source");
  const task = taskBoard.create({ title: "Book data from one source" }, "owner");
  taskBoard.link(task.id, thread.id);
  const turn = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "Picked Atlas.", toolCalls: [] } });
  env.agentStore.finishWake(turn.id, "finished");
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  await deps.afterWakeReleasedHook!(thread.id);
  const personal = env.agentStore.getOrCreatePersonalThread();
  const notices = env.agentStore.getMessagesSince(personal.id, 0).filter((m) => m.source === "thread-notice");
  expect(notices).toHaveLength(1);
  const content = notices[0]!.content as { type: "text"; text: string };
  expect(content.text).toContain(`Linked to task: "Book data from one source" (${task.id})`);
  expect(content.text).toContain("Picked Atlas.");
});

// A wait of the agent's that ends on the stop tells it once, with the task;
// the board adds nothing.
test("a hand-off wait that ends on a linked thread's failure is the one notice", async () => {
  env = freshStoresEnv("md-task-notices-runtime-wait-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson({ agent: { managerStopCheckEnabled: false } }));
  const taskBoard = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map() });
  const runtime = testAgentRuntime(env, { taskBoard });
  dispose = () => runtime.dispose();
  const { thread, task } = linkedThread(env, taskBoard);
  const personal = env.agentStore.getOrCreatePersonalThread();
  const turn = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  expect("handoff" in runtime.handoffs.awaitStop({ personalThreadId: personal.id, threadId: thread.id })).toBe(true);
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "The provider refused.", toolCalls: [] } });
  env.agentStore.finishWake(turn.id, "error");
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  await deps.afterWakeReleasedHook!(thread.id);
  const notices = noticesTo(personal.id);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(`Linked to task: "Book data from one source" (${task.id})`);
});

// A wait the hand-off already ended does not keep the board quiet: the
// thread's later failure is told.
test("a linked thread's failure after the agent's wait on it ended is told", async () => {
  env = freshStoresEnv("md-task-notices-runtime-after-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson({ agent: { managerStopCheckEnabled: false } }));
  const taskBoard = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map() });
  const runtime = testAgentRuntime(env, { taskBoard });
  dispose = () => runtime.dispose();
  const { thread } = linkedThread(env, taskBoard);
  const personal = env.agentStore.getOrCreatePersonalThread();
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  const first = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  expect("handoff" in runtime.handoffs.awaitStop({ personalThreadId: personal.id, threadId: thread.id })).toBe(true);
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: first.id, content: { type: "assistant", text: "Compared: Atlas.", toolCalls: [] } });
  env.agentStore.finishWake(first.id, "finished");
  await deps.afterWakeReleasedHook!(thread.id);
  expect(runtime.handoffs.hasOpenWait(thread.id)).toBe(false);
  expect(noticesTo(personal.id)).toHaveLength(1);
  // Later the thread runs again, on its own, and fails.
  const second = env.agentStore.createWake({ threadId: thread.id, reason: "alarm", triggerMessageId: null });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: second.id, content: { type: "assistant", text: "Refresh failed.", toolCalls: [] } });
  env.agentStore.finishWake(second.id, "error");
  await deps.afterWakeReleasedHook!(thread.id);
  const notices = noticesTo(personal.id);
  expect(notices).toHaveLength(2);
  expect(notices[1]).toContain("Refresh failed.");
});

// Final: with the stop check on, the board waits for the check's own outcome,
// not the hand-off's ten seconds (a slow result still wakes); a check that
// fails (here: its model cannot be reached) leaves a quiet note.
test("a linked thread's stop the check cannot judge reaches the agent as a note", async () => {
  env = freshStoresEnv("md-task-notices-runtime-check-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson({
    models: {
      default: { model: "gw/chat-1" },
      providers: { gw: { type: "openai-compatible", baseURL: "https://gw.example.test/v1", apiKey: "sk-test", models: [{ id: "chat-1", input: ["text"] }, { id: "vendor/judge-1", input: ["text"], kind: "decision" }] } }
    },
    agent: { decisionsEnabled: true, decisionsModel: { model: "gw/vendor/judge-1", reasoningEffort: "provider-default" }, managerStopCheckEnabled: true }
  }));
  const taskBoard = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map() });
  const runtime = testAgentRuntime(env, { taskBoard });
  dispose = () => runtime.dispose();
  const { thread, task } = linkedThread(env, taskBoard);
  const personal = env.agentStore.getOrCreatePersonalThread();
  const turn = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "Picked Atlas.", toolCalls: [] } });
  env.agentStore.finishWake(turn.id, "finished");
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  await deps.afterWakeReleasedHook!(thread.id);
  await waitUntil(() => noticesTo(personal.id).length > 0 || null, { timeout: 5000, label: "the note after the check failed" });
  await runtime.managerStopCheck.idle();
  const notices = noticesTo(personal.id);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain(`Linked to task: "Book data from one source" (${task.id})`);
  expect(notices[0]).not.toContain("Manager stop check:");
});

// The runtime hands the hand-off and the task board whether the user is in a
// thread now: a stop there is in front of them.
test("a task-linked thread's stop while the user is in it is not told; a question it asks is not either", async () => {
  env = freshStoresEnv("md-task-notices-runtime-present-");
  fs.writeFileSync(path.join(env.dir, "config.json"), configJson({ agent: { managerStopCheckEnabled: false } }));
  const taskBoard = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map() });
  let thread = { id: "" };
  const runtime = testAgentRuntime(env, { taskBoard, ownerInThread: (threadId) => threadId === thread.id });
  dispose = () => runtime.dispose();
  ({ thread } = linkedThread(env, taskBoard));
  const personal = env.agentStore.getOrCreatePersonalThread();
  const turn = env.agentStore.createWake({ threadId: thread.id, reason: "alarm", triggerMessageId: null });
  env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "Picked Atlas.", toolCalls: [] } });
  env.agentStore.finishWake(turn.id, "finished");
  const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
  await deps.afterWakeReleasedHook!(thread.id);
  runtime.handoffs.noteQuestion(thread.id, { id: "q_1", question: "Which source?", options: [] } as never);
  expect(noticesTo(personal.id)).toEqual([]);
});
