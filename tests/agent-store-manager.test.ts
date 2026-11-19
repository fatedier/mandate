import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import path from "node:path";
import { freshAgentEnv } from "./helpers/fixtures.js";

const setup = () => freshAgentEnv("md-store-mgr-");

function writeUser(env: ReturnType<typeof setup>, threadId: string, text: string, createdAt: string) {
  const m = env.agentStore.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text } });
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run(createdAt, m.id);
  return m;
}

test("agent-store: several manager threads can be open at once", () => {
  const env = setup();
  const a = env.agentStore.createManagerThread();
  const b = env.agentStore.createManagerThread("Release");
  expect(a.id).not.toBe(b.id);
  expect(env.agentStore.listOpenManagerThreads().map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  expect(b.title).toBe("Release");
  expect(a.title).toBe(null);
  expect(a.seenSeq).toBe(0);
});

test("agent-store: latestManagerThread is the open thread the user last wrote in", () => {
  const env = setup();
  const a = env.agentStore.createManagerThread("A");
  const b = env.agentStore.createManagerThread("B");
  // Written in time order, as live messages are.
  writeUser(env, b.id, "early", "2026-09-27T09:00:00.000Z");
  writeUser(env, a.id, "late", "2026-09-27T10:00:00.000Z");
  expect(env.agentStore.latestManagerThread().id).toBe(a.id);
  // An assistant row is not the user writing: it does not move the choice.
  const r = env.agentStore.appendMessage({ threadId: b.id, role: "assistant", source: "manager", content: { type: "assistant", text: "hi" } });
  env.store.db.prepare("update agent_messages set created_at = ? where id = ?").run("2026-09-27T11:00:00.000Z", r.id);
  expect(env.agentStore.latestManagerThread().id).toBe(a.id);
  env.agentStore.archiveThread(a.id);
  expect(env.agentStore.latestManagerThread().id).toBe(b.id);
});

test("agent-store: latestManagerThread opens an ordinary untitled thread when none is open", () => {
  const env = setup();
  expect(env.agentStore.listOpenManagerThreads()).toEqual([]);
  const t = env.agentStore.latestManagerThread();
  expect(t.title).toBe(null);
  expect(env.agentStore.latestManagerThread().id).toBe(t.id);
});

test("agent-store: latestManagerThread titles a new thread only when the caller names it", () => {
  const env = setup();
  expect(env.agentStore.latestManagerThread("pr-33").title).toBe("pr-33");
  // An open thread exists now: the name is not applied to it.
  expect(env.agentStore.latestManagerThread("other").title).toBe("pr-33");
});

test("agent-store: the old scope lookups resolve manager to latestManagerThread", () => {
  const env = setup();
  expect(env.agentStore.getThreadByScope("manager", null)).toBe(null);
  const t = env.agentStore.getOrCreateThread("manager", null);
  expect(t.title).toBe(null);
  const other = env.agentStore.createManagerThread("Other");
  writeUser(env, other.id, "x", "2099-01-01T00:00:00.000Z");
  expect(env.agentStore.getThreadByScope("manager", null)?.id).toBe(other.id);
  expect(env.agentStore.getOrCreateThread("manager", null).id).toBe(other.id);
});

test("agent-store: the agent names and renames a thread until the user sets its title; the user's title always wins", () => {
  const env = setup();
  const t = env.agentStore.createManagerThread();
  const title = () => env.agentStore.getThreadById(t.id)?.title;
  expect(env.agentStore.nameThreadByAgent(t.id, "First")).toEqual({ kind: "named", previous: null });
  expect(env.agentStore.nameThreadByAgent(t.id, "First")).toEqual({ kind: "same" });
  expect(env.agentStore.nameThreadByAgent(t.id, "Second")).toEqual({ kind: "renamed", previous: "First" });
  expect(title()).toBe("Second");
  env.agentStore.setThreadTitle(t.id, "Mine");
  expect(env.agentStore.nameThreadByAgent(t.id, "Third")).toEqual({ kind: "user", title: "Mine" });
  expect(title()).toBe("Mine");
  env.agentStore.setThreadTitle(t.id, "Mine again");
  expect(title()).toBe("Mine again");
  // Opened with the user's title; a thread that does not exist.
  const asked = env.agentStore.createManagerThread("Asked", { titleByUser: true });
  expect(env.agentStore.nameThreadByAgent(asked.id, "Other")).toEqual({ kind: "user", title: "Asked" });
  expect(env.agentStore.nameThreadByAgent("thr_missing", "Other")).toBeNull();
});

test("agent-store: markThreadSeen only moves forward", () => {
  const env = setup();
  const t = env.agentStore.createManagerThread();
  env.agentStore.markThreadSeen(t.id, 7);
  env.agentStore.markThreadSeen(t.id, 3);
  expect(env.agentStore.getThreadById(t.id)?.seenSeq).toBe(7);
});

// With the reply row removed, a notice whose turn then says nothing left the
// agent's row with no new mark. What it says to the user (the dot) is its own
// words alone: a notice of another thread is not.
test("agent-store: a notice to the personal agent is a row a person reads, as a worker's report is; an alarm is not; the agent's words are what it said", () => {
  const env = setup();
  const t = env.agentStore.getOrCreatePersonalThread();
  env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "alarm", content: { type: "text", text: "[Alarm] look again" } });
  expect(env.agentStore.lastVisibleSeq(t.id)).toBe(0);
  const notice = env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "thread-notice", content: { type: "text", text: "[Thread notice] Worker release (f): stopped." } });
  expect(env.agentStore.lastVisibleSeq(t.id)).toBe(notice.seq);
  expect(env.agentStore.lastSaidSeq(t.id)).toBe(0);
  // The turn it woke only called tools: the notice is still the newest thing to read.
  env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: "", toolCalls: [] } });
  expect([env.agentStore.lastVisibleSeq(t.id), env.agentStore.lastSaidSeq(t.id)]).toEqual([notice.seq, 0]);
  const said = env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: "release answered.", toolCalls: [] } });
  expect([env.agentStore.lastVisibleSeq(t.id), env.agentStore.lastSaidSeq(t.id)]).toEqual([said.seq, said.seq]);
});

