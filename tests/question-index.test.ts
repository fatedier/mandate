import { expect, test } from "bun:test";
import type { AgentStore } from "../src/server/modules/agent/agent-store.js";
import { QuestionIndex } from "../src/server/modules/agent/question-index.js";
import { featureMessageNoteMetadata } from "../src/shared/feature-message.js";
import { answersMetadata } from "../src/shared/questions.js";
import { AgentStore as Store } from "../src/server/modules/agent/agent-store.js";
import { freshAgentEnv } from "./helpers/fixtures.js";

function ask(store: AgentStore, threadId: string, id: string, question: string) {
  return store.appendMessage({
    threadId, role: "tool", source: "self",
    content: { type: "tool_result", toolCallId: `call_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options: [] } }
  });
}

function say(store: AgentStore, threadId: string, text: string, metadata?: Record<string, unknown>) {
  return store.appendMessage({ threadId, role: "user", source: "user", content: { type: "text", text, ...(metadata ? { metadata } : {}) } });
}

const ids = (store: AgentStore, threadId: string) => store.openQuestions(threadId).map((q) => q.id);

test("only a message that names its question answers it: typed words, a note, a report, a spoken line or a mark of nothing close none", () => {
  const env = freshAgentEnv("md-q-named-");
  const store = env.agentStore;
  const t = store.createManagerThread("Release");
  ask(store, t.id, "q_1", "Push?");
  ask(store, t.id, "q_2", "Tag?");
  say(store, t.id, "Go on");
  store.appendMessage({
    threadId: t.id, role: "user", source: "feature-message",
    content: { type: "text", text: "The user wrote to your worker…", metadata: featureMessageNoteMetadata({ featureId: "f1", featureName: "evict", by: "user", text: "Push it.", attachments: 0 }) }
  });
  store.appendMessage({ threadId: t.id, role: "user", source: "worker-report", content: { type: "text", text: "[Worker report] …" } });
  store.appendMessage({ threadId: t.id, role: "assistant", source: "voice", content: { type: "assistant", text: "Shall I?" } });
  for (const answers of ["a string", 7, { id: "q_1" }, true, null, [], [{ question: "no id" }, 7]]) say(store, t.id, "Yes", { answers });
  expect(ids(store, t.id)).toEqual(["q_1", "q_2"]);
  expect(new Store(env.store.db).openQuestions(t.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
  say(store, t.id, "Push now", answersMetadata([{ id: "q_1", question: "Push?" }]));
  expect(ids(store, t.id)).toEqual(["q_2"]);
  expect(new Store(env.store.db).openQuestions(t.id).map((q) => q.id)).toEqual(["q_2"]);
});

test("a message that kept what it closed under an earlier rule closes it for the index, on a first look and after", () => {
  const env = freshAgentEnv("md-q-kept-");
  const store = env.agentStore;
  const t = store.createManagerThread("Release");
  ask(store, t.id, "q_1", "Push?");
  ask(store, t.id, "q_2", "Tag?");
  say(store, t.id, "Yes to both", { closedQuestions: ["q_1"] });
  expect(new Store(env.store.db).openQuestions(t.id).map((q) => q.id)).toEqual(["q_2"]);
  expect(ids(store, t.id)).toEqual(["q_2"]);
  say(store, t.id, "And the tag", { closedQuestions: ["q_2"] });
  expect(ids(store, t.id)).toEqual([]);
});

test("the rows that can open or close a question come back in order; the rest of a turn's rows do not", () => {
  const env = freshAgentEnv("md-q-rows-");
  const store = env.agentStore;
  const t = store.createManagerThread("Release");
  store.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: "Looking." } });
  store.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c1", toolName: "bash", result: "x".repeat(30_000) } });
  const asked = ask(store, t.id, "q_1", "Push?");
  // Words that name no question cannot close one: they are not read.
  say(store, t.id, "Looks good.");
  const pick = say(store, t.id, "Push now", answersMetadata([{ id: "q_1", question: "Push?" }]));
  store.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c2", toolName: "read", result: "nothing here" } });
  const withdrawn = store.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c3", toolName: "withdraw_question", result: { withdrawn: true, questionId: "q_9" } } });
  const rows = store.questionRowsAfter(t.id, 0);
  expect(rows.map((r) => r.seq)).toEqual([asked.seq, pick.seq, withdrawn.seq]);
  expect(rows[0]!.content).toEqual(asked.content);
  expect(rows[0]!.createdAt).toBe(asked.createdAt);
  expect(store.questionRowsAfter(t.id, pick.seq).map((r) => r.seq)).toEqual([withdrawn.seq]);
  // Another thread's rows are not this one's.
  const other = store.createManagerThread("Docs");
  ask(store, other.id, "q_2", "Tag?");
  expect(store.questionRowsAfter(t.id, 0).map((r) => r.seq)).toEqual([asked.seq, pick.seq, withdrawn.seq]);
});

test("it reads only what came after its last look", () => {
  const env = freshAgentEnv("md-q-mark-");
  const store = env.agentStore;
  const t = store.createManagerThread("Release");
  const seen: number[] = [];
  const index = new QuestionIndex({
    lastSeq: (id) => store.lastSeq(id),
    uncommitted: () => false,
    questionRowsAfter: (id, seq) => { seen.push(seq); return store.questionRowsAfter(id, seq); }
  });
  const first = ask(store, t.id, "q_1", "Push?");
  expect(index.open(t.id).map((q) => q.id)).toEqual(["q_1"]);
  const second = ask(store, t.id, "q_2", "Tag?");
  expect(index.open(t.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
  expect(index.open(t.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
  expect(seen).toStrictEqual([0, first.seq, second.seq]);
  // The rows of ordinary work (a turn's replies and tool results, by far
  // the most of a conversation) are passed over once, not on every look.
  store.appendMessage({ threadId: t.id, role: "assistant", source: "self", content: { type: "assistant", text: "Running the tests." } });
  const output = store.appendMessage({ threadId: t.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c9", toolName: "bash", result: "ok" } });
  expect(index.open(t.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
  expect(index.open(t.id).map((q) => q.id)).toEqual(["q_1", "q_2"]);
  expect(seen.slice(3)).toStrictEqual([second.seq, output.seq]);
});

test("a first look reads from the start: a question asked long ago and never answered is open", () => {
  const env = freshAgentEnv("md-q-hist-");
  const store = env.agentStore;
  const t = store.createManagerThread("Release");
  ask(store, t.id, "q_old", "Old?");
  for (let i = 0; i < 20; i++) say(store, t.id, `Something else ${i}.`);
  ask(store, t.id, "q_new", "And this?");
  const seen: number[] = [];
  const index = new QuestionIndex({
    lastSeq: (id) => store.lastSeq(id),
    uncommitted: () => false,
    questionRowsAfter: (id, seq) => { seen.push(seq); return store.questionRowsAfter(id, seq); }
  });
  expect(index.open(t.id).map((q) => q.id)).toEqual(["q_old", "q_new"]);
  expect(seen).toStrictEqual([0]);
});

test("the note of what the user told a worker answers none of the manager's questions, held behind its turn or landed, and carries no mark", () => {
  const env = freshAgentEnv("md-q-mailbox-");
  const store = env.agentStore;
  const t = store.createManagerThread("Release");
  ask(store, t.id, "q_1", "Push?");
  store.enqueueMailboxMessage({
    threadId: t.id, role: "user", source: "feature-message", triggerTurn: false,
    content: { type: "text", text: "The user wrote to your worker…", metadata: featureMessageNoteMetadata({ featureId: "f1", featureName: "evict", by: "user", text: "Push it.", attachments: 0 }) }
  });
  expect(ids(store, t.id)).toEqual(["q_1"]);
  const wake = store.createWake({ threadId: t.id, reason: "user", triggerMessageId: null });
  const [landed] = store.drainMailboxToMessages(t.id, wake.id);
  expect(ids(store, t.id)).toEqual(["q_1"]);
  expect(JSON.stringify(landed!.content)).not.toContain("openWhenWritten");
  expect(JSON.stringify(landed!.content)).not.toContain("writtenBefore");
});

// The index is memory and the rows are a database: what is read inside a
// transaction may never be written. It keeps nothing it read there.
test("what is read inside a transaction that rolls back leaves the index as the rows are", () => {
  const env = freshAgentEnv("md-q-rollback-");
  const store = env.agentStore;
  const t = store.createManagerThread("Release");
  ask(store, t.id, "q_1", "Push to main now?");
  expect(ids(store, t.id)).toEqual(["q_1"]);
  expect(() => env.store.db.transaction(() => {
    say(store, t.id, "Yes.", answersMetadata([{ id: "q_1", question: "Push to main now?" }]));
    // Inside, the rows as they stand are what is read.
    expect(ids(store, t.id)).toEqual([]);
    throw new Error("the write failed");
  })()).toThrow("the write failed");
  // The answer was never written: the question is open.
  expect(ids(store, t.id)).toEqual(["q_1"]);
  // And rows that take the numbers of the ones rolled back are read.
  ask(store, t.id, "q_2", "Tag it too?");
  expect(ids(store, t.id)).toEqual(["q_1", "q_2"]);
});

