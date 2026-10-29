import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, seedFeature, seedProject, type StoresEnv } from "./helpers/fixtures.js";
import { createManagerStopCheck } from "../src/server/modules/manager-checks/stop/manager-stop-check.js";
import { createManagerStopCheckStore } from "../src/server/modules/manager-checks/stop/store.js";
import type { JudgementCandidate, JudgementInput, JudgementNotUsed } from "../src/server/modules/manager-checks/judge.js";
import type { StopVerdict, ThreadStop } from "../src/shared/thread-dot.js";
import { stub } from "./helpers/typed.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const CANDIDATE = stub<JudgementCandidate>({ kind: "chat" });

/** A manager thread with the user's message and the manager's reply to it,
 *  and a manager stop check whose judge answers as told. */
function setup(opts: { verdict?: StopVerdict | null; stop?: ThreadStop | null; candidates?: JudgementCandidate[]; on?: () => boolean } = {}) {
  env = freshStoresEnv("md-stop-check-");
  const e = env;
  const thread = e.agentStore.createManagerThread("Release");
  e.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date" } });
  const reply = e.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Two dates are free: the 12th or the 19th?" } });
  const calls: JudgementInput[] = [];
  const verdicts: Array<{ threadId: string; replySeq: number; outcome: StopVerdict }> = [];
  /** Each answer not acted on: the reply it was about, and why. */
  const notUsed: Array<[number, JudgementNotUsed]> = [];
  const stops = new Map<string, ThreadStop | null>();
  let answer: (input: JudgementInput) => Promise<StopVerdict | null> =
    async () => (opts.verdict === undefined ? "decision" : opts.verdict);
  const store = createManagerStopCheckStore(e.store.db);
  const make = () => createManagerStopCheck({
    agentStore: e.agentStore,
    featuresStore: e.features,
    store: createManagerStopCheckStore(e.store.db),
    stopOf: (threadId) => (stops.has(threadId) ? stops.get(threadId)! : opts.stop === undefined ? "stopped" : opts.stop),
    candidates: () => opts.candidates ?? [CANDIDATE],
    judge: async (_candidates, input) => {
      calls.push(input);
      const outcome = await answer(input);
      return outcome === null ? null : { answer: outcome, notUsed: (reason) => { notUsed.push([input.subject.replySeq, reason]); } };
    },
    onVerdict: (threadId, verdict) => { verdicts.push({ threadId, ...verdict }); },
    ...(opts.on ? { on: opts.on } : {})
  });
  const check = make();
  return { e, thread, reply, calls, verdicts, notUsed, stops, store, check, make, setAnswer: (fn: typeof answer) => { answer = fn; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("a stopped thread's latest reply is judged once and stored, then the status is told", async () => {
  const s = setup();
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect(s.calls.map((c) => c.threadId)).toStrictEqual([s.thread.id]);
  expect(s.calls[0]!.context).toContain("Pick the release date");
  expect(s.calls[0]!.subject).toEqual({ replySeq: s.reply.seq, replyAt: s.reply.createdAt });
  expect(s.notUsed).toStrictEqual([]);
  expect(s.store.get(s.thread.id)).toMatchObject({ replySeq: s.reply.seq, outcome: "decision" });
  // Told what was judged and found: what Your agent may hear of it.
  expect(s.verdicts).toStrictEqual([{ threadId: s.thread.id, replySeq: s.reply.seq, outcome: "decision" }]);
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect(s.calls.length).toBe(1);
});

test("a working, failed or asking thread is not judged", async () => {
  for (const stop of [null, "failed", "needs_you"] as const) {
    const s = setup({ stop });
    s.check.noteSettled(s.thread.id);
    await s.check.idle();
    expect([stop, s.calls.length, s.store.get(s.thread.id)]).toEqual([stop, 0, null]);
    env?.cleanup(); env = null;
  }
});

test("a worker settling judges its owner thread; a worker with none, nothing", async () => {
  const s = setup();
  const projectId = seedProject(s.e.projects);
  const owned = seedFeature(s.e.features, projectId, { name: "dates", tmuxWindowName: "dates", ownerThreadId: s.thread.id });
  const loose = seedFeature(s.e.features, projectId, { name: "loose", tmuxWindowName: "loose" });
  s.check.noteSettled(s.e.agentStore.getOrCreateThread("worker", loose).id);
  await s.check.idle();
  expect(s.calls.length).toBe(0);
  s.check.noteSettled(s.e.agentStore.getOrCreateThread("worker", owned).id);
  await s.check.idle();
  expect(s.calls.map((c) => c.threadId)).toStrictEqual([s.thread.id]);
});

test("a reply older than the latest message from the user or Your agent is not judged", async () => {
  const s = setup();
  s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "user", content: { type: "text", text: "Hold on", relay: { by: "global", spoken: false, handoffId: "hof_1", name: "Juno" } } });
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect(s.calls.length).toBe(0);
});

test("no candidates, no call", async () => {
  const s = setup({ candidates: [] });
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect([s.calls.length, s.store.get(s.thread.id)]).toEqual([0, null]);
});

test("a failed judgement stores nothing, tells nobody, and is tried at the next stop", async () => {
  const s = setup({ verdict: null });
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect([s.store.get(s.thread.id), s.verdicts]).toEqual([null, []]);
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect(s.calls.length).toBe(2);
});

test("a stored verdict survives a restart and is not judged again; it shows while the reply is unread", async () => {
  const s = setup();
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  const after = s.make();
  after.noteSettled(s.thread.id);
  await after.idle();
  expect(s.calls.length).toBe(1);
  expect(after.current(s.thread.id)).toEqual({ verdict: "decision", replySeq: s.reply.seq, replyText: "Two dates are free: the 12th or the 19th?" });
});

test("nothing is current for a verdict of nothing, or before one is stored", async () => {
  const s = setup({ verdict: "nothing" });
  expect(s.check.current(s.thread.id)).toBeNull();
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect([s.store.get(s.thread.id)?.outcome, s.check.current(s.thread.id)]).toEqual(["nothing", null]);
});

test("a verdict on a reply already read is not current", async () => {
  const s = setup();
  const pending = deferred<StopVerdict | null>();
  s.setAnswer(() => pending.promise);
  s.check.noteSettled(s.thread.id);
  s.e.agentStore.markThreadSeen(s.thread.id, s.reply.seq);
  pending.resolve("result");
  await s.check.idle();
  expect([s.store.get(s.thread.id)?.outcome, s.check.current(s.thread.id)]).toEqual(["result", null]);
});

test("a message from the user or Your agent after the reply ends it", async () => {
  for (const relay of [undefined, { by: "global" as const, spoken: false, handoffId: "hof_2", name: "Juno" }]) {
    const s = setup();
    s.check.noteSettled(s.thread.id);
    await s.check.idle();
    expect(s.check.current(s.thread.id)?.verdict).toBe("decision");
    s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "user", content: { type: "text", text: "The 19th", ...(relay ? { relay } : {}) } });
    expect(s.check.current(s.thread.id)).toBeNull();
    env?.cleanup(); env = null;
  }
});