test("agent-store: lastVisibleSeq counts assistant text only; firstUserLine is the first user message's first line", () => {
  const env = setup();
  const t = env.agentStore.createManagerThread();
  expect(env.agentStore.lastVisibleSeq(t.id)).toBe(0);
  expect(env.agentStore.firstUserLine(t.id)).toBe(null);
  env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "  Ship project-1 3.21\nwith notes" } });
  const said = env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", content: { type: "assistant", text: "On it." } });
  env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", content: { type: "assistant", text: "   ", toolCalls: [] } });
  // The chat hides a reply whose JavaScript trim() is empty: tabs and line
  // breaks too, which SQLite's one-argument trim() keeps.
  env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", content: { type: "assistant", text: "\n\t \r\n\f\v", toolCalls: [] } });
  // Unicode spaces as well: a no-break space, an em space, a line separator.
  env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", content: { type: "assistant", text: "\u00a0\u2003\u2028", toolCalls: [] } });
  expect(env.agentStore.lastVisibleSeq(t.id)).toBe(said.seq);
  expect(env.agentStore.firstUserLine(t.id)).toBe("Ship project-1 3.21");
});

// An agent may write Mandate's database itself (sqlite3 in a shell). A read
// that left the server's connection inside a read transaction made every
// write after such a commit fail SQLITE_BUSY_SNAPSHOT, waiting or not.
test("agent-store: lastVisibleSeq leaves no read open, so a write after another connection's commit lands", () => {
  const env = setup();
  const t = env.agentStore.createManagerThread();
  env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", content: { type: "assistant", text: "Earlier." } });
  const latest = env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", content: { type: "assistant", text: "Latest." } });
  // It finds the newest row and stops there, with older rows unread.
  expect(env.agentStore.lastVisibleSeq(t.id)).toBe(latest.seq);
  const other = new Database(path.join(env.dir, "mandate.db"));
  try {
    other.exec("pragma busy_timeout = 5000");
    other.prepare("update agent_threads set title = ? where id = ?").run("Renamed outside", t.id);
  } finally {
    other.close();
  }
  const after = env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "Still writable." } });
  expect(after.seq).toBeGreaterThan(latest.seq);
});

test("agent-store: a turn's newest reply is read without leaving a read open, so a write after another connection's commit lands", () => {
  const env = setup();
  const t = env.agentStore.createManagerThread();
  const wake = env.agentStore.createWake({ threadId: t.id, reason: "user", triggerMessageId: null });
  env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", wakeId: wake.id, content: { type: "assistant", text: "Earlier." } });
  const latest = env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", wakeId: wake.id, content: { type: "assistant", text: "Latest." } });
  // The newest has words: it stops there, with the older row unread.
  expect(env.agentStore.latestAssistantTextOfWake(t.id, wake.id)).toBe("Latest.");
  const other = new Database(path.join(env.dir, "mandate.db"));
  try {
    other.exec("pragma busy_timeout = 5000");
    other.prepare("update agent_threads set title = ? where id = ?").run("Renamed outside", t.id);
  } finally {
    other.close();
  }
  const after = env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "Still writable." } });
  expect(after.seq).toBeGreaterThan(latest.seq);
});

