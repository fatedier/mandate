import { expect, spyOn, test } from "bun:test";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import type { PostWakeInfo, WakeScheduler } from "../src/server/modules/agent/wake-loop.js";
import { featureMessageRequestMetadata } from "../src/shared/feature-message.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { stub, toolContext } from "./helpers/typed.js";
import { waitUntil } from "./helpers/wait.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// The runtime, not the senders: mail put in an idle thread's mailbox by a
// sender outside that thread's release, whose wake the database refuses
// (another writer holding it), is left queued and the thread's follow-up is
// tried again — the sender carries on. Before, the throw reached the sender:
// a tool failed after its mail was queued, a reply relay skipped the callers
// after the first, a start-up with queued mail did not start.

function build(env: ReturnType<typeof freshStoresEnv>, workStore = new WorkItemStore(env.store.db)) {
  return testAgentRuntime(env, {
    workStore
  });
}

/** Wakes of the threads named are refused; every retry asked for is recorded. */
function refuseWakes(runtime: ReturnType<typeof buildAgentRuntime>, refused: (threadId: string) => boolean) {
  const retried: string[] = [];
  const scheduler = runtime.wakeScheduler as unknown as {
    wake: WakeScheduler["wake"];
    retryFollowUp: WakeScheduler["retryFollowUp"];
  };
  scheduler.wake = (threadId) => {
    if (refused(threadId)) throw new Error("database is locked");
    return "wk_other";
  };
  scheduler.retryFollowUp = (threadId) => { retried.push(threadId); };
  return retried;
}

