import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { TaskBoardService } from "../src/server/modules/task-board/task-board-service.js";
import { createTaskNotices } from "../src/server/modules/task-board/task-notices.js";
import { threadNoticeOf } from "../src/shared/thread-notice.js";
import type { StopVerdict, ThreadStop } from "../src/shared/thread-dot.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

interface Posted { to: string; key: string; kind: string; source: string; content: { text: string; metadata?: Record<string, unknown> } }

function setup(prefix: string) {
  env = freshStoresEnv(prefix);
  // Set up before the wake the reminder tests say started (09:00).
  let now = Date.parse("2026-11-09T08:00:00.000Z");
  const board = new TaskBoardService({ db: env.store.db, agentStore: env.agentStore, sse: { emit: () => {} } as never, threadDots: () => new Map(), now: () => now });
  const posts: Posted[] = [];
  let woken = 0;
  const stops = new Map<string, ThreadStop>();
  const waiting = new Set<string>();
  const asking = new Set<string>();
  const present = new Set<string>();
  // The stop check's answer for a thread that stopped: a judgement under way
  // (never answered unless a test says), or none to wait for (the check off).
  let verdict: () => Promise<StopVerdict | null> | null = () => new Promise(() => {});
  let refuse = 0;
  const db = env.store.db;
  const notices = createTaskNotices({
    taskBoard: board,
    agentStore: env.agentStore,
    workersStore: env.workers,
    inbox: { post: (m) => {
      if (refuse > 0) { refuse--; throw new Error("database is locked"); }
      posts.push(m as never);
      return { wake: () => { if (m.kind !== "note") woken++; } } as never;
    } },
    stopOf: (id) => stops.get(id) ?? null,
    hasOpenWait: (id) => waiting.has(id),
    isDutyThread: () => false,
    asksUser: (id) => asking.has(id),
    ownerInThread: (id) => present.has(id),
    stopVerdict: () => verdict(),
    transaction: (work) => db.transaction(work).immediate(),
  });
  const thread = env.agentStore.createManagerThread("Catalogue search source");
  const task = board.create({ title: "Book data from one source" }, "owner");
  board.link(task.id, thread.id);
  // A verdict comes for a thread that stopped.
  stops.set(thread.id, "stopped");
  const reply = (text: string) => env!.agentStore.appendMessage({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text } });
  const ownerSays = (text: string) => env!.agentStore.appendMessage({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text } });
  return {
    env, board, notices, posts, woken: () => woken, stops, waiting, asking, present, thread, task, reply, ownerSays,
    setNow: (iso: string) => { now = Date.parse(iso); },
    setVerdict: (next: () => Promise<StopVerdict | null> | null) => { verdict = next; },
    refuseNext: () => { refuse++; }
  };
}

test("a linked thread's result wakes the agent, naming the task", () => {
  const s = setup("md-tn-result-");
  const r = s.reply("Picked Atlas + grove.example.");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "result" });
  expect(s.posts).toHaveLength(1);
  expect(s.posts[0]).toMatchObject({ key: `thread:${s.thread.id}`, kind: "report", source: "thread-notice" });
  expect(s.posts[0]!.content.text).toContain(`Linked to task: "Book data from one source" (${s.task.id})`);
  expect(threadNoticeOf(s.posts[0]!.content as never)?.tasks).toEqual([{ id: s.task.id, title: "Book data from one source" }]);
  expect(s.woken()).toBe(1);
});

// The owner's own round is not told on its own: their direct chat is, once
// it went quiet (direct-chats).
test("a result or a decision in the owner's own round is not told", () => {
  const s = setup("md-tn-own-");
  s.ownerSays("Compare three catalogues.");
  const r = s.reply("Done: Atlas covers 92%.");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "result" });
  s.ownerSays("Which one?");
  const d = s.reply("Atlas or grove.example?");
  s.notices.noteVerdict(s.thread.id, { replySeq: d.seq, outcome: "decision" });
  expect(s.posts).toEqual([]);
  // A round no one's word started, after it: told.
  const later = s.reply("Also checked the docs.");
  s.notices.noteVerdict(s.thread.id, { replySeq: later.seq, outcome: "result" });
  expect(s.posts.map((p) => p.kind)).toEqual(["report"]);
});

test("a failure wakes", () => {
  const s = setup("md-tn-failed-");
  s.reply("Trying the provider.");
  s.stops.set(s.thread.id, "failed");
  s.notices.noteSettled(s.thread.id);
  expect(s.posts.map((p) => [p.kind, p.source])).toEqual([["lifecycle", "thread-notice"]]);
  expect(s.woken()).toBe(1);
  // Told once.
  s.notices.noteSettled(s.thread.id);
  expect(s.posts).toHaveLength(1);
});

test("a decision or needs-you stop is a note", () => {
  const s = setup("md-tn-quiet-");
  const r = s.reply("Two options: keep or drop.");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "decision" });
  s.reply("Which one?");
  s.stops.set(s.thread.id, "needs_you");
  s.notices.noteSettled(s.thread.id);
  expect(s.posts.map((p) => p.kind)).toEqual(["note", "note"]);
  expect(s.woken()).toBe(0);
});

