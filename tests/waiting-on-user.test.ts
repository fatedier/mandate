import { expect, test } from "bun:test";
import { attentionEntries, type AttentionThread, type AttentionWorker } from "../src/shared/waiting-on-user.js";

const thread = (id: string, over: Partial<AttentionThread> = {}): AttentionThread =>
  ({ id, title: `Thread ${id}`, running: false, watching: false, failure: null, questions: [], verdict: null, ...over });
const worker = (featureId: string, over: Partial<AttentionWorker> = {}): AttentionWorker =>
  ({ featureId, ownerThreadId: "thr_a", name: featureId, place: null, waiting: null, asking: false, running: false, watching: false, question: null, ...over });

const entries = (threads: AttentionThread[], workers: AttentionWorker[], agentQuestions?: string[]) =>
  attentionEntries(threads, workers, agentQuestions).map((e) => [e.waiting, e.kind, e.threadId, e.featureId, e.text]);

// The agent above the threads asks the user too: its question is theirs at
// once, first among the questions (it is the one the user talks to).
test("what the user's own agent asked them is the first question, as one entry", () => {
  const asks = worker("evict", { asking: true, question: "Keep the old flag as an alias?", ownerThreadId: "thr_b" });
  expect(entries([thread("thr_a", { questions: ["Tag it?"] }), thread("thr_b")], [asks], ["Send the weekly summary now?", "And to whom?"])).toEqual([
    ["input", "agent", null, null, "Send the weekly summary now? (+1 more)"],
    ["input", "question", "thr_a", null, "Tag it?"],
    ["input", "worker", "thr_b", "evict", "Keep the old flag as an alias?"]
  ]);
  expect(entries([thread("thr_a")], [], [])).toEqual([]);
});

test("a thread whose manager asked the user waits on them at once: the first question, and how many more", () => {
  expect(entries([thread("thr_a", { running: true, questions: ["Push the branch?"] })], [])).toEqual([["input", "question", "thr_a", null, "Push the branch?"]]);
  expect(entries([thread("thr_a", { questions: ["Push the branch?", "Tag it too?", "Announce it?"] })], [])).toEqual([
    ["input", "question", "thr_a", null, "Push the branch? (+2 more)"]
  ]);
});

// A worker's question goes to its manager first. It waits on the user only
// when nobody took it up: nothing in its thread runs or will wake by itself.
test("a worker's question waits on the user only once its whole thread rests", () => {
  const asks = worker("evict", { asking: true, question: "Keep the old flag as an alias?" });
  const row = ["input", "worker", "thr_a", "evict", "Keep the old flag as an alias?"];
  expect(entries([thread("thr_a")], [asks])).toEqual([row]);
  expect(entries([thread("thr_a", { running: true })], [asks])).toEqual([]);
  expect(entries([thread("thr_a", { watching: true })], [asks])).toEqual([]);
  expect(entries([thread("thr_a")], [asks, worker("other", { running: true })])).toEqual([]);
  expect(entries([thread("thr_a")], [asks, worker("other", { watching: true })])).toEqual([]);
  expect(entries([thread("thr_a")], [{ ...asks, running: true }])).toEqual([]);
  expect(entries([thread("thr_a")], [{ ...asks, watching: true }])).toEqual([]);
  // Another thread at work does not hold this one's question back.
  expect(entries([thread("thr_a"), thread("thr_b", { running: true })], [asks, worker("far", { ownerThreadId: "thr_b", running: true })])).toEqual([row]);
  // A worker with no thread, or whose thread is not among the open ones, is judged alone.
  expect(entries([], [{ ...asks, ownerThreadId: null }])).toEqual([["input", "worker", null, "evict", "Keep the old flag as an alias?"]]);
  expect(entries([], [asks])).toEqual([row]);
});

// An alarm wakes its agent by itself, but may be a reminder past the end of
// the work: a worker's holds a question back only while that worker is still
// at work (a plan step in progress) and waits on nobody; a manager's never.
test("an alarm holds a worker's question back only while it is a still-working worker's own wait", () => {
  const asks = worker("evict", { asking: true, question: "Keep the old flag as an alias?" });
  const row = ["input", "worker", "thr_a", "evict", "Keep the old flag as an alias?"];
  expect(entries([thread("thr_a")], [{ ...asks, watching: "alarm", stepInProgress: true }])).toEqual([row]);
  expect(entries([thread("thr_a", { watching: "alarm" })], [asks])).toEqual([row]);
  expect(entries([thread("thr_a")], [asks, worker("other", { watching: "alarm" })])).toEqual([row]);
  expect(entries([thread("thr_a")], [asks, worker("other", { watching: "alarm", stepInProgress: true })])).toEqual([]);
  // A worker that failed waits on its manager: its alarm holds nothing open, and it is no row.
  expect(entries([thread("thr_a")], [asks, worker("other", { watching: "alarm", stepInProgress: true, waiting: "failed" })])).toEqual([row]);
  expect(entries([thread("thr_a", { watching: "command" })], [asks])).toEqual([]);
});

test("while a thread's manager has a question to the user of its own, its workers' questions are not the user's too", () => {
  const asks = worker("evict", { asking: true, question: "Keep the old flag as an alias?" });
  expect(entries([thread("thr_a", { questions: ["Keep the old flag as an alias, or drop it?"] })], [asks])).toEqual([
    ["input", "question", "thr_a", null, "Keep the old flag as an alias, or drop it?"]
  ]);
  expect(entries([thread("thr_a"), thread("thr_b", { questions: ["Tag it?"] })], [asks]).map((e) => e[1])).toEqual(["question", "worker"]);
});

test("one order: what broke, then questions, then decisions, then results; a worker's failure is its manager's", () => {
  expect(entries([
    thread("t_result", { verdict: { kind: "result", replyText: "Done." } }),
    thread("t_decision", { verdict: { kind: "decision", replyText: "Pick one." } }),
    thread("t_asks", { questions: ["Tag it?"] }),
    thread("t_stuck", { failure: { kind: "stopped", reason: "kept failing" } }),
    thread("t_broke", { failure: { kind: "error", reason: "boom" } })
  ], [worker("probe", { ownerThreadId: "t_asks", waiting: "failed" })])).toEqual([
    ["stopped", "thread", "t_stuck", null, "kept failing"],
    ["failed", "thread", "t_broke", null, "boom"],
    ["input", "question", "t_asks", null, "Tag it?"],
    ["decision", "thread", "t_decision", null, "Pick one."],
    ["result", "thread", "t_result", null, "Done."]
  ]);
});

test("each entry is keyed by what it is about: two workers of one thread never share a key", () => {
  const keys = attentionEntries([thread("thr_a")], [
    worker("a", { asking: true, question: "A?" }), worker("b", { asking: true, question: "B?" })
  ], ["Now?"]).map((e) => e.key);
  expect(keys).toEqual(["agent:agent:input", "worker:a:input", "worker:b:input"]);
});