test("a thread notice to Your agent whose wake is refused stays queued and its follow-up is tried again", async () => {
  const env = freshStoresEnv("md-mail-retry-notice-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    runtime = build(env);
    const global = env.agentStore.getOrCreateGlobalThread();
    const followed = env.agentStore.createManagerThread("Docs overhaul");
    env.agentStore.createWake({ threadId: followed.id, reason: "user", triggerMessageId: null });
    const armed = runtime.handoffs.awaitStop({ globalThreadId: global.id, threadId: followed.id });
    if (!("handoff" in armed)) throw new Error("expected a wait");
    const retried = refuseWakes(runtime, (threadId) => threadId === global.id);
    const ask = runtime.scopes.manager.toolDefinitions.find((tool) => tool.name === "ask_user")!;
    await ask.handler({ question: "Push the branch?", options: [{ label: "Push" }, { label: "Hold it" }] }, toolContext({ threadId: followed.id }));
    expect(env.agentStore.queuedMailboxSources(global.id)).toEqual(["thread-notice"]);
    expect(retried).toStrictEqual([global.id]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

test("a manager's message to its worker whose wake is refused is queued: the tool says so and the worker's follow-up is tried again", async () => {
  const env = freshStoresEnv("md-mail-retry-send-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    runtime = build(env);
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const manager = env.agentStore.createManagerThread("project-1 cache expiry");
    env.features.setOwner(featureId, manager.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const retried = refuseWakes(runtime, (threadId) => threadId === worker.id);
    const send = runtime.scopes.manager.toolDefinitions.find((tool) => tool.name === "feature_message_send")!;
    const result = await send.handler({ featureId, message: "Which hook did you pick?" }, toolContext({ threadId: manager.id }));
    expect(result).toMatchObject({ featureThreadId: worker.id, status: "queued" });
    expect(env.agentStore.queuedMailboxSources(worker.id)).toEqual(["manager"]);
    expect(retried).toStrictEqual([worker.id]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

test("a worker's reply and report to its idle manager whose wakes are refused stay queued, and the manager's follow-up is tried again", async () => {
  const env = freshStoresEnv("md-mail-retry-reply-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const projectId = seedProject(env.projects, { name: "project-1" });
    const featureId = seedFeature(env.features, projectId, { name: "evicthook" });
    const manager = env.agentStore.createManagerThread("project-1 cache expiry");
    env.features.setOwner(featureId, manager.id);
    const worker = env.agentStore.getOrCreateThread("worker", featureId);
    const workStore = new WorkItemStore(env.store.db);
    runtime = build(env, workStore);
    const retried = refuseWakes(runtime, (threadId) => threadId === manager.id);
    // The worker's turn read a question its manager sent, answered it and finished its plan.
    const wake = env.agentStore.createWake({ threadId: worker.id, reason: "user", triggerMessageId: null });
    env.agentStore.enqueueMailboxMessage({
      threadId: worker.id, role: "user", source: "manager", sourceThreadId: manager.id,
      content: { type: "text", text: "Which hook did you pick?", metadata: featureMessageRequestMetadata() }
    });
    env.agentStore.drainMailboxToMessages(worker.id, wake.id);
    env.agentStore.appendMessage({ threadId: worker.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "EvictHook, wired in the cache." } });
    new PlanStore(env.store.db).update(featureId, { conclusion: "EvictHook wired; tests pass", steps: [{ title: "Wire", status: "done", note: "ok" }] });
    env.agentStore.finishWake(wake.id, "finished");
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    await deps.postWakeHook!(worker.id, stub<PostWakeInfo>({ wakeId: wake.id, status: "finished" }));
    expect(env.agentStore.queuedMailboxSources(manager.id).sort()).toEqual(["feature-message", "worker-report"]);
    expect(retried).toStrictEqual([manager.id, manager.id]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

test("a start-up whose wake for queued mail is refused still starts, and the thread is woken for its mail when tried again", async () => {
  const env = freshStoresEnv("md-mail-retry-startup-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const originalError = console.error;
  console.error = () => {};
  const create = spyOn(env.agentStore, "createWake").mockImplementationOnce(() => { throw new Error("database is locked"); });
  try {
    const manager = env.agentStore.createManagerThread("project-1 cache expiry");
    env.agentStore.enqueueMailboxMessage({ threadId: manager.id, role: "user", source: "user", content: { type: "text", text: "Status?" } });
    runtime = build(env);
    expect(create).toHaveBeenCalledTimes(1);
    expect(env.agentStore.getLatestWakeForThread(manager.id)).toBe(null);
    await waitUntil(() => env.agentStore.getLatestWakeForThread(manager.id), { timeout: 3000, label: "a wake for the queued mail" });
  } finally {
    create.mockRestore();
    console.error = originalError;
    runtime?.dispose();
    env.cleanup();
  }
});

// A thread whose follow-up is to be tried again has not stopped: what it was
// to be woken for is about to start. Judged stopped, Your agent's wait on it
// ended (failed, at a start-up) while it went on to work, and its real end
// told nobody.
test("a start-up whose recovery wake is refused keeps Your agent's wait on that thread open, and the thread is woken when tried again", async () => {
  const env = freshStoresEnv("md-mail-retry-startup-handoff-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  const originalError = console.error;
  console.error = () => {};
  let create: ReturnType<typeof spyOn> | undefined;
  try {
    const global = env.agentStore.getOrCreateGlobalThread();
    const followed = env.agentStore.createManagerThread("Docs overhaul");
    // The previous process: the thread mid-turn, Your agent waiting on it; then it stopped.
    const interrupted = env.agentStore.createWake({ threadId: followed.id, reason: "user", triggerMessageId: null });
    const first = build(env);
    const armed = first.handoffs.awaitStop({ globalThreadId: global.id, threadId: followed.id });
    if (!("handoff" in armed)) throw new Error("expected a wait");
    first.dispose();
    create = spyOn(env.agentStore, "createWake").mockImplementationOnce(() => { throw new Error("database is locked"); });
    runtime = build(env);
    expect(runtime.handoffs.dto(armed.handoff.id)!.state).toBe("waiting");
    await waitUntil(() => env.agentStore.getLatestWakeForThread(followed.id)?.id !== interrupted.id, { timeout: 3000, label: "the recovery wake" });
    expect(runtime.handoffs.dto(armed.handoff.id)!.state).toBe("waiting");
  } finally {
    create?.mockRestore();
    console.error = originalError;
    runtime?.dispose();
    env.cleanup();
  }
});

test("a release whose follow-up is refused leaves Your agent's wait on the thread open: the try that goes through settles it", async () => {
  const env = freshStoresEnv("md-mail-retry-release-handoff-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  let create: ReturnType<typeof spyOn> | undefined;
  try {
    runtime = build(env);
    const global = env.agentStore.getOrCreateGlobalThread();
    const followed = env.agentStore.createManagerThread("Docs overhaul");
    const turn = env.agentStore.createWake({ threadId: followed.id, reason: "user", triggerMessageId: null });
    const armed = runtime.handoffs.awaitStop({ globalThreadId: global.id, threadId: followed.id });
    if (!("handoff" in armed)) throw new Error("expected a wait");
    // The user writes while its turn runs; the turn ends.
    expect(runtime.userMessageQueue.submitThreadUserMessage({ threadId: followed.id, content: "Also the API docs.", source: "user" })).toMatchObject({ queued: true });
    env.agentStore.finishWake(turn.id, "finished");
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    create = spyOn(env.agentStore, "createWake").mockImplementationOnce(() => { throw new Error("database is locked"); });
    await expect(Promise.resolve(deps.afterWakeReleasedHook!(followed.id))).rejects.toThrow("database is locked");
    expect(runtime.handoffs.dto(armed.handoff.id)!.state).toBe("waiting");
    // Tried again: the thread is woken for the user's words, and still waited on.
    await deps.afterWakeReleasedHook!(followed.id);
    expect(env.agentStore.getLatestWakeForThread(followed.id)!.id).not.toBe(turn.id);
    expect(runtime.handoffs.dto(armed.handoff.id)!.state).toBe("waiting");
  } finally {
    create?.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});

test("a release follow-up given up after its tries settles Your agent's wait on the thread", async () => {
  const env = freshStoresEnv("md-mail-retry-abandoned-handoff-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  let create: ReturnType<typeof spyOn> | undefined;
  try {
    runtime = build(env);
    const global = env.agentStore.getOrCreateGlobalThread();
    const followed = env.agentStore.createManagerThread("Docs overhaul");
    const turn = env.agentStore.createWake({ threadId: followed.id, reason: "user", triggerMessageId: null });
    const armed = runtime.handoffs.awaitStop({ globalThreadId: global.id, threadId: followed.id });
    if (!("handoff" in armed)) throw new Error("expected a wait");
    runtime.userMessageQueue.submitThreadUserMessage({ threadId: followed.id, content: "Also the API docs.", source: "user" });
    env.agentStore.finishWake(turn.id, "finished");
    const deps = (runtime.wakeScheduler as unknown as { deps: ConstructorParameters<typeof WakeScheduler>[0] }).deps;
    create = spyOn(env.agentStore, "createWake").mockImplementation(() => { throw new Error("database is locked"); });
    await expect(Promise.resolve(deps.afterWakeReleasedHook!(followed.id))).rejects.toThrow("database is locked");
    expect(runtime.handoffs.dto(armed.handoff.id)!.state).toBe("waiting");
    // Its last try failed too: nothing more is coming, and the wait is settled as the thread now stands.
    deps.onFollowUpAbandoned!(followed.id);
    expect(runtime.handoffs.dto(armed.handoff.id)!.state).not.toBe("waiting");
  } finally {
    create?.mockRestore();
    runtime?.dispose();
    env.cleanup();
  }
});

test("a message sent to an idle thread, by the user or relayed by Your agent, whose wake is refused reads as sent, and the thread's follow-up is tried again", async () => {
  const env = freshStoresEnv("md-mail-retry-direct-send-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    runtime = build(env);
    const global = env.agentStore.getOrCreateGlobalThread();
    const thread = env.agentStore.createManagerThread("Docs overhaul");
    const retried = refuseWakes(runtime, (threadId) => threadId === thread.id);
    expect(runtime.userMessageQueue.submitThreadUserMessage({ threadId: thread.id, content: "Also the API docs.", source: "user" }))
      .toMatchObject({ wakeId: null, queued: false });
    const handoff = runtime.handoffs.sendToThread({ globalThreadId: global.id, threadId: thread.id, text: "And the changelog.", spoken: false });
    expect(handoff.state).not.toBe("queued");
    expect(env.agentStore.getActiveMessages(thread.id)).toHaveLength(2);
    expect(retried).toStrictEqual([thread.id, thread.id]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});

test("disposed, the runtime drops a follow-up still waiting to be tried again", () => {
  const env = freshStoresEnv("md-mail-retry-dispose-");
  const runtime = build(env);
  let disposed = false;
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const thread = env.agentStore.createManagerThread("Docs overhaul");
    runtime.wakeScheduler.retryFollowUp(thread.id, "a test", new Error("database is locked"));
    expect(runtime.wakeScheduler.hasFollowUpDue(thread.id)).toBe(true);
    runtime.dispose();
    disposed = true;
    expect(runtime.wakeScheduler.hasFollowUpDue(thread.id)).toBe(false);
  } finally {
    error.mockRestore();
    if (!disposed) runtime.dispose();
    env.cleanup();
  }
});

// The runtime tells a wait's end in two steps: the notice into Your agent's
// mailbox in the transaction that ends the wait, then the wake, once that has
// committed (a wake asked for inside a transaction that then rolled back would
// be one nothing records).
test("a wait's end puts its notice in Your agent's mailbox and asks for the wake after the commit", () => {
  const env = freshStoresEnv("md-handoff-notice-runtime-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    runtime = testAgentRuntime(env);
    const global = env.agentStore.getOrCreateGlobalThread();
    const thread = env.agentStore.createManagerThread("project-1 release");
    const sent = runtime.handoffs.sendToThread({ globalThreadId: global.id, threadId: thread.id, text: "Ship 0.72", spoken: false });
    const woken: Array<{ threadId: string; inTransaction: boolean }> = [];
    runtime.wakeScheduler.wakeForMail = (threadId) => { woken.push({ threadId, inTransaction: env.store.db.inTransaction }); return null; };
    runtime.releaseThreadResources(thread.id);
    expect(runtime.handoffs.dto(sent.id)).toMatchObject({ state: "failed", stop: "archived" });
    expect(woken).toStrictEqual([{ threadId: global.id, inTransaction: false }]);
    const mail = env.store.db.prepare("select source from agent_mailbox where thread_id = ?").all(global.id) as Array<{ source: string }>;
    expect(mail.map((m) => m.source)).toEqual(["thread-notice"]);
  } finally {
    runtime?.dispose();
    env.cleanup();
  }
});
