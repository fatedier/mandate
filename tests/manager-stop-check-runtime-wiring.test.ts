import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";
import { waitUntil } from "./helpers/wait.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { createManagerStopCheckStore } from "../src/server/modules/manager-checks/stop/store.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const config = (managerStopCheckEnabled: boolean) => ({
  models: {
    default: { model: "gw/chat-1" },
    providers: { gw: { type: "openai-compatible", baseURL: "https://gw.example.test/v1", apiKey: "sk-test", models: [{ id: "chat-1", input: ["text"] }, { id: "vendor/judge-1", input: ["text"], kind: "decision" }] } }
  },
  agent: { decisionsEnabled: true, decisionsModel: { model: "gw/vendor/judge-1", reasoningEffort: "provider-default" }, managerStopCheckEnabled }
});

// A manager's turn ends and nothing in its thread goes on: the manager stop check is
// asked about the reply, once it is on, and never while it is off.
test("the runtime asks the manager stop check when a manager's turn ends and its thread stops; not while it is off", async () => {
  for (const on of [true, false]) {
    env = freshStoresEnv("md-stop-check-runtime-");
    fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(config(on)));
    const runtime = testAgentRuntime(env);
    try {
      const thread = env.agentStore.createManagerThread("Release dates");
      env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date" } });
      const turn = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
      env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "The 12th or the 19th?", toolCalls: [] } });
      env.agentStore.finishWake(turn.id, "finished");
      const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
      await deps.afterWakeReleasedHook!(thread.id);
      const asked = () => env!.store.listLlmCalls(20).some((call) => call.purpose === "manager_stop_check" && call.scopeId === thread.id);
      if (on) {
        // The decision model was asked (the test cannot reach it, so the attempt failed).
        await waitUntil(asked, { timeout: 3000, label: "a manager_stop_check attempt" });
      } else {
        await runtime.managerStopCheck.idle();
        expect(asked()).toBe(false);
      }
      await runtime.managerStopCheck.idle();
    } finally {
      runtime.dispose();
      env.cleanup();
      env = null;
    }
  }
});

// The runtime hands Your agent the verdicts it keeps: a stored decision on a
// stopped thread's unread reply is in its context, as on Home.
test("Your agent's context reads the runtime's stored verdict on a stopped thread", async () => {
  env = freshStoresEnv("md-stop-check-runtime-context-");
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(config(true)));
  const runtime = testAgentRuntime(env);
  try {
    const thread = env.agentStore.createManagerThread("Release dates");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date" } });
    const reply = env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The 12th or the 19th?" } });
    createManagerStopCheckStore(env.store.db).set(thread.id, { replySeq: reply.seq, outcome: "decision", judgedAt: "2026-10-22T10:00:00.000Z" });
    expect(runtime.managerStopCheck.current(thread.id)?.verdict).toBe("decision");
    const global = env.agentStore.getOrCreateGlobalThread();
    const text = (await runtime.scopes.global.buildRuntimeContext!(global.id))!;
    expect(text).toContain("- manager: Decision needed · thread: Release dates");
  } finally {
    runtime.dispose();
  }
});

test("a thread whose manager stop check is under way is still at work for a delete", async () => {
  env = freshStoresEnv("md-stop-check-runtime-working-");
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(config(true)));
  const runtime = testAgentRuntime(env);
  try {
    const thread = env.agentStore.createManagerThread("Release dates");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date" } });
    env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The 12th or the 19th?" } });
    runtime.managerStopCheck.noteSettled(thread.id);
    expect(runtime.isThreadWorking(thread.id)).toBe(true);
    await runtime.managerStopCheck.idle();
    expect(runtime.isThreadWorking(thread.id)).toBe(false);
  } finally {
    runtime.dispose();
  }
});

