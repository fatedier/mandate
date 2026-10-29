import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, seedFeature, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { AgentUserMessageQueue } from "../src/server/modules/agent/user-message-queue.js";
import { HandoffService, endedWaitRoute, noticeKey } from "../src/server/modules/global/handoff-service.js";
import type { GlobalHandoffDto } from "../src/shared/api/global-agent.js";
import type { StopVerdict, ThreadStop } from "../src/shared/thread-dot.js";
import { threadNoticeMetadata, type ThreadNotice } from "../src/shared/thread-notice.js";
import type { UpwardRoute } from "../src/server/modules/agent/upward-inbox.js";
import { parseCut } from "./helpers/cut-line.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

function setup(opts: {
  recordNotice?: (globalThreadId: string, notice: ThreadNotice, lastReply: string | null, route: UpwardRoute) => () => void;
  stopVerdict?: (threadId: string) => Promise<StopVerdict | null> | null;
  later?: (who: string, step: () => void) => void;
  notify?: (globalThreadId: string, notice: ThreadNotice, lastReply: string | null, route: UpwardRoute) => void;
} = {}) {
  env = freshStoresEnv("md-global-handoffs-");
  const busy = new Set<string>();
  const wakes: Array<{ threadId: string; trigger: string | null }> = [];
  const events: GlobalHandoffDto[] = [];
  const stops = new Map<string, ThreadStop>();
  const notices: Array<{ globalThreadId: string; notice: ThreadNotice; lastReply: string | null; route: UpwardRoute }> = [];
  let service!: HandoffService;
  const state = { refuseWake: false };
  const queue = new AgentUserMessageQueue({
    agentStore: env.agentStore,
    wakeScheduler: {
      wake: (threadId, _reason, trigger) => {
        if (state.refuseWake) throw new Error("wake refused");
        wakes.push({ threadId, trigger });
        return `wake-${wakes.length}`;
      },
      isThreadBusy: (threadId) => busy.has(threadId)
    },
    onMessageAppended: (threadId, message) => service.noteAppended(threadId, message)
  });
  service = new HandoffService({
    db: env.store.db,
    agentStore: env.agentStore,
    featuresStore: env.features,
    queue,
    emit: (handoff) => events.push(handoff),
    stopOf: (threadId) => stops.get(threadId) ?? null,
    agentName: () => "Atlas",
    notify: opts.notify ?? ((globalThreadId, notice, lastReply, route) => notices.push({ globalThreadId, notice, lastReply, route })),
    ...(opts.recordNotice ? { recordNotice: opts.recordNotice } : {}),
    ...(opts.stopVerdict ? { stopVerdict: opts.stopVerdict } : {}),
    ...(opts.later ? { later: opts.later } : {})
  });
  const global = env.agentStore.getOrCreateGlobalThread();
  const projectId = seedProject(env.projects, { name: "m", workingDir: "/tmp/m", tmuxSessionName: "m" });
  const release = env.agentStore.createManagerThread("Docs overhaul");
  const featureId = seedFeature(env.features, projectId, { name: "release", ownerThreadId: release.id });
  /** A turn of `threadId` that answered `text` (or nothing) and ended; then
   *  the thread is `stop` (null: still working) and the runtime says it settled. */
  const runWake = (threadId: string, text: string | null, stop: ThreadStop | null, trigger: string | null = null) => {
    const wake = env!.agentStore.createWake({ threadId, reason: "user", triggerMessageId: trigger });
    if (text !== null) env!.agentStore.appendMessage({ threadId, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text, toolCalls: [] } });
    env!.agentStore.finishWake(wake.id, "finished", null);
    if (stop) stops.set(threadId, stop); else stops.delete(threadId);
    service.noteSettled(threadId);
    return wake.id;
  };
  return Object.assign(state, { env, busy, wakes, events, queue, service, global, release, featureId, runWake, stops, notices });
}

/** A message sent to the release thread. */
function sendToThreadForTest(s: ReturnType<typeof setup>, text: string) {
  return [s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text, spoken: false })] as const;
}

test("a message to a worker is the user's message with a relay marker; when the worker stops, its reply lands on the handoff and the agent is told", () => {
  const s = setup();
  const sent = s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "Keep the old install script", spoken: true });
  expect(sent.state).toBe("delivered");
  const workerThread = s.env.agentStore.getThreadByScope("worker", s.featureId)!;
  const [message] = s.env.agentStore.getMessages(workerThread.id);
  expect(message!.source).toBe("user");
  expect(message!.content).toMatchObject({ type: "text", text: "Keep the old install script", relay: { by: "global", spoken: true, handoffId: sent.id, name: "Atlas" } });
  expect(s.wakes.at(-1)).toEqual({ threadId: workerThread.id, trigger: message!.id });
  s.runWake(workerThread.id, "OK, the install script stays.", "stopped", message!.id);
  expect(s.service.dto(sent.id)).toMatchObject({ state: "replied", stop: "stopped", reply: "OK, the install script stays." });
  expect(s.events.at(-1)).toMatchObject({ id: sent.id, state: "replied" });
  expect(s.notices).toStrictEqual([{
    globalThreadId: s.global.id,
    notice: { handoffIds: [sent.id], kind: "feature", targetThreadId: workerThread.id, featureId: s.featureId, title: "release", stop: "stopped", reason: null },
    lastReply: "OK, the install script stays.",
    route: { kind: "report", key: `handoff:${sent.id}` }
  }]);
});

test("a busy worker queues the message; a stop before it is taken does not end it; it ends when the worker stops after", () => {
  const s = setup();
  const workerThread = s.env.agentStore.getOrCreateThread("worker", s.featureId);
  s.busy.add(workerThread.id);
  const sent = s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "go on", spoken: false });
  expect(sent.state).toBe("queued");
  // A stop before the message was taken does not end it: nothing was asked yet.
  s.runWake(workerThread.id, "earlier answer", "stopped");
  expect(s.service.dto(sent.id)!.state).toBe("queued");
  s.queue.flushQueuedIntoThread(workerThread.id); // the running wake's next step
  expect(s.service.dto(sent.id)!.state).toBe("delivered");
  s.runWake(workerThread.id, "continuing", "stopped");
  expect(s.service.dto(sent.id)).toMatchObject({ state: "replied", reply: "continuing" });
});

test("two handoffs flushed into one wake each get the reply that came after them, in one notice", () => {
  const s = setup();
  const workerThread = s.env.agentStore.getOrCreateThread("worker", s.featureId);
  s.busy.add(workerThread.id);
  const a = s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "first", spoken: false });
  const b = s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "second", spoken: false });
  const wake = s.env.agentStore.createWake({ threadId: workerThread.id, reason: "user", triggerMessageId: null });
  const [ma] = s.queue.flushQueuedIntoThread(workerThread.id).slice(0, 1);
  s.env.agentStore.appendMessage({ threadId: workerThread.id, role: "assistant", source: "self", wakeId: wake.id, content: { type: "assistant", text: "about first", toolCalls: [] } });
  void ma;
  // "second" was flushed with "first"; both precede the answer.
  s.env.agentStore.finishWake(wake.id, "finished");
  s.stops.set(workerThread.id, "stopped");
  s.service.noteSettled(workerThread.id);
  expect(s.service.dto(a.id)).toMatchObject({ state: "replied", reply: "about first" });
  expect(s.service.dto(b.id)).toMatchObject({ state: "replied", reply: "about first" });
  expect(s.notices.map((n) => n.notice.handoffIds)).toStrictEqual([[a.id, b.id]]);
});

test("an inactive worker is refused and nothing is sent", () => {
  const s = setup();
  s.env.features.archive(s.featureId);
  expect(() => s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "x", spoken: false })).toThrow(/archived/);
  expect(s.wakes).toStrictEqual([]);
});

test("a handoff to a thread archived before it answered fails; a restart fails what was still queued", () => {
  const s = setup();
  const sent = s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "x", spoken: false });
  s.service.failOpenForThread(s.release.id, "the thread was archived");
  expect(s.service.dto(sent.id)).toMatchObject({ state: "failed", stop: "archived", reason: "the thread was archived" });
  expect(s.notices.at(-1)!.notice).toMatchObject({ handoffIds: [sent.id], stop: "archived", reason: "the thread was archived" });
  const workerThread = s.env.agentStore.getOrCreateThread("worker", s.featureId);
  s.busy.add(workerThread.id);
  const queued = s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "y", spoken: false });
  s.service.cleanupAtStartup();
  expect(s.service.dto(queued.id)).toMatchObject({ state: "failed", stop: "failed", reason: "Mandate restarted before it was delivered" });
  expect(s.notices.at(-1)!.notice).toMatchObject({ handoffIds: [queued.id], stop: "failed", reason: "Mandate restarted before it was delivered" });
});