test("agent-store: latestManagerThread breaks a same-millisecond tie by which message was written last", () => {
  const env = setup();
  const a = env.agentStore.createManagerThread("A");
  const b = env.agentStore.createManagerThread("B");
  env.store.db.prepare("update agent_threads set created_at = ? where id = ?").run("2026-09-27T09:00:00.000Z", a.id);
  env.store.db.prepare("update agent_threads set created_at = ? where id = ?").run("2026-09-27T09:30:00.000Z", b.id);
  // b is the newer thread; a gets the later write inside the same millisecond.
  writeUser(env, b.id, "first", "2026-09-27T10:00:00.000Z");
  writeUser(env, a.id, "second", "2026-09-27T10:00:00.000Z");
  expect(env.agentStore.latestManagerThread().id).toBe(a.id);
});

// Reads that want a thread's latest few walk back from its newest message
// and stop: the rest of the thread is never read.
test("agent-store: forEachNewestFirst hands messages newest first, within its range and roles, until told to stop", () => {
  const env = setup();
  const t = env.agentStore.createManagerThread();
  const say = (role: "user" | "assistant", text: string) => env.agentStore.appendMessage(role === "user"
    ? { threadId: t.id, role, source: "user", content: { type: "text", text } }
    : { threadId: t.id, role, source: "manager", content: { type: "assistant", text } });
  const first = say("user", "one");
  say("assistant", "two");
  const third = say("user", "three");
  say("assistant", "four");
  const fifth = say("assistant", "five");
  const texts = (range: Parameters<typeof env.agentStore.forEachNewestFirst>[2], stopAfter = Infinity) => {
    const seen: string[] = [];
    env.agentStore.forEachNewestFirst(t.id, (m) => {
      seen.push((m.content as { text: string }).text);
      return seen.length < stopAfter;
    }, range);
    return seen;
  };
  expect(texts({})).toEqual(["five", "four", "three", "two", "one"]);
  expect(texts({ afterSeq: first.seq, beforeSeq: fifth.seq })).toEqual(["four", "three", "two"]);
  expect(texts({ roles: ["assistant"] })).toEqual(["five", "four", "two"]);
  expect(texts({ afterSeq: third.seq, roles: ["user"] })).toEqual([]);
  expect(texts({}, 2)).toEqual(["five", "four"]);
});

test("agent-store: a walk stopped early leaves no read open, so a write after another connection's commit lands", () => {
  const env = setup();
  const t = env.agentStore.createManagerThread();
  for (const text of ["older", "newer"]) env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", content: { type: "assistant", text } });
  env.agentStore.forEachNewestFirst(t.id, () => false);
  env.agentStore.newestUserStatement(t.id, () => true);
  const other = new Database(path.join(env.dir, "mandate.db"));
  try {
    other.exec("pragma busy_timeout = 5000");
    other.prepare("update agent_threads set title = ? where id = ?").run("Renamed outside", t.id);
  } finally {
    other.close();
  }
  const after = env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "Still writable." } });
  expect(after.seq).toBe(3);
});

// What a memory that claims the user's words is checked against: the newest
// message they wrote that holds them; a relay carries the agent's words.
test("agent-store: newestUserStatement finds the newest of the user's own messages that matches, and reads on from where it left", () => {
  const env = setup();
  const t = env.agentStore.createManagerThread();
  writeUser(env, t.id, "deploy on Tuesday", "2026-09-27T10:00:00.000Z");
  writeUser(env, t.id, "deploy on Tuesday, then post the notes", "2026-09-27T11:00:00.000Z");
  env.agentStore.appendMessage({ threadId: t.id, role: "user", source: "user", content: { type: "text", text: "deploy on Tuesday (relayed)", relay: { by: "personal", spoken: false, handoffId: "hof_1" } } });
  env.agentStore.appendMessage({ threadId: t.id, role: "assistant", source: "manager", content: { type: "assistant", text: "deploy on Tuesday" } });
  const holds = (text: string) => text.includes("deploy on Tuesday");
  const found = env.agentStore.newestUserStatement(t.id, holds);
  expect(found.said).toEqual({ text: "deploy on Tuesday, then post the notes", at: "2026-09-27T11:00:00.000Z" });
  const none = env.agentStore.newestUserStatement(t.id, (text) => text.includes("Friday"));
  expect(none.said).toBeNull();
  // Asked again, only what came after: a later message that holds the words.
  writeUser(env, t.id, "no, Friday", "2026-09-27T12:00:00.000Z");
  expect(env.agentStore.newestUserStatement(t.id, (text) => text.includes("Friday"), none.newestSeq).said?.text).toBe("no, Friday");
  expect(env.agentStore.newestUserStatement(t.id, holds, none.newestSeq + 1).said).toBeNull();
});