test("a newer reply leaves the old verdict behind; an archived thread has none", async () => {
  const s = setup();
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Also: the changelog is drafted." } });
  expect(s.check.current(s.thread.id)).toBeNull();
  const t = setup();
  t.check.noteSettled(t.thread.id);
  await t.check.idle();
  t.e.agentStore.archiveThread(t.thread.id);
  expect(t.check.current(t.thread.id)).toBeNull();
});

test("the reply's text in a current verdict is cut to 600 characters", async () => {
  const s = setup();
  const long = s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "x".repeat(900) } });
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect([s.check.current(s.thread.id)?.replySeq, s.check.current(s.thread.id)?.replyText.length]).toEqual([long.seq, 600]);
});

test("verdictFor: a stored one at once; one in flight joined; null after the wait, or with nothing to judge", async () => {
  const s = setup();
  const pending = deferred<StopVerdict | null>();
  s.setAnswer(() => pending.promise);
  const first = s.check.verdictFor(s.thread.id, 5000);
  const joined = s.check.verdictFor(s.thread.id, 5000);
  expect(s.calls.length).toBe(1);
  pending.resolve("decision");
  expect([await first, await joined]).toEqual(["decision", "decision"]);
  // Stored: at once, and no call.
  expect(await s.check.verdictFor(s.thread.id, 0)).toBe("decision");
  expect(s.calls.length).toBe(1);
  // A judge that does not answer in time: null.
  const t = setup();
  t.setAnswer(() => new Promise(() => {}));
  expect(await t.check.verdictFor(t.thread.id, 10)).toBeNull();
  // Nothing to judge: no promise at all.
  const u = setup({ candidates: [] });
  expect(u.check.verdictFor(u.thread.id, 10)).toBeNull();
});

test("a judgement of an older reply that ends late does not replace the newer reply's verdict", async () => {
  const s = setup();
  const older = deferred<StopVerdict | null>();
  s.setAnswer(() => older.promise);
  s.check.noteSettled(s.thread.id);
  const newer = s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Booked the 19th." } });
  s.setAnswer(async () => "result");
  s.check.noteSettled(s.thread.id);
  older.resolve("decision");
  await s.check.idle();
  expect(s.store.get(s.thread.id)).toMatchObject({ replySeq: newer.seq, outcome: "result" });
  expect(s.check.current(s.thread.id)?.verdict).toBe("result");
  expect(s.notUsed).toStrictEqual([[s.reply.seq, "newer_verdict"]]);
});

// A turn that answers a worker's report with tool calls and no words leaves
// the earlier reply latest: what came after it is part of what is judged.
test("what happened after the reply that is judged is in its context, and the reply once", async () => {
  const s = setup();
  s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "worker-report", content: { type: "text", text: "[Worker report] the 19th is taken" } });
  s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [{ toolCallId: "c1", toolName: "read_plan", args: { featureId: "feat_1" } }] } });
  s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c1", toolName: "read_plan", result: { ok: true } } });
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  const context = s.calls[0]!.context;
  expect(context).toContain("Worker report: [Worker report] the 19th is taken");
  expect(context).toContain("Manager called read_plan(");
  expect(context.split("Two dates are free: the 12th or the 19th?").length - 1).toBe(1);
});