test("a send whose message the database refused leaves no handoff: the agent hears the error and waits on nothing", () => {
  const s = setup();
  const append = s.env.agentStore.appendMessage.bind(s.env.agentStore);
  s.env.agentStore.appendMessage = (() => { throw new Error("database is locked"); }) as typeof append;
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "x", spoken: false })).toThrow("database is locked");
  s.env.agentStore.getOrCreateThread("worker", s.featureId);
  expect(() => s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "y", spoken: false })).toThrow("database is locked");
  s.env.agentStore.appendMessage = append;
  expect(s.service.listOpenForContext(s.global.id)).toEqual([]);
  expect((s.env.store.db.prepare("select count(*) as n from global_handoffs").get() as { n: number }).n).toBe(0);
  expect(s.events).toStrictEqual([]);
  // A send whose message went in stays, delivered, though what came after it failed.
  s.refuseWake = true;
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "z", spoken: false })).toThrow("wake refused");
  s.refuseWake = false;
  expect(s.service.listOpenForContext(s.global.id).map((w) => w.sent)).toEqual(["z"]);
});

test("a send whose message went in keeps its handoff even when marking it delivered was refused", () => {
  const s = setup();
  const prepare = s.env.store.db.prepare.bind(s.env.store.db);
  let refuse = true;
  s.env.store.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!refuse || !/^update global_handoffs set/.test(sql)) return statement;
    return { run: () => { throw new Error("database is locked"); } };
  }) as typeof prepare;
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "in", spoken: false })).toThrow("database is locked");
  s.env.agentStore.getOrCreateThread("worker", s.featureId);
  expect(() => s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "also in", spoken: false })).toThrow("database is locked");
  refuse = false;
  s.env.store.db.prepare = prepare;
  // Both messages are in their threads, and the agent still waits on both.
  expect(s.service.listOpenForContext(s.global.id).map((w) => w.sent)).toEqual(["in", "also in"]);
});

test("a wait's end and its notice are written together: one refused leaves the wait open, and the next try tells it once", () => {
  const recorded: Array<{ notice: ThreadNotice; woken: boolean }> = [];
  let refuse = true;
  const s = setup({
    recordNotice: (_globalThreadId, notice) => {
      if (refuse) { refuse = false; throw new Error("database is locked"); }
      const entry = { notice, woken: false };
      recorded.push(entry);
      // The wake is asked for only once both are written and committed.
      return () => { entry.woken = !env!.store.db.inTransaction; };
    }
  });
  const sent = s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "x", spoken: false });
  // Its end refused: the wait is still open, nothing told.
  expect(() => s.runWake(s.release.id, "Done.", "stopped")).toThrow("database is locked");
  expect([s.service.dto(sent.id)!.state, recorded.length]).toEqual(["delivered", 0]);
  // Tried again: ended and told, once, and woken for.
  s.service.noteSettled(s.release.id);
  expect(s.service.dto(sent.id)).toMatchObject({ state: "replied", stop: "stopped" });
  expect(recorded.map((r) => [r.notice.handoffIds, r.woken])).toStrictEqual([[[sent.id], true]]);
  s.service.noteSettled(s.release.id);
  expect(recorded).toHaveLength(1);
});

test("a handoff whose target was archived on a path with no hook fails when handoffs are next read", () => {
  const s = setup();
  // A manager thread archived directly.
  const reviews = s.env.agentStore.createManagerThread("PR reviews");
  const toThread = s.service.sendToThread({ globalThreadId: s.global.id, threadId: reviews.id, text: "b", spoken: false });
  // And a wait with nothing sent, on the same thread.
  const armed = s.service.awaitStop({ globalThreadId: s.global.id, threadId: reviews.id });
  if (!("handoff" in armed)) throw new Error("expected a wait");
  const waiting = armed.handoff;
  s.env.agentStore.archiveThread(reviews.id);
  const listed = new Map(s.service.byIds(s.global.id, [toThread.id, waiting.id]).map((h) => [h.id, h]));
  expect(listed.get(toThread.id)).toMatchObject({ state: "failed", reason: "the thread was archived" });
  expect(listed.get(waiting.id)).toMatchObject({ state: "failed", reason: "the thread was archived" });
  // A project archive cascades to its workers without the feature archive hook.
  const projectId = seedProject(s.env.projects, { name: "n", workingDir: "/tmp/n", tmuxSessionName: "n" });
  const otherFeature = seedFeature(s.env.features, projectId, { name: "docs", ownerThreadId: s.release.id });
  const toOther = s.service.sendToFeature({ globalThreadId: s.global.id, featureId: otherFeature, text: "d", spoken: false });
  s.env.features.archiveByProjectId(projectId);
  s.service.listOpenForContext(s.global.id);
  expect(s.service.dto(toOther.id)).toMatchObject({ state: "failed", reason: "the worker was archived" });
  expect(s.events.at(-1)).toMatchObject({ id: toOther.id, state: "failed" });
});

test("a target archived while its turn ran ends the wait as archived, with what it had said", () => {
  const s = setup();
  const sent = s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "ship it", spoken: false });
  const workerThread = s.env.agentStore.getThreadByScope("worker", s.featureId)!;
  // Archived on a path with no hook, while its turn was still running.
  s.env.features.archive(s.featureId);
  s.runWake(workerThread.id, "shipped", "stopped", s.env.agentStore.getMessages(workerThread.id)[0]!.id);
  expect(s.service.dto(sent.id)).toMatchObject({ state: "failed", stop: "archived", reason: "the worker was archived", reply: "shipped" });
  expect(s.notices.map((n) => [n.notice.stop, n.notice.reason, n.lastReply])).toStrictEqual([["archived", "the worker was archived", "shipped"]]);
});

test("a wait does not end when the manager's first turn ends while the thread still works; it ends when the thread stops", () => {
  const s = setup();
  const [first] = sendToThreadForTest(s, "Fix the search timeout");
  s.runWake(s.release.id, "A worker is looking into it.", null);
  expect(s.service.dto(first.id)).toMatchObject({ state: "delivered", stop: null });
  expect(s.notices).toStrictEqual([]);
  s.runWake(s.release.id, "Fixed; the tests pass.", "stopped");
  expect(s.service.dto(first.id)).toMatchObject({ state: "replied", stop: "stopped", reply: "Fixed; the tests pass." });
  expect(s.notices.map((n) => [n.notice.stop, n.notice.title, n.lastReply])).toStrictEqual([["stopped", "Docs overhaul", "Fixed; the tests pass."]]);
});

test("a worker's turn ending is judged for the worker's own waits and for its thread's", () => {
  const s = setup();
  const [onThread] = sendToThreadForTest(s, "Fix the search timeout");
  const workerThread = s.env.agentStore.getOrCreateThread("worker", s.featureId);
  s.stops.set(s.release.id, "needs_you");
  s.service.noteSettled(workerThread.id);
  expect(s.service.dto(onThread.id)).toMatchObject({ state: "replied", stop: "needs_you" });
});

test("two waits on one target end together, in one notice; the next stop tells nobody", () => {
  const s = setup();
  const [a] = sendToThreadForTest(s, "The first thing");
  const [b] = sendToThreadForTest(s, "The second thing");
  s.runWake(s.release.id, "Got both.", "stopped");
  expect(s.notices.length).toBe(1);
  expect(s.notices[0]!.notice.handoffIds).toEqual([a.id, b.id]);
  s.runWake(s.release.id, "Stopped once more.", "stopped");
  expect(s.notices.length).toBe(1);
});

test("a thread that failed sets the wait failed; the notice carries what it had said, cut at 4,000 characters, the whole saved", () => {
  const s = setup();
  const [sent] = sendToThreadForTest(s, "Fix the search timeout");
  s.runWake(s.release.id, "x".repeat(5000), "failed");
  expect(s.service.dto(sent.id)).toMatchObject({ state: "failed", stop: "failed", reason: "It failed." });
  expect(s.service.dto(sent.id)!.reply!.length).toBe(5000);
  expect(parseCut(s.notices[0]!.lastReply!)).toEqual({ kept: "x".repeat(4000), first: 4000, of: 5000, whole: "x".repeat(5000) });
});