// A "nothing" stop is told as a quiet note too.
test("a stop that leaves nothing for the user is a quiet note; each reply told once", () => {
  const s = setup("md-tn-once-");
  const r = s.reply("Still reading.");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "nothing" });
  expect(s.posts.map((p) => p.kind)).toEqual(["note"]);
  expect(threadNoticeOf(s.posts[0]!.content as never)?.verdict).toBe("nothing");
  expect(s.woken()).toBe(0);
  const done = s.reply("Done.");
  s.notices.noteVerdict(s.thread.id, { replySeq: done.seq, outcome: "result" });
  s.notices.noteVerdict(s.thread.id, { replySeq: done.seq, outcome: "result" });
  expect(s.posts).toHaveLength(2);
});

// A stop the check gives no verdict on (every model failed, or too slow)
// still reaches the agent, as a note; with the check off, at once.
test("a stop with no verdict is a quiet note: when the check gives none, and at once with it off", async () => {
  const s = setup("md-tn-noverdict-");
  s.reply("Done, maybe.");
  s.setVerdict(() => Promise.resolve(null));
  s.notices.noteSettled(s.thread.id);
  expect(s.posts).toEqual([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(s.posts.map((p) => p.kind)).toEqual(["note"]);
  expect(threadNoticeOf(s.posts[0]!.content as never)?.verdict).toBeUndefined();
  // The check off: no judgement to wait for.
  s.reply("And another.");
  s.setVerdict(() => null);
  s.notices.noteSettled(s.thread.id);
  expect(s.posts).toHaveLength(2);
  // A verdict on the way: it tells, not this.
  s.reply("Third.");
  s.setVerdict(() => Promise.resolve("result"));
  s.notices.noteSettled(s.thread.id);
  await Promise.resolve();
  await Promise.resolve();
  expect(s.posts).toHaveLength(2);
});

// The mark and the notice go together: a notice refused leaves the reply
// untold, for the next try.
test("a notice refused leaves the reply to tell again", () => {
  const s = setup("md-tn-refused-");
  const r = s.reply("Done.");
  s.refuseNext();
  expect(() => s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "result" })).toThrow("database is locked");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "result" });
  expect(s.posts.map((p) => p.kind)).toEqual(["report"]);
});

// A manager's question already reaches the agent (the hand-off's question
// notice, naming the task); its needs-you stop adds nothing.
test("a needs-you stop on a question is left to the question's notice", () => {
  const s = setup("md-tn-question-");
  s.reply("Which source?");
  s.stops.set(s.thread.id, "needs_you");
  s.asking.add(s.thread.id);
  s.notices.noteSettled(s.thread.id);
  expect(s.posts).toEqual([]);
  // Held back by the tool-call review, no question: a note.
  s.asking.delete(s.thread.id);
  s.notices.noteSettled(s.thread.id);
  expect(s.posts.map((p) => p.kind)).toEqual(["note"]);
});

test("a thread with an open hand-off wait is left to the hand-off", () => {
  const s = setup("md-tn-handoff-");
  s.waiting.add(s.thread.id);
  const r = s.reply("Done.");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "result" });
  s.stops.set(s.thread.id, "failed");
  s.notices.noteSettled(s.thread.id);
  expect(s.posts).toEqual([]);
});

// What the hand-off told is not told again (a wait that just ended with this
// stop); what it did not tell is (a failure after a request it already
// answered).
test("a stop the hand-off told is not told again; a later one is", () => {
  const s = setup("md-tn-told-");
  s.reply("Trying the provider.");
  s.stops.set(s.thread.id, "failed");
  s.notices.toldByHandoff(s.thread.id);
  s.notices.noteSettled(s.thread.id);
  expect(s.posts).toEqual([]);
  s.ownerSays("Try again.");
  s.reply("Failed again.");
  s.notices.noteSettled(s.thread.id);
  expect(s.posts.map((p) => p.kind)).toEqual(["lifecycle"]);
});

test("a thread with no open task is left to today's rules", () => {
  const s = setup("md-tn-none-");
  const other = s.env.agentStore.createManagerThread("Unlinked");
  s.env.agentStore.appendMessage({ threadId: other.id, role: "assistant", source: "self", content: { type: "assistant", text: "Done." } });
  s.notices.noteVerdict(other.id, { replySeq: s.env.agentStore.latestReply(other.id)!.seq, outcome: "result" });
  s.board.setStatus(s.task.id, "done", "owner");
  const r = s.reply("Done.");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "result" });
  expect(s.posts).toEqual([]);
});

test("a deleted task is not named", () => {
  const s = setup("md-tn-deleted-");
  const second = s.board.create({ title: "Gone task" }, "owner");
  s.board.link(second.id, s.thread.id);
  s.board.remove(second.id);
  const r = s.reply("Done.");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "result" });
  expect(threadNoticeOf(s.posts[0]!.content as never)?.tasks).toEqual([{ id: s.task.id, title: "Book data from one source" }]);
});

// The owner in the thread now (a window in use shows it): its stop is in
// front of them, as in their own round.
test("a stop while the owner is in the thread is not told", () => {
  const s = setup("md-tn-present-");
  s.present.add(s.thread.id);
  const r = s.reply("Done: Atlas covers 92%.");
  s.notices.noteVerdict(s.thread.id, { replySeq: r.seq, outcome: "result" });
  expect(s.posts).toEqual([]);
  s.present.delete(s.thread.id);
  const later = s.reply("Also checked the docs.");
  s.notices.noteVerdict(s.thread.id, { replySeq: later.seq, outcome: "result" });
  expect(s.posts.map((p) => p.kind)).toEqual(["report"]);
});
