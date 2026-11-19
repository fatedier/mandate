import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { createDirectChats, DIRECT_CHAT_QUIET_MS } from "../src/server/modules/personal/direct-chats.js";
import type { StopVerdict, ThreadStop } from "../src/shared/thread-dot.js";
import type { ThreadNotice } from "../src/shared/thread-notice.js";
import { parseCut } from "./helpers/cut-line.js";
import { controlMetadata } from "../src/shared/questions.js";

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const T0 = Date.parse("2026-11-17T10:00:00.000Z");
const MIN = 60_000;

function setup(opts: { tasksOf?: (threadId: string) => Array<{ id: string; title: string }> } = {}) {
  env = freshStoresEnv("md-direct-chats-");
  const stops = new Map<string, ThreadStop>();
  const duty = new Set<string>();
  const posts: Array<{ personalThreadId: string; notice: ThreadNotice; lastReply: string | null }> = [];
  let woken = 0;
  let refuse = 0;
  let verdict: () => Promise<StopVerdict | null> | null = () => null;
  const state = { now: T0 };
  const personal = env.agentStore.getOrCreatePersonalThread();
  const thread = env.agentStore.createManagerThread("Video migration");
  const build = () => createDirectChats({
    db: env!.store.db,
    agentStore: env!.agentStore,
    isDutyThread: (id) => duty.has(id),
    stopOf: (id) => stops.get(id) ?? null,
    verdictOf: () => verdict(),
    ...(opts.tasksOf ? { tasksOf: opts.tasksOf } : {}),
    post: (personalThreadId, notice, lastReply) => {
      if (refuse > 0) { refuse--; throw new Error("database is locked"); }
      posts.push({ personalThreadId, notice, lastReply });
      return () => { woken++; };
    },
    now: () => state.now
  });
  const at = (id: string, ms: number) => env!.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(ms).toISOString(), id);
  /** The user's own words in `threadId`, written at `ms`. */
  const ownerSays = (text: string, ms: number, threadId = thread.id) => {
    const m = env!.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text } });
    at(m.id, ms);
    return { ...m, createdAt: new Date(ms).toISOString() };
  };
  const reply = (text: string, ms: number, threadId = thread.id) => {
    const m = env!.agentStore.appendMessage({ threadId, role: "assistant", source: "self", content: { type: "assistant", text, toolCalls: [] } });
    at(m.id, ms);
    return m;
  };
  return Object.assign(state, {
    env, personal, thread, stops, duty, posts, build, ownerSays, reply,
    woken: () => woken,
    refuseNext: () => { refuse++; },
    setVerdict: (next: () => Promise<StopVerdict | null> | null) => { verdict = next; }
  });
}

test("a direct chat is told once, 15 minutes after the user's last word there, once the thread has stopped; it wakes the agent", async () => {
  const s = setup();
  const jobs = s.build();
  const first = s.ownerSays("Shorter, please.", T0);
  s.reply("Shorter now.", T0 + MIN);
  const last = s.ownerSays("Ship it.", T0 + 4 * MIN);
  s.reply("Shipped behind the flag.", T0 + 5 * MIN);
  s.stops.set(s.thread.id, "stopped");
  s.now = T0 + 4 * MIN + DIRECT_CHAT_QUIET_MS - 1;
  await jobs.tick();
  expect(s.posts).toEqual([]);
  s.now = T0 + 4 * MIN + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts).toStrictEqual([{
    personalThreadId: s.personal.id,
    notice: {
      handoffIds: [], kind: "thread", targetThreadId: s.thread.id, workerId: null, title: "Video migration", stop: "chat", reason: null,
      chat: { from: first.createdAt, to: last.createdAt, messages: 2 }, words: "Shorter, please.\n\nShip it."
    },
    lastReply: "Shipped behind the flag."
  }]);
  expect(s.woken()).toBe(1);
  s.now += 10 * MIN;
  await jobs.tick();
  expect(s.posts).toHaveLength(1);
});

test("a thread still working is told once it stops; a word within 15 minutes starts the wait again, and the chat is told whole", async () => {
  const s = setup();
  const jobs = s.build();
  s.ownerSays("Run the migration.", T0);
  s.now = T0 + 20 * MIN;
  await jobs.tick();
  expect(s.posts).toEqual([]);
  // Back before it stopped: their last word counts from here.
  const last = s.ownerSays("And the rollback?", T0 + 21 * MIN);
  s.reply("Both done.", T0 + 25 * MIN);
  s.stops.set(s.thread.id, "stopped");
  s.now = T0 + 30 * MIN;
  await jobs.tick();
  expect(s.posts).toEqual([]);
  s.now = T0 + 21 * MIN + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts.map((p) => [p.notice.chat, p.notice.words, p.lastReply])).toStrictEqual([
    [{ from: new Date(T0).toISOString(), to: last.createdAt, messages: 2 }, "Run the migration.\n\nAnd the rollback?", "Both done."]
  ]);
});