test("at start-up a wait whose target stopped while the server was down is told then; one still working stays open", () => {
  const s = setup();
  const [sent] = sendToThreadForTest(s, "Fix the search timeout");
  s.service.cleanupAtStartup();
  expect(s.service.dto(sent.id)).toMatchObject({ state: "delivered" });
  s.stops.set(s.release.id, "stopped");
  s.service.cleanupAtStartup();
  expect(s.service.dto(sent.id)).toMatchObject({ state: "replied", stop: "stopped" });
  expect(s.notices.length).toBe(1);
});

// Rows for several targets can end together, and each target is its own
// notice.
test("at start-up, sends still queued to two targets each tell the agent about their own target", () => {
  const s = setup();
  const workerThread = s.env.agentStore.getOrCreateThread("worker", s.featureId);
  s.busy.add(workerThread.id);
  s.busy.add(s.release.id);
  const toWorker = s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "for the worker", spoken: false });
  const [toThread] = sendToThreadForTest(s, "for the thread");
  expect([toWorker.state, s.service.dto(toThread.id)!.state]).toEqual(["queued", "queued"]);
  s.service.cleanupAtStartup();
  expect(s.notices.map((n) => [n.notice.kind, n.notice.title, n.notice.handoffIds])).toStrictEqual([
    ["feature", "release", [toWorker.id]],
    ["thread", "Docs overhaul", [toThread.id]]
  ]);
});

test("several waits on a target archived on a path with no hook end in one notice", () => {
  const s = setup();
  const reviews = s.env.agentStore.createManagerThread("PR reviews");
  const send = (text: string) => s.service.sendToThread({ globalThreadId: s.global.id, threadId: reviews.id, text, spoken: false });
  const a = send("a");
  const b = send("b");
  s.env.agentStore.archiveThread(reviews.id);
  s.service.byIds(s.global.id, [a.id, b.id]);
  expect(s.notices.map((n) => [n.notice.stop, n.notice.reason, n.notice.handoffIds])).toStrictEqual([["archived", "the thread was archived", [a.id, b.id]]]);
});

test("work goes to an open thread at once, as the user's message with the relay marker", () => {
  const s = setup();
  const sent = s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "Fix the search timeout", spoken: false });
  expect(sent).toMatchObject({ kind: "thread", state: "delivered", threadId: s.release.id, newThreadTitle: null });
  const [message] = s.env.agentStore.getMessages(s.release.id);
  expect(message!.source).toBe("user");
  expect(message!.content).toMatchObject({ type: "text", text: "Fix the search timeout", relay: { by: "global", spoken: false, handoffId: sent.id, name: "Atlas" } });
  expect(s.wakes.at(-1)).toEqual({ threadId: s.release.id, trigger: message!.id });
});

test("with a title it opens a new thread first; the row remembers that it did", () => {
  const s = setup();
  const sent = s.service.sendToThread({ globalThreadId: s.global.id, newThreadTitle: "  Search timeout  ", text: "Fix the search timeout", spoken: false });
  expect(sent).toMatchObject({ state: "delivered", newThreadTitle: "Search timeout", threadTitle: "Search timeout" });
  expect(sent.threadId).not.toBe(s.release.id);
  expect(s.env.agentStore.getMessages(sent.threadId!).length).toBe(1);
});