// A delete waits on the work a thread still has; a judgement it outlives
// leaves nothing behind.
test("a thread is at work while its manager stop check runs; a verdict that lands after it is archived is not kept", async () => {
  const s = setup();
  const pending = deferred<StopVerdict | null>();
  s.setAnswer(() => pending.promise);
  s.check.noteSettled(s.thread.id);
  expect(s.check.judging(s.thread.id)).toBe(true);
  s.e.agentStore.archiveThread(s.thread.id);
  pending.resolve("decision");
  await s.check.idle();
  expect([s.check.judging(s.thread.id), s.store.get(s.thread.id), s.verdicts]).toEqual([false, null, []]);
  expect(s.notUsed).toStrictEqual([[s.reply.seq, "archived"]]);
});

test("a thread is at work until every judgement of it has ended, an older one outliving a newer one", async () => {
  const s = setup();
  const older = deferred<StopVerdict | null>();
  s.setAnswer(() => older.promise);
  s.check.noteSettled(s.thread.id);
  s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Booked the 19th." } });
  s.setAnswer(async () => "result");
  s.check.noteSettled(s.thread.id);
  await new Promise((r) => setTimeout(r, 0));
  // The newer one ended; the older one still runs.
  expect(s.check.judging(s.thread.id)).toBe(true);
  older.resolve("decision");
  await s.check.idle();
  expect(s.check.judging(s.thread.id)).toBe(false);
});

// Read on every status snapshot: a thread that has not changed is not read
// again, and one that has is.
test("current() reads a thread's history again only once something was added to it", async () => {
  const s = setup();
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  let reads = 0;
  const latestReply = s.e.agentStore.latestReply.bind(s.e.agentStore);
  s.e.agentStore.latestReply = (threadId: string) => { reads++; return latestReply(threadId); };
  for (let i = 0; i < 3; i++) expect(s.check.current(s.thread.id)?.verdict).toBe("decision");
  expect(reads).toBe(1);
  s.e.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "user", content: { type: "text", text: "The 19th" } });
  expect(s.check.current(s.thread.id)).toBeNull();
  expect(reads).toBe(2);
});

// Off, the manager stop check is as if it were not there: a verdict it stored while
// on does not show, and shows again once it is on.
test("with the manager stop check off a stored verdict does not show", async () => {
  let on = true;
  const s = setup({ on: () => on });
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  expect(s.check.current(s.thread.id)?.verdict).toBe("decision");
  on = false;
  expect(s.check.current(s.thread.id)).toBeNull();
  on = true;
  expect(s.check.current(s.thread.id)?.verdict).toBe("decision");
});

// Read for open threads only: what it kept of a thread goes when the thread
// is put away; past a bound, the threads no longer open go, and the open
// ones (every snapshot reads them) stay, however many they are.
test("what current() keeps of a thread goes when the thread is forgotten; past the bound, only closed threads are dropped", async () => {
  const s = setup();
  s.check.noteSettled(s.thread.id);
  await s.check.idle();
  let reads = 0;
  const latestReply = s.e.agentStore.latestReply.bind(s.e.agentStore);
  s.e.agentStore.latestReply = (threadId: string) => { reads++; return latestReply(threadId); };
  s.check.current(s.thread.id);
  s.check.forget(s.thread.id);
  s.check.current(s.thread.id);
  expect([reads, s.check.kept()]).toEqual([2, 1]);
  s.check.forget(s.thread.id);
  expect(s.check.kept()).toBe(0);
  // Many open threads with verdicts, read on every snapshot in the same order.
  const others = Array.from({ length: 1005 }, (_, i) => `thr_other_${i}`);
  for (const id of others) s.store.set(id, { replySeq: 2, outcome: "decision", judgedAt: "2026-10-22T10:00:00.000Z" });
  const closed = new Set<string>();
  const getThreadById = s.e.agentStore.getThreadById.bind(s.e.agentStore);
  s.e.agentStore.getThreadById = (id: string) => (id.startsWith("thr_other_")
    ? { ...getThreadById(s.thread.id)!, id, seenSeq: 0, archivedAt: closed.has(id) ? "2026-10-22T11:00:00.000Z" : null }
    : getThreadById(id));
  for (const id of others) s.check.current(id);
  reads = 0;
  for (const id of others) s.check.current(id);
  expect([reads, s.check.kept()]).toEqual([0, 1005]);
  // Archived without being forgotten: dropped once more threads are kept.
  for (const id of others.slice(0, 600)) closed.add(id);
  const more = Array.from({ length: 1100 }, (_, i) => `thr_other_more_${i}`);
  for (const id of more) s.store.set(id, { replySeq: 2, outcome: "decision", judgedAt: "2026-10-22T10:00:00.000Z" });
  for (const id of more) s.check.current(id);
  expect(s.check.kept()).toBe(405 + 1100);
});