test("what the user says after a chat was told is a chat of its own", async () => {
  const s = setup();
  const jobs = s.build();
  s.stops.set(s.thread.id, "stopped");
  s.ownerSays("First.", T0);
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  const later = s.ownerSays("Second.", T0 + 60 * MIN);
  s.now = T0 + 60 * MIN + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts.map((p) => [p.notice.chat, p.notice.words])).toStrictEqual([
    [{ from: new Date(T0).toISOString(), to: new Date(T0).toISOString(), messages: 1 }, "First."],
    [{ from: later.createdAt, to: later.createdAt, messages: 1 }, "Second."]
  ]);
});

test("nothing is told of words the agent passed on, a duty thread, an archived thread, words over six hours old, or without the agent's conversation", async () => {
  const s = setup();
  const jobs = s.build();
  s.stops.set(s.thread.id, "stopped");
  const relayed = s.env.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "user", content: { type: "text", text: "Ship it.", relay: { by: "personal", spoken: false, handoffId: "hof_1", name: "Atlas" } } });
  s.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(T0).toISOString(), relayed.id);
  const duty = s.env.agentStore.createManagerThread("Nightly check");
  s.duty.add(duty.id);
  s.stops.set(duty.id, "stopped");
  s.ownerSays("Check again.", T0, duty.id);
  const archived = s.env.agentStore.createManagerThread("Old work");
  s.stops.set(archived.id, "stopped");
  s.ownerSays("Done?", T0, archived.id);
  s.env.agentStore.archiveThread(archived.id);
  const old = s.env.agentStore.createManagerThread("Yesterday");
  s.stops.set(old.id, "stopped");
  s.ownerSays("Any news?", T0 - 6 * 60 * MIN - 1);
  s.ownerSays("Any news?", T0 - 6 * 60 * MIN - 1, old.id);
  // The user's own words in the agent's conversation are no direct chat.
  s.ownerSays("Hello.", T0, s.personal.id);
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts).toEqual([]);
  // A chat in the open with no conversation to tell: it waits for none.
  const open = s.env.agentStore.createManagerThread("Open");
  s.stops.set(open.id, "stopped");
  s.ownerSays("Go.", T0, open.id);
  s.env.agentStore.archiveThread(s.personal.id);
  await jobs.tick();
  expect(s.posts).toEqual([]);
});

test("a decision the thread waits for is carried, as the stop check judged its latest reply; a result is not", async () => {
  const s = setup();
  const jobs = s.build();
  s.stops.set(s.thread.id, "stopped");
  s.ownerSays("Which date?", T0);
  s.reply("The 12th or the 19th?", T0 + MIN);
  s.setVerdict(() => Promise.resolve("decision"));
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts.map((p) => p.notice.verdict)).toEqual(["decision"]);
  s.ownerSays("The 19th.", T0 + 30 * MIN);
  s.reply("Booked.", T0 + 31 * MIN);
  s.setVerdict(() => Promise.resolve("result"));
  s.now = T0 + 30 * MIN + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts.map((p) => p.notice.verdict)).toEqual(["decision", undefined]);
});

test("told once across a restart, and a post refused is told on the next round", async () => {
  const s = setup();
  s.stops.set(s.thread.id, "stopped");
  s.ownerSays("Ship it.", T0);
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  s.refuseNext();
  await s.build().tick();
  expect(s.posts).toEqual([]);
  await s.build().tick();
  expect(s.posts).toHaveLength(1);
  await s.build().tick();
  expect(s.posts).toHaveLength(1);
});

test("two rounds at once tell a chat once", async () => {
  const s = setup();
  const jobs = s.build();
  s.stops.set(s.thread.id, "stopped");
  s.ownerSays("Ship it.", T0);
  let answer: (verdict: StopVerdict | null) => void = () => {};
  s.setVerdict(() => new Promise((resolve) => { answer = resolve; }));
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  const one = jobs.tick();
  const two = jobs.tick();
  answer(null);
  await Promise.all([one, two]);
  expect(s.posts).toHaveLength(1);
});

test("what the user said and the reply are cut at 1,500 characters, the whole saved; the thread's tasks are named", async () => {
  let threadId = "";
  const s = setup({ tasksOf: (id) => (id === threadId ? [{ id: "tsk_video", title: "Video migration" }] : []) });
  threadId = s.thread.id;
  const jobs = s.build();
  s.stops.set(s.thread.id, "stopped");
  const said = `Long brief. ${"x".repeat(2000)}`;
  const answer = `Long answer. ${"y".repeat(2000)}`;
  s.ownerSays(said, T0);
  s.reply(answer, T0 + MIN);
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  const [post] = s.posts;
  expect(parseCut(post!.notice.words!)).toEqual({ kept: said.slice(0, 1500), first: 1500, of: said.length, whole: said });
  expect(parseCut(post!.lastReply!)).toEqual({ kept: answer.slice(0, 1500), first: 1500, of: answer.length, whole: answer });
  expect(post!.notice.tasks).toEqual([{ id: "tsk_video", title: "Video migration" }]);
});