// The agent answers a question the thread's manager asked the user, for them:
// it names the question, so the manager reads the answer as one and only that
// question closes.
test("an answer the agent sends names the question it answers, found by its words, and closes only that one", () => {
  const s = setup();
  const ask = (id: string, question: string) => s.env.agentStore.appendMessage({
    threadId: s.release.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: `c_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options: [] } }
  });
  expect([s.service.asksNow(s.release.id), s.service.asksNow(undefined)]).toEqual([false, false]);
  ask("q_1", "Push the branch?\nIt is rebased on main.");
  ask("q_2", "Tag 3.21 too?");
  expect(s.service.asksNow(s.release.id)).toBe(true);
  // As the agent was told it: on one line.
  s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "\"Push it.\"", spoken: false, answers: "Push the branch? It is rebased on main." });
  const message = s.env.agentStore.getMessages(s.release.id).at(-1)!;
  expect(message.content).toMatchObject({ type: "text", text: "\"Push it.\"", metadata: { answers: [{ id: "q_1", question: "Push the branch?\nIt is rebased on main." }] }, relay: { by: "global" } });
  expect(s.env.agentStore.openQuestions(s.release.id).map((q) => q.id)).toEqual(["q_2"]);
  // Without it the agent's words answer nothing.
  s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "Also look at the logs.", spoken: false });
  expect(s.env.agentStore.openQuestions(s.release.id).map((q) => q.id)).toEqual(["q_2"]);
  // A long question is matched as it was cut in what the agent was told.
  ask("q_3", `${"x".repeat(300)}?`);
  s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "Yes.", spoken: false, answers: `${"x".repeat(199)}…` });
  expect(s.env.agentStore.openQuestions(s.release.id).map((q) => q.id)).toEqual(["q_2"]);
});

test("an answer to a question the thread does not have open is refused, with what is open there, and nothing is sent or opened", () => {
  const s = setup();
  s.env.agentStore.appendMessage({
    threadId: s.release.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c_q_2", toolName: "ask_user", result: { asked: true, questionId: "q_2", question: "Tag 3.21 too?", options: [] } }
  });
  const before = s.env.agentStore.listOpenManagerThreads().length;
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "Yes.", spoken: false, answers: "Push the branch?" }))
    .toThrow('Not an open question of that thread: "Push the branch?". Open there now: "Tag 3.21 too?".');
  // A new thread has asked nothing.
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, newThreadTitle: "Search timeout", text: "Yes.", spoken: false, answers: "Push the branch?" }))
    .toThrow('Not an open question of that thread: "Push the branch?". It has no open question now.');
  expect(s.env.agentStore.getMessages(s.release.id).filter((m) => m.role === "user")).toEqual([]);
  expect(s.env.agentStore.listOpenManagerThreads().length).toBe(before);
  // No handoff was recorded either.
  expect(s.events).toStrictEqual([]);
});

// The target went away between the agent choosing it and sending.
test("a send names exactly one of a thread and a title; a thread that is gone, or a bad title, is refused with nothing made", () => {
  const s = setup();
  const before = s.env.agentStore.listOpenManagerThreads().length;
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, text: "x", spoken: false })).toThrow(/exactly one/);
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, newThreadTitle: "t", text: "x", spoken: false })).toThrow(/exactly one/);
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, newThreadTitle: "a b ".repeat(30), text: "x", spoken: false })).toThrow(/1-80 characters/);
  expect(s.env.agentStore.listOpenManagerThreads().length).toBe(before);
  s.env.agentStore.archiveThread(s.release.id);
  expect(() => s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "x", spoken: false })).toThrow(/thread not found/);
  expect(s.env.agentStore.listOpenManagerThreads().length).toBe(before - 1);
  expect(s.events).toStrictEqual([]);
  expect(s.env.agentStore.getMessages(s.release.id)).toEqual([]);
});

test("a wait with nothing sent puts no message in the thread, and ends like any other", () => {
  const s = setup();
  const armed = s.service.awaitStop({ globalThreadId: s.global.id, threadId: s.release.id });
  if (!("handoff" in armed)) throw new Error("expected a wait");
  expect(armed.handoff).toMatchObject({ kind: "thread", state: "waiting", text: "", threadId: s.release.id });
  expect(s.env.agentStore.getMessages(s.release.id)).toEqual([]);
  s.runWake(s.release.id, "Checked it.", "stopped");
  expect(s.service.dto(armed.handoff.id)).toMatchObject({ state: "replied", stop: "stopped", reply: "Checked it." });
  expect(s.notices.length).toBe(1);
});

test("a target that stopped without writing leaves the words for that on its record, and its notice carries no reply", () => {
  const s = setup();
  const armed = s.service.awaitStop({ globalThreadId: s.global.id, threadId: s.release.id });
  if (!("handoff" in armed)) throw new Error("expected a wait");
  s.runWake(s.release.id, null, "stopped");
  // Stored on every such record, and what the page takes for "said nothing".
  expect(s.service.dto(armed.handoff.id)).toMatchObject({ state: "replied", stop: "stopped", reply: "(no text reply)" });
  expect(s.notices.map((n) => n.lastReply)).toStrictEqual([null]);
});

test("a wait on something already stopped arms nothing and says how it stopped", () => {
  const s = setup();
  s.stops.set(s.release.id, "needs_you");
  expect(s.service.awaitStop({ globalThreadId: s.global.id, threadId: s.release.id })).toEqual({ stopped: "needs_you" });
  expect(s.events).toStrictEqual([]);
});

test("a wait on a worker targets its own chat; an unknown worker, an archived one, a missing thread, or two targets at once are refused", () => {
  const s = setup();
  const workerThread = s.env.agentStore.getOrCreateThread("worker", s.featureId);
  const armed = s.service.awaitStop({ globalThreadId: s.global.id, featureId: s.featureId });
  expect("handoff" in armed && armed.handoff).toMatchObject({ kind: "feature", state: "waiting", featureId: s.featureId, threadId: workerThread.id });
  expect(() => s.service.awaitStop({ globalThreadId: s.global.id, threadId: s.release.id, featureId: s.featureId })).toThrow(/exactly one/);
  expect(() => s.service.awaitStop({ globalThreadId: s.global.id })).toThrow(/exactly one/);
  expect(() => s.service.awaitStop({ globalThreadId: s.global.id, featureId: "feat_missing" })).toThrow(/worker not found/);
  expect(() => s.service.awaitStop({ globalThreadId: s.global.id, threadId: "thr_missing" })).toThrow(/thread not found/);
  // A worker that has never had a turn has no chat to wait on.
  const projectId = seedProject(s.env.projects, { name: "n", workingDir: "/tmp/n", tmuxSessionName: "n" });
  const fresh = seedFeature(s.env.features, projectId, { name: "docs", ownerThreadId: s.release.id });
  expect(() => s.service.awaitStop({ globalThreadId: s.global.id, featureId: fresh })).toThrow(/no chat yet/);
  s.env.features.archive(s.featureId);
  expect(() => s.service.awaitStop({ globalThreadId: s.global.id, featureId: s.featureId })).toThrow(/archived/);
});

test("the agent's context lists what it waits to hear from, and nothing that has come back", () => {
  const s = setup();
  const sent = s.service.sendToThread({ globalThreadId: s.global.id, threadId: s.release.id, text: "Fix the search timeout", spoken: false });
  s.env.agentStore.getOrCreateThread("worker", s.featureId);
  s.service.awaitStop({ globalThreadId: s.global.id, featureId: s.featureId });
  expect(s.service.listOpenForContext(s.global.id).map((w) => [w.target, w.sent])).toEqual([
    ["thread Docs overhaul", "Fix the search timeout"],
    ["worker release", null]
  ]);
  s.runWake(s.release.id, "All done.", "stopped");
  expect(s.service.dto(sent.id)!.state).toBe("replied");
  expect(s.service.listOpenForContext(s.global.id).map((w) => w.target)).toEqual(["worker release"]);
});

// A proposal left from before this change can no longer be agreed to.
const PUSH = {
  id: "q_1", askedAt: "2026-01-12T14:00:00.000Z", question: "Push fix/evict-order and open a pull request?",
  options: [{ label: "Push and open the PR", description: "The tests pass." }, { label: "Hold it" }]
};

test("a question a followed thread asks the user is told at once, to whoever waits on it, and the waits stay open", () => {
  const s = setup();
  // Nobody waits on it: nobody is told.
  s.service.noteQuestion(s.release.id, PUSH);
  expect(s.notices).toStrictEqual([]);
  const [sent] = sendToThreadForTest(s, "Fix the eviction order");
  const armed = s.service.awaitStop({ globalThreadId: s.global.id, threadId: s.release.id });
  if (!("handoff" in armed)) throw new Error("expected a wait");
  s.service.noteQuestion(s.release.id, PUSH);
  // One notice for the conversation's two waits, with the question as it was asked.
  expect(s.notices).toStrictEqual([{
    globalThreadId: s.global.id,
    notice: {
      handoffIds: [sent.id, armed.handoff.id], kind: "thread", targetThreadId: s.release.id, featureId: null, title: "Docs overhaul",
      stop: "asked", reason: null, question: { id: PUSH.id, text: PUSH.question, options: PUSH.options }
    },
    lastReply: null,
    route: { kind: "request", key: `handoff:${sent.id}` }
  }]);
  expect([s.service.dto(sent.id)!.state, s.service.dto(armed.handoff.id)!.state]).toEqual(["delivered", "waiting"]);
  expect([s.service.dto(sent.id)!.stop, s.service.dto(sent.id)!.reply]).toEqual([null, null]);
  // The thread then stops on its question: the ordinary notice comes, and ends the waits.
  s.runWake(s.release.id, "Waiting for your answer.", "needs_you");
  expect(s.notices.map((n) => n.notice.stop)).toStrictEqual(["asked", "needs_you"]);
  expect([s.service.dto(sent.id)!.state, s.service.dto(armed.handoff.id)!.state]).toEqual(["replied", "replied"]);
  // A wait that has ended is told of no later question.
  s.service.noteQuestion(s.release.id, { ...PUSH, id: "q_2" });
  expect(s.notices.length).toBe(2);
});

test("a question is no news for a send the thread has not read yet, nor for a wait on another thread", () => {
  const s = setup();
  s.busy.add(s.release.id);
  const [queued] = sendToThreadForTest(s, "And update the changelog");
  expect(queued.state).toBe("queued");
  const other = s.env.agentStore.createManagerThread("Search timeout");
  s.service.awaitStop({ globalThreadId: s.global.id, threadId: other.id });
  s.service.noteQuestion(s.release.id, PUSH);
  expect(s.notices).toStrictEqual([]);
});

/** The agent's conversation was told `threadId` asked question `questionId`:
 *  the notice row as the runtime lands it, or still in its mailbox. */
function told(s: ReturnType<typeof setup>, threadId: string, questionId: string, where: "conversation" | "mailbox" = "conversation") {
  const content = {
    type: "text" as const, text: "[Thread notice] asked",
    metadata: threadNoticeMetadata({
      handoffIds: [], kind: "thread", targetThreadId: threadId, featureId: null, title: "Docs overhaul",
      stop: "asked", reason: null, question: { id: questionId, text: PUSH.question, options: [] }
    })
  };
  if (where === "mailbox") s.env.agentStore.enqueueMailboxMessage({ threadId: s.global.id, role: "user", source: "thread-notice", sourceThreadId: threadId, content });
  else s.env.agentStore.appendMessage({ threadId: s.global.id, role: "user", source: "thread-notice", sourceThreadId: threadId, content });
}

test("a question the agent was told of and the user settles in the thread is told to it, with how; it is woken only while it has a question of its own open", () => {
  const s = setup();
  const answered = { how: "answered" as const, answer: "Push and open the PR" };
  // Never told of it: nobody hears.
  s.service.noteQuestionSettled(s.release.id, PUSH, answered);
  expect(s.notices).toStrictEqual([]);
  told(s, s.release.id, PUSH.id);
  s.service.noteQuestionSettled(s.release.id, PUSH, answered);
  expect(s.notices).toStrictEqual([{
    globalThreadId: s.global.id,
    notice: {
      handoffIds: [], kind: "thread", targetThreadId: s.release.id, featureId: null, title: "Docs overhaul",
      stop: "settled", reason: null, question: { id: PUSH.id, text: PUSH.question, options: [] }, settled: answered
    },
    lastReply: null,
    route: { kind: "note", key: `thread:${s.release.id}` }
  }]);
  // The agent put it to the user too: woken now, to take its own back.
  s.env.agentStore.appendMessage({
    threadId: s.global.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "call_g1", toolName: "ask_user", result: { asked: true, questionId: "q_g1", question: "Push the fix?", options: [] } }
  });
  s.service.noteQuestionSettled(s.release.id, PUSH, { how: "skipped" });
  expect(s.notices.slice(1).map((n) => [n.notice.settled, n.route])).toStrictEqual([[{ how: "skipped" }, { kind: "request", key: `thread:${s.release.id}` }]]);
});

test("only the conversation told of that very question hears: another question of the thread, or the id told of another thread, is no news; a notice still in the mailbox counts", () => {
  const s = setup();
  const other = s.env.agentStore.createManagerThread("Search timeout");
  told(s, other.id, PUSH.id);
  // The prefix of an id is not the id.
  told(s, s.release.id, "q_10");
  s.service.noteQuestionSettled(s.release.id, PUSH, { how: "withdrawn" });
  expect(s.notices).toStrictEqual([]);
  told(s, s.release.id, PUSH.id, "mailbox");
  s.service.noteQuestionSettled(s.release.id, PUSH, { how: "withdrawn" });
  expect(s.notices.map((n) => [n.globalThreadId, n.notice.targetThreadId, n.notice.settled])).toStrictEqual([[s.global.id, s.release.id, { how: "withdrawn" }]]);
});

test("a long answer typed on the card is cut for the notice as a reply is", () => {
  const s = setup();
  told(s, s.release.id, PUSH.id);
  s.service.noteQuestionSettled(s.release.id, PUSH, { how: "answered", answer: "a".repeat(5000) });
  const answer = (s.notices[0]!.notice.settled as { answer: string }).answer;
  expect(parseCut(answer)).toEqual({ kept: "a".repeat(4000), first: 4000, of: 5000, whole: "a".repeat(5000) });
});

// Manager request check: a thread still at work said one request of Your agent's is
// done (or cannot go on). Only that wait ends, with one notice naming it.
test("endJudged ends only the given waits, with one notice listing their requests", () => {
  const s = setup();
  const [first] = sendToThreadForTest(s, "Merge #41 once the pipeline passes.");
  const [second] = sendToThreadForTest(s, "Set up the build worker.");
  const rows = s.service.openRequestWaits(s.release.id);
  expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  s.service.endJudged([rows[0]!], "done", "Merged #41; the pipeline passed.");
  expect(s.service.dto(first.id)).toMatchObject({ state: "replied", stop: "done", reply: "Merged #41; the pipeline passed." });
  expect(s.service.dto(second.id)!.state).toBe("delivered");
  expect(s.notices).toStrictEqual([{
    globalThreadId: s.global.id,
    notice: {
      handoffIds: [first.id], kind: "thread", targetThreadId: s.release.id, featureId: null, title: "Docs overhaul",
      stop: "done", reason: null, requests: ["Merge #41 once the pipeline passes."]
    },
    lastReply: "Merged #41; the pipeline passed.",
    route: { kind: "report", key: `handoff:${first.id}` }
  }]);
});

test("endJudged cuts each request to 300 characters for the notice, and tells nothing for a wait already ended", () => {
  const s = setup();
  const long = "x".repeat(400);
  const [sent] = sendToThreadForTest(s, long);
  const rows = s.service.openRequestWaits(s.release.id);
  expect(s.service.endJudged(rows, "cannot", "Waiting for your decision.")).toEqual([sent.id]);
  expect(s.notices[0]!.notice.requests).toEqual(["x".repeat(300)]);
  expect(s.service.dto(sent.id)!.stop).toBe("cannot");
  // Already ended: it says it ended none.
  expect(s.service.endJudged(rows, "done", "Done after all.")).toEqual([]);
  expect(s.notices.length).toBe(1);
});

test("openRequestWaits holds only delivered sends to a thread: not a wait with nothing sent, a send still queued, or a worker's", () => {
  const s = setup();
  const [sent] = sendToThreadForTest(s, "Fix the eviction order");
  s.service.awaitStop({ globalThreadId: s.global.id, threadId: s.release.id });
  s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "Keep the old install script", spoken: false });
  expect(s.service.openRequestWaits(s.release.id).map((row) => row.id)).toEqual([sent.id]);
  const workerThread = s.env.agentStore.getThreadByScope("worker", s.featureId)!;
  expect(s.service.openRequestWaits(workerThread.id)).toEqual([]);
  s.busy.add(s.release.id);
  sendToThreadForTest(s, "And update the changelog");
  expect(s.service.openRequestWaits(s.release.id).map((row) => row.id)).toEqual([sent.id]);
});

test("questionToldOpen: a question of the thread still open that Your agent was told of", () => {
  const s = setup();
  expect(s.service.questionToldOpen(s.release.id)).toBe(false);
  s.env.agentStore.appendMessage({
    threadId: s.release.id, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: "c_q_1", toolName: "ask_user", result: { asked: true, questionId: PUSH.id, question: PUSH.question, options: [] } }
  });
  // Open, but nobody was told of it.
  expect(s.service.questionToldOpen(s.release.id)).toBe(false);
  told(s, s.release.id, PUSH.id);
  expect(s.service.questionToldOpen(s.release.id)).toBe(true);
  // Told of a question of another thread: no.
  const other = s.env.agentStore.createManagerThread("Search timeout");
  expect(s.service.questionToldOpen(other.id)).toBe(false);
});



function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

// A thread's stop notice waits for the manager stop check (bounded where it is
// asked), and says what it found.
test("the notice waits for the verdict, then says it", async () => {
  const verdict = deferred<StopVerdict | null>();
  const asked: string[] = [];
  const s = setup({ stopVerdict: (threadId) => { asked.push(threadId); return verdict.promise; } });
  const [sent] = sendToThreadForTest(s, "Pick the release date");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  expect([asked, s.notices, s.service.dto(sent.id)!.state]).toEqual([[s.release.id], [], "delivered"]);
  // A second settle while it waits asks nothing more and tells nothing.
  s.service.noteSettled(s.release.id);
  expect([asked.length, s.notices.length]).toEqual([1, 0]);
  verdict.resolve("decision");
  await settle();
  expect(s.notices.map((n) => [n.notice.stop, n.notice.verdict, n.lastReply])).toStrictEqual([["stopped", "decision", "The 12th or the 19th?"]]);
  expect(s.service.dto(sent.id)).toMatchObject({ state: "replied", stop: "stopped" });
});

test("no verdict in time: the notice goes without the line", async () => {
  const s = setup({ stopVerdict: async () => null });
  sendToThreadForTest(s, "Pick the release date");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  await settle();
  expect(s.notices.map((n) => [n.notice.stop, n.notice.verdict])).toStrictEqual([["stopped", undefined]]);
});

test("work that resumes during the wait sends no stopped notice; the next stop sends one", async () => {
  const first = deferred<StopVerdict | null>();
  let next: Promise<StopVerdict | null> = first.promise;
  const s = setup({ stopVerdict: () => next });
  const [sent] = sendToThreadForTest(s, "Pick the release date");
  s.runWake(s.release.id, "Checking the calendar.", "stopped");
  s.stops.delete(s.release.id);
  first.resolve("nothing");
  await settle();
  expect([s.notices, s.service.dto(sent.id)!.state]).toEqual([[], "delivered"]);
  next = Promise.resolve("result");
  s.runWake(s.release.id, "The 19th is booked.", "stopped");
  await settle();
  expect(s.notices.map((n) => [n.notice.stop, n.notice.verdict, n.lastReply])).toStrictEqual([["stopped", "result", "The 19th is booked."]]);
});

test("a stop that turns into another while it waits is told as that, without a verdict", async () => {
  const verdict = deferred<StopVerdict | null>();
  const s = setup({ stopVerdict: () => verdict.promise });
  sendToThreadForTest(s, "Pick the release date");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  s.stops.set(s.release.id, "needs_you");
  verdict.resolve("decision");
  await settle();
  expect(s.notices.map((n) => [n.notice.stop, n.notice.verdict])).toStrictEqual([["needs_you", undefined]]);
});

test("with the manager stop check off the notice goes at once; a worker's stop never waits for one", () => {
  const asked: string[] = [];
  const s = setup({ stopVerdict: (threadId) => { asked.push(threadId); return null; } });
  sendToThreadForTest(s, "Pick the release date");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  expect(s.notices.map((n) => [n.notice.stop, n.notice.verdict])).toStrictEqual([["stopped", undefined]]);
  // A message to a worker ends when the worker stops, as today.
  s.service.sendToFeature({ globalThreadId: s.global.id, featureId: s.featureId, text: "Keep the old script", spoken: false });
  const workerThread = s.env.agentStore.getThreadByScope("worker", s.featureId)!;
  s.runWake(workerThread.id, "Kept it.", "stopped");
  expect(asked).toStrictEqual([s.release.id]);
  expect(s.notices.at(-1)!.notice).toMatchObject({ kind: "feature", stop: "stopped" });
});

// The thread went on, wrote a newer reply and stopped again while its notice
// waited: the verdict that lands is the older reply's. The notice waits for
// the newer reply's instead.
test("a newer reply while the notice waits gets its own verdict; the older one's is not put on it", async () => {
  const older = deferred<StopVerdict | null>();
  const answers: Array<Promise<StopVerdict | null>> = [older.promise, Promise.resolve("result")];
  const s = setup({ stopVerdict: () => answers.shift() ?? null });
  sendToThreadForTest(s, "Pick the release date");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  s.runWake(s.release.id, "Booked the 19th.", "stopped");
  older.resolve("decision");
  await settle();
  expect(s.notices.map((n) => [n.notice.stop, n.notice.verdict, n.lastReply])).toStrictEqual([["stopped", "result", "Booked the 19th."]]);
});

// The user wrote in the thread while its notice waited, and the manager's
// turn for it wrote no reply: the verdict that lands is about a reply the
// matter has moved past. The notice goes without it.
test("a word in the thread while the notice waits leaves the older reply's verdict off it", async () => {
  const older = deferred<StopVerdict | null>();
  const answers: Array<Promise<StopVerdict | null>> = [older.promise];
  const s = setup({ stopVerdict: () => answers.shift() ?? null });
  sendToThreadForTest(s, "Pick the release date");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  userSays(s, "The 19th.");
  s.runWake(s.release.id, null, "stopped");
  older.resolve("decision");
  await settle();
  expect(s.notices.map((n) => [n.notice.stop, n.notice.verdict])).toStrictEqual([["stopped", undefined]]);
});

// A wait that ended with no verdict, and whose end was refused, is replaced
// by the next settle's wait: the older one's retry does not end the waits
// with its nothing, and the newer one's verdict is told.
test("an older wait's retry gives way to the wait that replaced it", async () => {
  const steps: Array<() => void> = [];
  const answers: Array<Promise<StopVerdict | null>> = [Promise.resolve(null), Promise.resolve("decision")];
  const s = setup({ stopVerdict: () => answers.shift() ?? null, later: (_who, step) => { steps.push(step); } });
  sendToThreadForTest(s, "Pick the release date");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  await settle();
  // Its end has not run yet (as when it was refused): the next settle waits again.
  s.service.noteSettled(s.release.id);
  await settle();
  expect(steps.length).toBe(2);
  steps[0]!();
  steps[1]!();
  expect(s.notices.map((n) => [n.notice.stop, n.notice.verdict])).toStrictEqual([["stopped", "decision"]]);
});

// A round the user drove with a thread directly, after the agent's requests
// to it were answered: what it left is told to the agent quietly, no wake.
const userSays = (s: ReturnType<typeof setup>, text: string) =>
  s.env.agentStore.appendMessage({ threadId: s.release.id, role: "user", source: "user", content: { type: "text", text } });
const latestSeq = (s: ReturnType<typeof setup>) => s.env.agentStore.latestReply(s.release.id)!.seq;
/** The quiet notices: of the user's own round, or of what came after a request was answered. */
const quiet = (s: ReturnType<typeof setup>) => s.notices.filter((n) => n.notice.direct || n.notice.after);
/** The agent's request to the release thread, answered and told of. */
function answeredRequest(s: ReturnType<typeof setup>) {
  sendToThreadForTest(s, "Draft the thinking override plan");
  s.runWake(s.release.id, "Plan drafted: [params plan](/canvas/cnv_P8sV2mQ0rTe).", "stopped");
  expect(s.notices.map((n) => n.notice.stop)).toStrictEqual(["stopped"]);
}

test("a round the user drove directly in a thread the agent sent a request this week: what it left is told quietly, without a wake", () => {
  const s = setup();
  answeredRequest(s);
  userSays(s, "This plan is far too complex.");
  s.runWake(s.release.id, "Simpler now: one rule list.", "stopped");
  expect(s.notices.length).toBe(1);
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(s.notices.slice(1)).toStrictEqual([{
    globalThreadId: s.global.id,
    notice: { handoffIds: [], kind: "thread", targetThreadId: s.release.id, featureId: null, title: "Docs overhaul", stop: "stopped", reason: null, verdict: "result", direct: true },
    // What the user said, not the reply they have in front of them.
    lastReply: "This plan is far too complex.",
    route: { kind: "note", key: `thread:${s.release.id}` }
  }]);
  // A decision is told too, with the words of that round alone.
  userSays(s, "Which date?");
  userSays(s, "Before the release.");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "decision" });
  const told = quiet(s).at(-1)!;
  expect([told.notice.verdict, told.lastReply]).toEqual(["decision", "Which date?\n\nBefore the release."]);
});

test("what comes after a request carries the thread's reply, cut at 1,500 characters, the whole saved", () => {
  const s = setup();
  sendToThreadForTest(s, "Draft the rollout plan");
  s.runWake(s.release.id, "Plan drafted; its workers run on.", "stopped");
  const reply = `Workers done: the plan is final. ${"x".repeat(2000)}`;
  s.runWake(s.release.id, reply, "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  const told = quiet(s).at(-1)!;
  expect(told.notice.after).toBe(true);
  expect(parseCut(told.lastReply!)).toEqual({ kept: reply.slice(0, 1500), first: 1500, of: reply.length, whole: reply });
});

test("nothing is told of a reply that leaves nothing, of a thread the agent sent nothing this week, or one archived", () => {
  const s = setup();
  // The user's round, and the agent never sent this thread a request.
  userSays(s, "Is the doc done?");
  s.runWake(s.release.id, "Done: two pages.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(s.notices).toStrictEqual([]);
  answeredRequest(s);
  userSays(s, "Thanks.");
  s.runWake(s.release.id, "You're welcome.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "nothing" });
  expect(quiet(s)).toEqual([]);
  // The agent's last request is over a week old.
  s.env.store.db.prepare("update global_handoffs set created_at = ?").run(new Date(Date.now() - 8 * 86_400_000).toISOString());
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s)).toEqual([]);
  s.env.store.db.prepare("update global_handoffs set created_at = ?").run(new Date().toISOString());
  // The conversation that sent it was put away.
  s.env.agentStore.archiveThread(s.global.id);
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s)).toEqual([]);
  s.env.store.db.prepare("update agent_threads set archived_at = null where id = ?").run(s.global.id);
  s.env.agentStore.archiveThread(s.release.id);
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s)).toEqual([]);
  // Back in the open, it would be told: the cases above stood alone.
  s.env.store.db.prepare("update agent_threads set archived_at = null where id = ?").run(s.release.id);
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s).length).toBe(1);
});

test("nothing is told of a reply the thread has moved past: a newer reply, a message after it, or working again", () => {
  const s = setup();
  answeredRequest(s);
  userSays(s, "And the date?");
  s.runWake(s.release.id, "The 12th.", "stopped");
  userSays(s, "Make it the 19th.");
  s.runWake(s.release.id, "The 19th, then.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s) - 2, outcome: "result" });
  userSays(s, "Thanks.");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  s.runWake(s.release.id, "Welcome.", null);
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s)).toEqual([]);
});

test("a round the agent sent is told by its own notice: an open request tells it, a late verdict adds nothing, and the user's word inside it changes nothing", () => {
  // A request open while its verdict is awaited: its own notice will tell.
  const waiting = setup({ stopVerdict: () => new Promise(() => {}) });
  sendToThreadForTest(waiting, "Check the release notes");
  userSays(waiting, "Also the changelog.");
  waiting.runWake(waiting.release.id, "Both checked.", "stopped");
  waiting.service.noteVerdict(waiting.release.id, { replySeq: latestSeq(waiting), outcome: "result" });
  expect(waiting.notices).toStrictEqual([]);
  waiting.env.cleanup();

  // The reply that ended the request, judged after its notice went (the
  // wait ended the very moment the reply was written: it told of it).
  const s = setup();
  answeredRequest(s);
  const ended = s.env.agentStore.latestReply(s.release.id)!;
  s.env.store.db.prepare("update global_handoffs set replied_at = ?").run(ended.createdAt);
  s.service.noteVerdict(s.release.id, { replySeq: ended.seq, outcome: "result" });
  expect(quiet(s)).toEqual([]);
  // The user wrote while the request was worked on; its wait ended after that reply, and told of it.
  sendToThreadForTest(s, "Check the release notes");
  userSays(s, "Also the changelog.");
  s.runWake(s.release.id, "Both checked.", "stopped");
  const reply = s.env.agentStore.latestReply(s.release.id)!;
  s.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(Date.now() - 60_000).toISOString(), reply.id);
  s.service.noteVerdict(s.release.id, { replySeq: reply.seq, outcome: "result" });
  expect(quiet(s)).toEqual([]);
});

test("waiting on a thread is no request sent: a round after a wait alone is not told, nor does a wait renew a request over a week old", () => {
  const waited = setup();
  expect("handoff" in waited.service.awaitStop({ globalThreadId: waited.global.id, threadId: waited.release.id })).toBe(true);
  userSays(waited, "Finish the draft.");
  waited.runWake(waited.release.id, "Draft finished.", "stopped");
  userSays(waited, "Shorten it.");
  waited.runWake(waited.release.id, "Shortened.", "stopped");
  waited.service.noteVerdict(waited.release.id, { replySeq: latestSeq(waited), outcome: "result" });
  expect(quiet(waited)).toEqual([]);
  waited.env.cleanup();

  const s = setup();
  answeredRequest(s);
  s.env.store.db.prepare("update global_handoffs set created_at = ?").run(new Date(Date.now() - 8 * 86_400_000).toISOString());
  // Working again, so the wait is armed: a row of its own, this week.
  s.stops.delete(s.release.id);
  expect("handoff" in s.service.awaitStop({ globalThreadId: s.global.id, threadId: s.release.id })).toBe(true);
  userSays(s, "Finish the draft.");
  s.runWake(s.release.id, "Draft finished.", "stopped");
  userSays(s, "Shorten it.");
  s.runWake(s.release.id, "Shortened.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s)).toEqual([]);
  // The request this week after all: told.
  s.env.store.db.prepare("update global_handoffs set created_at = ? where text <> ''").run(new Date().toISOString());
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s).length).toBe(1);
});

test("a quiet notice refused after it was written is undone, so trying again writes it once", () => {
  let refuse = true;
  const s = setup({
    notify: (globalThreadId, notice, lastReply) => {
      s.env.agentStore.appendMessage({ threadId: globalThreadId, role: "user", source: "thread-notice", content: { type: "text", text: lastReply ?? "", metadata: threadNoticeMetadata(notice) } });
      if (notice.direct && refuse) {
        refuse = false;
        throw new Error("read back refused");
      }
    }
  });
  sendToThreadForTest(s, "Draft the thinking override plan");
  s.runWake(s.release.id, "Plan drafted.", "stopped");
  userSays(s, "This plan is far too complex.");
  s.runWake(s.release.id, "Simpler now: one rule list.", "stopped");
  const judged = { replySeq: latestSeq(s), outcome: "result" } as const;
  expect(() => s.service.noteVerdict(s.release.id, judged)).toThrow("read back refused");
  s.service.noteVerdict(s.release.id, judged);
  const told = s.env.agentStore.getMessages(s.global.id).filter((m) => m.source === "thread-notice" && m.content.type === "text" && m.content.metadata?.threadNotice && (m.content.metadata.threadNotice as ThreadNotice).direct);
  expect(told.length).toBe(1);
});

test("a request that never reached the thread (lost at a restart) is no request sent", () => {
  const s = setup();
  s.busy.add(s.release.id);
  sendToThreadForTest(s, "Draft the thinking override plan");
  s.service.cleanupAtStartup();
  s.busy.delete(s.release.id);
  userSays(s, "Draft the plan.");
  s.runWake(s.release.id, "Plan drafted.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s)).toEqual([]);
  // Had it gone in, the round would be told.
  s.env.store.db.prepare("update global_handoffs set message_seq = 1").run();
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s).length).toBe(1);
});

test("a wait that ended after the reply, telling of an older one, did not tell of it: the user's round is told", () => {
  const s = setup();
  sendToThreadForTest(s, "Draft the thinking override plan");
  s.runWake(s.release.id, "Plan drafted; its workers run on.", null);
  const older = s.env.agentStore.latestReply(s.release.id)!;
  userSays(s, "Make it shorter.");
  s.runWake(s.release.id, "Shorter now.", null);
  const reply = s.env.agentStore.latestReply(s.release.id)!;
  s.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(Date.now() - 60_000).toISOString(), reply.id);
  // The manager request check, judging the older reply, ends the request after the newer was written.
  s.service.endJudged(s.service.openRequestWaits(s.release.id), "done", older.content.type === "assistant" ? older.content.text! : "");
  expect(s.notices.map((n) => n.notice.stop)).toStrictEqual(["done"]);
  // Another conversation's wait told of this very reply: that tells this one nothing.
  s.env.store.db.prepare(
    `insert into global_handoffs (id, global_thread_id, kind, state, text, spoken, target_thread_id, reply, created_at, updated_at, replied_at)
     values ('hof_other', 'thr_other_conversation', 'thread', 'replied', '', 0, ?, 'Shorter now.', ?, ?, ?)`
  ).run(s.release.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  s.stops.set(s.release.id, "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: reply.seq, outcome: "result" });
  // Told, carrying what the user said in that round.
  expect(quiet(s).map((n) => n.notice.direct)).toEqual([true]);
  expect(quiet(s).map((n) => n.lastReply)).toEqual(["Make it shorter."]);
});

test("the same words told of an earlier reply, by a wait that ended before this one was written, hold nothing back", () => {
  const s = setup();
  sendToThreadForTest(s, "Run the release checks");
  s.runWake(s.release.id, "Done.", "stopped");
  expect(s.notices.map((n) => [n.notice.stop, n.lastReply])).toStrictEqual([["stopped", "Done."]]);
  s.env.store.db.prepare("update global_handoffs set replied_at = ?").run(new Date(Date.now() - 60_000).toISOString());
  userSays(s, "Run them again.");
  s.runWake(s.release.id, "Done.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  // Told, carrying what the user said in that round.
  expect(quiet(s).map((n) => n.lastReply)).toEqual(["Run them again."]);
});

test("what a thread says after it answered the agent's request, with no one's word since, is told as coming after that request, not as the user's round; a decision wakes the agent", () => {
  const s = setup();
  userSays(s, "Look at the rollout.");
  s.runWake(s.release.id, "Looking.", "stopped");
  sendToThreadForTest(s, "Draft the rollout plan");
  s.runWake(s.release.id, "Plan drafted; its workers run on.", "stopped");
  expect(s.notices.map((n) => n.notice.stop)).toStrictEqual(["stopped"]);
  // Woken by its workers, not by anyone's word: the user's older word does not make it theirs.
  s.runWake(s.release.id, "Workers done: the plan is final.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "decision" });
  expect(s.notices.slice(1)).toStrictEqual([{
    globalThreadId: s.global.id,
    notice: { handoffIds: [], kind: "thread", targetThreadId: s.release.id, featureId: null, title: "Docs overhaul", stop: "stopped", reason: null, verdict: "decision", after: true },
    lastReply: "Workers done: the plan is final.",
    route: { kind: "request", key: `thread:${s.release.id}` }
  }]);
});

// A decision is the user's to make. After the agent's request it wakes the
// agent to tell them now, not left to its next step. In the user's own round
// they have it in front of them: told quietly, the agent's to judge.
test("a decision after the agent's request wakes the agent: the notice written with the rest, the wake after it commits", () => {
  const log: string[] = [];
  const s = setup({ recordNotice: (_globalThreadId, notice) => {
    log.push(`recorded ${notice.verdict}`);
    return () => log.push(`woke ${notice.verdict}`);
  } });
  sendToThreadForTest(s, "Draft the rollout plan");
  s.runWake(s.release.id, "Plan drafted; its workers run on.", "stopped");
  expect(log).toEqual(["recorded undefined", "woke undefined"]);
  log.length = 0;
  s.runWake(s.release.id, "Workers done: merge?", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "decision" });
  expect(log).toEqual(["recorded decision", "woke decision"]);
});

test("in the user's own round neither a decision nor a result wakes the agent: both are told quietly", () => {
  const log: string[] = [];
  const s = setup({ recordNotice: (_globalThreadId, notice) => {
    log.push(`recorded ${notice.verdict}`);
    return () => log.push(`woke ${notice.verdict}`);
  } });
  sendToThreadForTest(s, "Draft the thinking override plan");
  s.runWake(s.release.id, "Plan drafted.", "stopped");
  log.length = 0;
  userSays(s, "Which date?");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "decision" });
  userSays(s, "The 19th.");
  s.runWake(s.release.id, "Booked for the 19th.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(log).toEqual([]);
  expect(quiet(s).map((n) => [n.notice.verdict, n.notice.direct, n.route.kind])).toEqual([
    ["decision", true, "note"],
    ["result", true, "note"]
  ]);
});

test("two requests answered, then the user's own round: one quiet notice", () => {
  const s = setup();
  sendToThreadForTest(s, "Draft the rollout plan");
  s.runWake(s.release.id, "Plan drafted.", "stopped");
  sendToThreadForTest(s, "Add the rollback steps");
  s.runWake(s.release.id, "Rollback steps added.", "stopped");
  userSays(s, "Make it one page.");
  s.runWake(s.release.id, "One page now.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s).map((n) => n.lastReply)).toEqual(["Make it one page."]);
});

test("a wait without a message, still open, tells with its own notice: no quiet one", () => {
  let hold = false;
  const s = setup({ stopVerdict: () => (hold ? new Promise<StopVerdict | null>(() => {}) : null) });
  answeredRequest(s);
  hold = true;
  s.stops.delete(s.release.id);
  expect("handoff" in s.service.awaitStop({ globalThreadId: s.global.id, threadId: s.release.id })).toBe(true);
  userSays(s, "Make it one page.");
  s.runWake(s.release.id, "One page now.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s)).toEqual([]);
});

test("a long reply with spaces before it, told by the manager request check, is not told again when the thread then stops on it", () => {
  const s = setup();
  const long = `  Both checked. ${"x".repeat(25_000)}`;
  sendToThreadForTest(s, "Check the release notes");
  s.runWake(s.release.id, long, null);
  s.service.endJudged(s.service.openRequestWaits(s.release.id), "done", long);
  expect(s.notices.map((n) => n.notice.stop)).toStrictEqual(["done"]);
  s.stops.set(s.release.id, "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  expect(quiet(s)).toEqual([]);
});

// Every notice states its kind: what comes after the agent's request is a
// note when it leaves a result, a request when it leaves a decision; the
// wait's end before it, a report.
test("what comes after a request goes up as a note when it leaves a result, as a request when it leaves a decision", () => {
  const recorded: Array<[string | undefined, UpwardRoute]> = [];
  const s = setup({ recordNotice: (_globalThreadId, notice, _lastReply, route) => { recorded.push([notice.verdict, route]); return () => {}; } });
  const [sent] = sendToThreadForTest(s, "Draft the rollout plan");
  s.runWake(s.release.id, "Plan drafted; its workers run on.", "stopped");
  s.runWake(s.release.id, "Workers done: the plan is final.", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "result" });
  s.runWake(s.release.id, "Merge it now?", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "decision" });
  const thread = `thread:${s.release.id}`;
  expect(recorded).toStrictEqual([
    [undefined, { kind: "report", key: `handoff:${sent.id}` }],
    ["decision", { kind: "request", key: thread }]
  ]);
  expect(s.notices.map((n) => [n.notice.verdict, n.notice.after, n.route])).toStrictEqual([["result", true, { kind: "note", key: thread }]]);
});

test("an ended wait's kind follows how its target stopped, keyed on the first wait it ends", () => {
  const notice = (stop: ThreadNotice["stop"]): ThreadNotice => ({
    handoffIds: ["hof_a", "hof_b"], kind: "thread", targetThreadId: "thr_1", featureId: null, title: "Docs overhaul", stop, reason: null
  });
  const key = "handoff:hof_a";
  expect((["needs_you", "failed", "archived", "stopped", "done", "cannot"] as const).map((stop) => endedWaitRoute(notice(stop)))).toStrictEqual([
    { kind: "request", key },
    { kind: "lifecycle", key, lifecycleReason: "failed" },
    { kind: "lifecycle", key, lifecycleReason: "archived" },
    { kind: "report", key },
    { kind: "report", key },
    { kind: "report", key }
  ]);
  // No wait: the thread, or the worker, it is about.
  expect(noticeKey({ ...notice("settled"), handoffIds: [] })).toBe("thread:thr_1");
  expect(noticeKey({ ...notice("asked"), handoffIds: [], kind: "feature", featureId: "feat_1", targetThreadId: "thr_w" })).toBe("feature:feat_1");
});

// A manager's question wakes Your agent only in a round it started; in the
// user's own round the user has it in front of them.
test("a question in a round Your agent started wakes it; in the user's own round, typed or spoken, it is a note marked theirs", () => {
  const s = setup();
  const [sent] = sendToThreadForTest(s, "Fix the eviction order");
  s.service.noteQuestion(s.release.id, PUSH);
  expect(s.notices.map((n) => [n.route, n.notice.direct])).toStrictEqual([[{ kind: "request", key: `handoff:${sent.id}` }, undefined]]);
  userSays(s, "Hold on, I will look at it myself.");
  s.service.noteQuestion(s.release.id, { ...PUSH, id: "q_2" });
  expect(s.notices.slice(1).map((n) => [n.route.kind, n.notice.direct])).toStrictEqual([["note", true]]);
  s.env.agentStore.appendMessage({ threadId: s.release.id, role: "user", source: "voice", content: { type: "text", text: "Use the old flag." } });
  s.service.noteQuestion(s.release.id, { ...PUSH, id: "q_3" });
  expect(s.notices.slice(2).map((n) => [n.route.kind, n.notice.direct])).toStrictEqual([["note", true]]);
  // Your agent's word again: its round, a request.
  sendToThreadForTest(s, "And the release notes?");
  s.service.noteQuestion(s.release.id, { ...PUSH, id: "q_4" });
  expect(s.notices.slice(3).map((n) => [n.route.kind, n.notice.direct])).toStrictEqual([["request", undefined]]);
});

// The user's round is one they started — they said something since the
// manager's previous turn, and Your agent relayed nothing after them. A later
// turn something else woke (a worker, an alarm) is not theirs, however recent
// their last word.
test("a question in a later turn the user did not start goes to Your agent; one in the turn they started stays theirs", () => {
  const s = setup();
  const [sent] = sendToThreadForTest(s, "Fix the eviction order");
  userSays(s, "Use the new flag.");
  s.runWake(s.release.id, "Noted; the workers carry on.", null);
  // A worker's report wakes the manager, and in that turn it asks the user.
  const later = s.env.agentStore.createWake({ threadId: s.release.id, reason: "worker-report", triggerMessageId: null });
  s.service.noteQuestion(s.release.id, PUSH);
  expect(s.notices.map((n) => [n.route, n.notice.direct])).toStrictEqual([[{ kind: "request", key: `handoff:${sent.id}` }, undefined]]);
  // The user writes during that turn: from then on it is theirs, though the
  // manager's own step that asks comes after their word in the same turn.
  userSays(s, "Hold the push.");
  s.env.agentStore.appendMessage({
    threadId: s.release.id, role: "assistant", source: "self", wakeId: later.id,
    content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "call_ask", toolName: "ask_user", args: { question: PUSH.question } }] }
  });
  s.service.noteQuestion(s.release.id, { ...PUSH, id: "q_2" });
  expect(s.notices.slice(1).map((n) => [n.route.kind, n.notice.direct])).toStrictEqual([["note", true]]);
  s.env.agentStore.finishWake(later.id, "finished", null);
});

test("a round a worker woke after the user's own round is told as after Your agent's request: a decision there wakes it", () => {
  const s = setup();
  sendToThreadForTest(s, "Draft the rollout plan");
  s.runWake(s.release.id, "Plan drafted.", "stopped");
  userSays(s, "Which date?");
  s.runWake(s.release.id, "The 12th or the 19th?", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "decision" });
  expect(quiet(s).map((n) => [n.notice.direct, n.notice.after, n.route.kind])).toStrictEqual([[true, undefined, "note"]]);
  // No one's word since: its workers woke it.
  s.runWake(s.release.id, "Workers done: merge the branch?", "stopped");
  s.service.noteVerdict(s.release.id, { replySeq: latestSeq(s), outcome: "decision" });
  expect(quiet(s).slice(1).map((n) => [n.notice.direct, n.notice.after, n.route.kind, n.lastReply])).toStrictEqual([[undefined, true, "request", "Workers done: merge the branch?"]]);
});

test("a wait that ends needing the user, in a round the user started, is a note marked theirs; in Your agent's round, a request", () => {
  const s = setup();
  const [mine] = sendToThreadForTest(s, "Fix the eviction order");
  s.runWake(s.release.id, "Fixed? Ship it or wait for review?", "needs_you");
  expect(s.notices.map((n) => [n.notice.stop, n.notice.direct, n.route])).toStrictEqual([["needs_you", undefined, { kind: "request", key: `handoff:${mine.id}` }]]);
  const [second] = sendToThreadForTest(s, "And the release notes?");
  userSays(s, "I am here: let me look at the notes myself.");
  s.runWake(s.release.id, "Notes drafted. Publish them now?", "needs_you");
  expect(s.notices.slice(1).map((n) => [n.notice.stop, n.notice.direct, n.route, n.lastReply])).toStrictEqual([
    ["needs_you", true, { kind: "note", key: `handoff:${second.id}` }, "Notes drafted. Publish them now?"]
  ]);
  expect(s.service.dto(second.id)).toMatchObject({ state: "replied", stop: "needs_you" });
});
