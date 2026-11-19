import { expect, test } from "bun:test";
import { buildAgentRuntime } from "../src/server/runtime/agent-runtime.js";
import { WorkItemStore } from "../src/server/modules/agent/work-item-store.js";
import { freshStoresEnv, seedWorker, seedProject } from "./helpers/fixtures.js";
import { toolContext } from "./helpers/typed.js";
import { PlanStore } from "../src/server/modules/plans/plan-store.js";
import { threadNoticeMetadata, threadNoticeOf } from "../src/shared/thread-notice.js";
import { testAgentRuntime } from "./helpers/agent-runtime.js";

// The runtime, not the queue or the store: what the user answers while a
// conversation's turn runs is an answer from the moment it is taken in, and
// whoever shows the conversation's questions is told then.
test("an answer taken in behind a running turn closes its question at once, and the runtime says the queue changed; words that name none close nothing", () => {
  const env = freshStoresEnv("md-question-runtime-wiring-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    runtime = testAgentRuntime(env);
    // Managers and the agent ask; a worker asks through its plan.
    const names = (scope: "manager" | "personal" | "worker") => runtime!.scopes[scope].toolDefinitions.map((tool) => tool.name);
    for (const scope of ["manager", "personal"] as const) {
      expect([scope, names(scope).filter((name) => name === "ask_user" || name === "withdraw_question")]).toEqual([scope, ["ask_user", "withdraw_question"]]);
    }
    expect(names("worker").filter((name) => name === "ask_user" || name === "withdraw_question")).toStrictEqual([]);
    const thread = env.agentStore.createManagerThread("Release");
    for (const [id, question] of [["q_1", "Push?"], ["q_2", "Tag?"]] as const) {
      env.agentStore.appendMessage({
        threadId: thread.id, role: "tool", source: "self",
        content: { type: "tool_result", toolCallId: `c_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options: [] } }
      });
    }
    const changed: string[] = [];
    const stop = runtime.onUserQueueChanged((threadId) => changed.push(threadId));
    // A turn is under way: what the user sends now waits for its next step.
    env.agentStore.createWake({ threadId: thread.id, reason: "user", triggerMessageId: null });
    const sent = runtime.userMessageQueue.submitThreadUserMessage({
      threadId: thread.id, content: "Push now", source: "user", clientRequestId: "local-1", answers: [{ id: "q_1", question: "Push?" }]
    });
    expect(sent.queued).toBe(true);
    expect(env.agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_2"]);
    expect(changed).toStrictEqual([thread.id]);
    // Taken back before the turn read it: the question is open again.
    runtime.userMessageQueue.removeQueuedMessage(thread.id, "local-1");
    expect(env.agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
    expect(changed).toStrictEqual([thread.id, thread.id]);
    // What the user tells the worker directly is copied to its manager, held
    // behind the manager's turn: no answer, so nothing it says changes.
    const projectId = seedProject(env.projects, { name: "project-1" });
    const workerId = seedWorker(env.workers, projectId, { name: "evict", ownerThreadId: thread.id });
    runtime.userMessageQueue.submitUserMessage({ scope: "worker", scopeId: workerId, content: "Push it." });
    expect(env.agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
    expect(changed).toStrictEqual([thread.id, thread.id]);
    expect(env.agentStore.getActiveMessages(thread.id).filter((m) => m.source === "worker-message")).toStrictEqual([]);
    // Typed words waiting behind the turn name no question either.
    runtime.userMessageQueue.submitThreadUserMessage({ threadId: thread.id, content: "Both, yes.", source: "user" });
    expect(env.agentStore.openQuestions(thread.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
    stop();
  } finally {
    runtime?.dispose();
  }
});

// The runtime, not the tool: whether a thread rests is read from the turns
// the runtime knows of. A worker still in the turn that asked may have more
// to do, and its manager has just been told: the question is not the user's yet.
test("the agent's waiting_on_you holds a worker's question back while that worker is still in its turn", async () => {
  const env = freshStoresEnv("md-question-runtime-waiting-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    const workStore = new WorkItemStore(env.store.db);
    runtime = testAgentRuntime(env, {
      workStore
    });
    const thread = env.agentStore.createManagerThread("Docs overhaul");
    const projectId = seedProject(env.projects, { name: "project-1" });
    const workerId = seedWorker(env.workers, projectId, { name: "evict", ownerThreadId: thread.id });
    new PlanStore(env.store.db).update(workerId, { openQuestions: ["Keep the old flag as an alias?"] });
    const tool = runtime.scopes.personal.toolDefinitions.find((t) => t.name === "waiting_on_you")!;
    const list = async () => ((await tool.handler({}, toolContext({ threadId: env.agentStore.getOrCreatePersonalThread().id }))) as { items: Array<Record<string, unknown>> }).items;
    expect(await list()).toMatchObject([{ kind: "worker", workerName: "evict", label: "Needs you", question: "Keep the old flag as an alias?" }]);
    const workerThread = env.agentStore.getOrCreateThread("worker", workerId);
    const turn = env.agentStore.createWake({ threadId: workerThread.id, reason: "user", triggerMessageId: null });
    expect(await list()).toStrictEqual([]);
    env.agentStore.finishWake(turn.id, "finished");
    expect((await list()).length).toBe(1);
  } finally {
    runtime?.dispose();
  }
});

// The runtime, not the service: the manager's own tool is what tells the
// agent, the moment it is called.
test("a thread asks the user: the agent's conversation is sent the question at once, waited on or not, and a wait stays open", async () => {
  const env = freshStoresEnv("md-question-runtime-notice-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    runtime = testAgentRuntime(env);
    const personal = env.agentStore.getOrCreatePersonalThread();
    const followed = env.agentStore.createManagerThread("Docs overhaul");
    const other = env.agentStore.createManagerThread("Search timeout");
    // The followed thread is in a turn: a wait on one that rests would arm nothing.
    env.agentStore.createWake({ threadId: followed.id, reason: "user", triggerMessageId: null });
    const armed = runtime.handoffs.awaitStop({ personalThreadId: personal.id, threadId: followed.id });
    if (!("handoff" in armed)) throw new Error("expected a wait");
    const ask = runtime.scopes.manager.toolDefinitions.find((tool) => tool.name === "ask_user")!;
    // The notices the agent's conversation was sent, each a mailbox row.
    const heard = () => (env.store.db.prepare("select count(*) as n from agent_mailbox where thread_id = ? and source = 'thread-notice'").get(personal.id) as { n: number }).n;
    // A thread nobody waits on asks: the agent hears all the same, or nobody would look.
    await ask.handler({ question: "Which index?" }, toolContext({ threadId: other.id }));
    expect(heard()).toBe(1);
    await ask.handler({ question: "Push the branch?", options: [{ label: "Push" }, { label: "Hold it" }] }, toolContext({ threadId: followed.id }));
    expect(heard()).toBe(2);
    expect(runtime.handoffs.dto(armed.handoff.id)!.state).toBe("waiting");
  } finally {
    runtime?.dispose();
  }
});

// The runtime: the manager's tools, the queue and the agent's conversation
// together. A question the agent heard of and the user settles in the thread
// reaches the agent: a row at once while it rests with nothing of its own
// open, waking nobody; mail that wakes it once it asked the user too; mail
// for its next step while its turn runs.
test("a question the agent heard of, settled in the thread, reaches its conversation: a row while it rests, a wake while it has a question open, its next step mid-turn", async () => {
  const env = freshStoresEnv("md-question-runtime-settled-");
  let runtime: ReturnType<typeof buildAgentRuntime> | undefined;
  try {
    runtime = testAgentRuntime(env);
    const store = env.agentStore;
    const personal = store.getOrCreatePersonalThread();
    const followed = store.createManagerThread("Docs overhaul");
    const result = (threadId: string, toolName: string, r: Record<string, unknown>) => store.appendMessage({
      threadId, role: "tool", source: "self", content: { type: "tool_result", toolCallId: `call_${String(r.questionId)}`, toolName, result: r }
    });
    /** The manager asked; the agent read that it did (a turn this runtime, never ready, does not run). */
    const asked = (id: string, question: string) => {
      result(followed.id, "ask_user", { asked: true, questionId: id, question, options: [] });
      store.appendMessage({
        threadId: personal.id, role: "user", source: "thread-notice", sourceThreadId: followed.id,
        content: { type: "text", text: "[Thread notice] asked", metadata: threadNoticeMetadata({
          handoffIds: [], kind: "thread", targetThreadId: followed.id, workerId: null, title: "Docs overhaul",
          stop: "asked", reason: null, question: { id, text: question, options: [] }
        }) }
      });
      return { id, question };
    };
    const settled = () => store.getActiveMessages(personal.id).flatMap((m) => {
      const notice = threadNoticeOf(m.content);
      return notice?.stop === "settled" ? [[notice.question?.id, notice.settled]] : [];
    });

    const inboxOf = () => store.getActiveMessages(personal.id).flatMap((m) => {
      const notice = threadNoticeOf(m.content);
      return notice?.stop === "settled" && m.content.type === "text" ? [m.content.metadata?.inbox] : [];
    });
    const mailWakes: string[] = [];
    const wakeForMail = runtime.wakeScheduler.wakeForMail.bind(runtime.wakeScheduler);
    runtime.wakeScheduler.wakeForMail = ((threadId: string, reason: Parameters<typeof wakeForMail>[1]) => {
      mailWakes.push(`${threadId} ${reason}`);
      return wakeForMail(threadId, reason);
    }) as typeof runtime.wakeScheduler.wakeForMail;
    const thread = `thread:${followed.id}`;

    // It rests with nothing of its own open: the row lands now and wakes nobody.
    const push = asked("q_1", "Push the branch?");
    runtime.userMessageQueue.submitThreadUserMessage({ threadId: followed.id, content: "Push", source: "user", answers: [push] });
    expect(settled()).toEqual([["q_1", { how: "answered", answer: "Push" }]]);
    expect(inboxOf()).toStrictEqual([{ kind: "note", key: thread }]);
    expect(mailWakes).toStrictEqual([]);
    expect(store.queuedMailboxSources(personal.id)).toStrictEqual([]);
    expect(runtime.wakeScheduler.isThreadBusy(personal.id)).toBe(false);

    // It put a question to the user itself: the manager taking its own back wakes it.
    result(personal.id, "ask_user", { asked: true, questionId: "q_g1", question: "Tag it too?", options: [] });
    const tag = asked("q_2", "Tag it?");
    await runtime.scopes.manager.toolDefinitions.find((t) => t.name === "withdraw_question")!.handler({ questionId: tag.id }, toolContext({ threadId: followed.id }));
    expect(store.queuedMailboxSources(personal.id)).toEqual(["thread-notice"]);
    // The scheduler took it up: its turn holds the conversation (one this runtime, never ready, does not run).
    expect(runtime.wakeScheduler.isThreadBusy(personal.id)).toBe(true);
    const turn = store.createWake({ threadId: personal.id, reason: "thread-notice", triggerMessageId: null });
    store.drainMailboxToMessages(personal.id, turn.id);
    expect(settled().map(([id]) => id)).toStrictEqual(["q_1", "q_2"]);
    // A request: it woke the agent as a thread notice.
    expect(inboxOf()).toStrictEqual([{ kind: "note", key: thread }, { kind: "request", key: thread }]);
    expect(mailWakes).toStrictEqual([`${personal.id} thread-notice`]);

    // Its turn runs and it took its own back: the row waits for its next step and starts no turn.
    result(personal.id, "withdraw_question", { withdrawn: true, questionId: "q_g1" });
    const bump = asked("q_3", "Bump the version?");
    runtime.userMessageQueue.skipQuestion(followed.id, bump);
    expect([settled().length, store.queuedMailboxSources(personal.id).length > 0]).toEqual([2, false]);
    store.drainMailboxToMessages(personal.id, turn.id);
    expect(settled().at(-1)).toEqual(["q_3", { how: "skipped" }]);
    expect(inboxOf().at(-1)).toStrictEqual({ kind: "note", key: thread });
    expect(mailWakes).toHaveLength(1);
  } finally {
    runtime?.dispose();
  }
});