// Your agent waits on the thread: its stop notice, told once the thread
// stops, carries the manager stop check's verdict on the reply.
test("Your agent's stop notice from the runtime says what the manager stop check found", async () => {
  env = freshStoresEnv("md-stop-check-runtime-notice-");
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(config(true)));
  const runtime = testAgentRuntime(env);
  try {
    const global = env.agentStore.getOrCreateGlobalThread();
    const thread = env.agentStore.createManagerThread("Release dates");
    // Your agent waits on the thread (a wait with nothing sent, as await_stop arms one).
    env.store.db.prepare("insert into global_handoffs (id, global_thread_id, kind, state, text, spoken, target_thread_id, created_at, updated_at) values ('hof_wait', ?, 'thread', 'waiting', '', 0, ?, ?, ?)")
      .run(global.id, thread.id, "2026-10-22T09:00:00.000Z", "2026-10-22T09:00:00.000Z");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date" } });
    const turn = env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    const reply = env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", wakeId: turn.id, content: { type: "assistant", text: "The 12th or the 19th?", toolCalls: [] } });
    env.agentStore.finishWake(turn.id, "finished");
    createManagerStopCheckStore(env.store.db).set(thread.id, { replySeq: reply.seq, outcome: "decision", judgedAt: "2026-10-22T10:00:00.000Z" });
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    await deps.afterWakeReleasedHook!(thread.id);
    const notice = () => (env!.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'thread-notice'").get(global.id) as { content: string } | null)?.content ?? "";
    await waitUntil(() => notice() !== "", { timeout: 3000, label: "the stop notice" });
    expect(notice()).toContain("Manager stop check: its latest reply waits for a decision from the user.");
  } finally {
    runtime.dispose();
  }
});

// Ended after the verdict, on its own: a refused write is tried again by the
// runtime, and the notice still reaches Your agent.
test("the runtime tries a waiting stop notice again when its write is refused", async () => {
  env = freshStoresEnv("md-stop-check-runtime-retry-");
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(config(true)));
  const runtime = testAgentRuntime(env, { stepRetryDelaysMs: [30, 30] });
  try {
    const global = env.agentStore.getOrCreateGlobalThread();
    const thread = env.agentStore.createManagerThread("Release dates");
    env.store.db.prepare("insert into global_handoffs (id, global_thread_id, kind, state, text, spoken, target_thread_id, created_at, updated_at) values ('hof_wait', ?, 'thread', 'waiting', '', 0, ?, ?, ?)")
      .run(global.id, thread.id, "2026-10-22T09:00:00.000Z", "2026-10-22T09:00:00.000Z");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date" } });
    const reply = env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The 12th or the 19th?" } });
    createManagerStopCheckStore(env.store.db).set(thread.id, { replySeq: reply.seq, outcome: "result", judgedAt: "2026-10-22T10:00:00.000Z" });
    // The database refuses the first write of the notice.
    const enqueue = env.agentStore.enqueueMailboxMessage.bind(env.agentStore);
    let refused = 0;
    env.agentStore.enqueueMailboxMessage = ((input: Parameters<typeof enqueue>[0]) => {
      if (input.source === "thread-notice" && refused === 0) {
        refused++;
        throw new Error("database is locked");
      }
      return enqueue(input);
    }) as typeof enqueue;
    runtime.handoffs.noteSettled(thread.id);
    const notice = () => (env!.store.db.prepare("select content from agent_mailbox where thread_id = ? and source = 'thread-notice'").get(global.id) as { content: string } | null)?.content ?? "";
    await waitUntil(() => notice() !== "", { timeout: 3000, label: "the stop notice, tried again" });
    expect([refused, notice().includes("Manager stop check: its latest reply has a result for the user to read.")]).toEqual([1, true]);
  } finally {
    runtime.dispose();
  }
});

test("with the manager stop check off in its settings, a verdict stored while it was on does not show", async () => {
  env = freshStoresEnv("md-stop-check-runtime-off-");
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(config(false)));
  const runtime = testAgentRuntime(env);
  try {
    const thread = env.agentStore.createManagerThread("Release dates");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date" } });
    const reply = env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The 12th or the 19th?" } });
    createManagerStopCheckStore(env.store.db).set(thread.id, { replySeq: reply.seq, outcome: "decision", judgedAt: "2026-10-22T10:00:00.000Z" });
    expect(runtime.managerStopCheck.current(thread.id)).toBeNull();
  } finally {
    runtime.dispose();
  }
});

test("a thread the runtime releases for its archive leaves nothing kept in the manager stop check", async () => {
  env = freshStoresEnv("md-stop-check-runtime-forget-");
  fs.writeFileSync(path.join(env.dir, "config.json"), JSON.stringify(config(true)));
  const runtime = testAgentRuntime(env);
  try {
    const thread = env.agentStore.createManagerThread("Release dates");
    env.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date" } });
    const reply = env.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The 12th or the 19th?" } });
    createManagerStopCheckStore(env.store.db).set(thread.id, { replySeq: reply.seq, outcome: "decision", judgedAt: "2026-10-22T10:00:00.000Z" });
    expect(runtime.managerStopCheck.current(thread.id)?.verdict).toBe("decision");
    expect(runtime.managerStopCheck.kept()).toBe(1);
    runtime.releaseThreadResources(thread.id);
    expect(runtime.managerStopCheck.kept()).toBe(0);
  } finally {
    runtime.dispose();
  }
});