// The verdict is waited for; what changed meanwhile decides.
test("what changes while the verdict is awaited is read again: a new word waits on, an archived thread is not told, a newer reply is judged first", async () => {
  const s = setup();
  const jobs = s.build();
  /** A verdict the test answers, once the round has asked for it. */
  const pending = () => {
    let answer: (verdict: StopVerdict | null) => void = () => {};
    let asked: () => void = () => {};
    const wasAsked = new Promise<void>((resolve) => { asked = resolve; });
    s.setVerdict(() => {
      asked();
      return new Promise((resolve) => { answer = resolve; });
    });
    return { wasAsked, answer: (verdict: StopVerdict | null) => answer(verdict) };
  };
  s.stops.set(s.thread.id, "stopped");
  s.ownerSays("Ship it.", T0);
  s.reply("Shipped.", T0 + MIN);
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  // The user writes again while the verdict is on its way.
  let verdict = pending();
  let round = jobs.tick();
  await verdict.wasAsked;
  const again = s.ownerSays("And the docs?", T0 + DIRECT_CHAT_QUIET_MS);
  verdict.answer("result");
  await round;
  expect(s.posts).toEqual([]);
  // Quiet again: both told, once.
  s.now = T0 + 2 * DIRECT_CHAT_QUIET_MS;
  s.setVerdict(() => null);
  await jobs.tick();
  expect(s.posts.map((p) => [p.notice.chat?.messages, p.notice.chat?.to])).toEqual([[2, again.createdAt]]);

  // The thread archived while the verdict is on its way.
  const other = s.env.agentStore.createManagerThread("Rollout");
  s.stops.set(other.id, "stopped");
  s.ownerSays("Go.", T0 + 2 * DIRECT_CHAT_QUIET_MS, other.id);
  s.now = T0 + 3 * DIRECT_CHAT_QUIET_MS;
  verdict = pending();
  round = jobs.tick();
  await verdict.wasAsked;
  s.env.agentStore.archiveThread(other.id);
  verdict.answer(null);
  await round;
  expect(s.posts).toHaveLength(1);

  // A newer reply came while the verdict on the older was awaited: told with
  // the newer one only once it is judged.
  const third = s.env.agentStore.createManagerThread("Pricing");
  s.stops.set(third.id, "stopped");
  s.ownerSays("Which plan?", T0 + 3 * DIRECT_CHAT_QUIET_MS, third.id);
  s.reply("A or B?", T0 + 3 * DIRECT_CHAT_QUIET_MS + MIN, third.id);
  s.now = T0 + 4 * DIRECT_CHAT_QUIET_MS;
  verdict = pending();
  round = jobs.tick();
  await verdict.wasAsked;
  s.reply("Went with B on my own.", T0 + 4 * DIRECT_CHAT_QUIET_MS, third.id);
  verdict.answer("decision");
  await round;
  expect(s.posts).toHaveLength(1);
  s.setVerdict(() => Promise.resolve("result"));
  await jobs.tick();
  expect(s.posts.map((p) => [p.notice.title, p.notice.verdict, p.lastReply])).toEqual([
    ["Video migration", undefined, "Shipped."],
    ["Pricing", undefined, "Went with B on my own."]
  ]);
});

// A word sent while the thread worked waits in its queue; it was
// said when it was sent, not when the thread took it in.
test("a word queued while the thread worked counts from when the user sent it", async () => {
  const s = setup();
  const jobs = s.build();
  s.stops.set(s.thread.id, "stopped");
  const sentAt = new Date(T0).toISOString();
  const queued = s.env.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "user", content: { type: "text", text: "Also the docs.", arrivedAt: sentAt } });
  s.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(T0 + 10 * MIN).toISOString(), queued.id);
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts.map((p) => p.notice.chat)).toStrictEqual([{ from: sentAt, to: sentAt, messages: 1 }]);
});

// Continue under a stopped turn is the user's message, not their words.
test("a Continue the user pressed is no word of theirs: it starts no chat and keeps no chat waiting", async () => {
  const s = setup();
  const jobs = s.build();
  s.stops.set(s.thread.id, "stopped");
  const press = (ms: number) => {
    const m = s.env.agentStore.appendMessage({ threadId: s.thread.id, role: "user", source: "user", content: { type: "text", text: "Continue", metadata: controlMetadata("continue") } });
    s.env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(new Date(ms).toISOString(), m.id);
  };
  press(T0);
  s.now = T0 + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts).toEqual([]);
  s.ownerSays("Ship it.", T0 + 20 * MIN);
  press(T0 + 30 * MIN);
  s.now = T0 + 20 * MIN + DIRECT_CHAT_QUIET_MS;
  await jobs.tick();
  expect(s.posts.map((p) => [p.notice.chat?.messages, p.notice.words])).toEqual([[1, "Ship it."]]);
});
