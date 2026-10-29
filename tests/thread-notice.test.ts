import { expect, test } from "bun:test";
import { formatThreadNoticeText, threadNoticeMetadata, threadNoticeOf, type ThreadNotice } from "../src/shared/thread-notice.js";

const notice: ThreadNotice = { handoffIds: ["hof_1"], kind: "thread", targetThreadId: "thr_1", featureId: null, title: "Search timeout", stop: "stopped", reason: null };

test("the notice reads back from a message's metadata, and nothing else does", () => {
  const content = { type: "text" as const, text: "x", metadata: threadNoticeMetadata(notice) };
  expect(threadNoticeOf(content)).toEqual(notice);
  expect(threadNoticeOf({ type: "text", text: "x" })).toBeNull();
  expect(threadNoticeOf({ type: "text", text: "x", metadata: { threadNotice: { ...notice, stop: "exploded" } } })).toBeNull();
});

test("the model reads who stopped, how, and what was last said", () => {
  expect(formatThreadNoticeText(notice, "Fixed; 12 of 12 tests pass.")).toBe(
    '[Thread notice] Thread "Search timeout" (thr_1): stopped.\nLast reply:\nFixed; 12 of 12 tests pass.'
  );
  expect(formatThreadNoticeText({ ...notice, kind: "feature", featureId: "feat_1", title: "login", stop: "needs_you" }, null)).toBe(
    "[Thread notice] Worker login (feat_1): needs you.\nIt has said nothing since you began waiting."
  );
  expect(formatThreadNoticeText({ ...notice, stop: "archived", reason: "the thread was archived" }, null)).toBe(
    '[Thread notice] Thread "Search timeout" (thr_1): archived.\nthe thread was archived\nIt has said nothing since you began waiting.'
  );
});

const asked: ThreadNotice = {
  ...notice, stop: "asked",
  question: { text: "Push fix/evict-order and open a pull request?", options: [{ label: "Push and open the PR", description: "The tests pass." }, { label: "Hold it" }] }
};

test("a question a followed thread asked reads with its suggested answers, and says the wait goes on", () => {
  expect(formatThreadNoticeText(asked, null)).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): asked the user a question.',
    "Question: Push fix/evict-order and open a pull request?",
    "Suggested answers:",
    "1. Push and open the PR: The tests pass.",
    "2. Hold it",
    // In a round Your agent started, its prompt says what to do (the user is
    // not in that thread, so it asks them): no line of its own.
    "The thread goes on working, and so does your wait on it."
  ].join("\n"));
  // No suggested answers: no list of them. What the thread last said is not part of it.
  expect(formatThreadNoticeText({ ...asked, question: { text: "Which branch?", options: [] } }, "An earlier reply.")).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): asked the user a question.',
    "Question: Which branch?",
    "The thread goes on working, and so does your wait on it."
  ].join("\n"));
  // In the user's own round it is theirs; it reads back so.
  const own: ThreadNotice = { ...asked, direct: true };
  expect(formatThreadNoticeText(own, null).split("\n").slice(-2)).toEqual([
    "The thread goes on working, and so does your wait on it.",
    "The user is talking with this thread directly and has this question in front of them; it is theirs to answer."
  ]);
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(own) })).toEqual(own);
});

test("the question reads back from the metadata; a notice of a question that carries none is no notice", () => {
  const content = (n: unknown) => ({ type: "text" as const, text: "x", metadata: { threadNotice: n } });
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(asked) })).toEqual(asked);
  expect(threadNoticeOf(content({ ...asked, question: undefined }))).toBeNull();
  expect(threadNoticeOf(content({ ...asked, question: { text: 7, options: [] } }))).toBeNull();
  // Options that are not options are dropped; the question stands.
  expect(threadNoticeOf(content({ ...asked, question: { text: "Which branch?", options: [{ description: "no label" }, "main", { label: "main" }] } }))!.question)
    .toEqual({ text: "Which branch?", options: [{ label: "main" }] });
  // A stop carries no question.
  expect(threadNoticeOf(content({ ...notice, question: asked.question }))).toEqual(notice);
});

const settled = (how: "answered" | "skipped" | "withdrawn"): ThreadNotice => ({
  ...notice, handoffIds: [], stop: "settled",
  question: { id: "q_1", text: "Push fix/evict-order and open a pull request?", options: [] },
  settled: how === "answered" ? { how, answer: "Push and open the PR" } : { how }
});

test("a question the agent was told of, settled in the thread, reads how it was: the user's answer, a skip, or taken back; and to take back its own", () => {
  const read = (how: "answered" | "skipped" | "withdrawn") => formatThreadNoticeText(settled(how), "An earlier reply.").split("\n");
  const head = ['[Thread notice] Thread "Search timeout" (thr_1): its question to the user is settled.', "Question: Push fix/evict-order and open a pull request?"];
  const tail = "If you put this question to the user too, take yours back with `withdraw_question`.";
  expect(read("answered")).toEqual([...head, "The user answered it there: Push and open the PR", tail]);
  expect(read("skipped")).toEqual([...head, "The user skipped it.", tail]);
  expect(read("withdrawn")).toEqual([...head, "Its manager took it back.", tail]);
});

test("a settled notice reads back with its question and how; without either it is no notice; an asked notice keeps its question's id", () => {
  const content = (n: unknown) => ({ type: "text" as const, text: "x", metadata: { threadNotice: n } });
  for (const how of ["answered", "skipped", "withdrawn"] as const) {
    expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(settled(how)) })).toEqual(settled(how));
  }
  expect(threadNoticeOf(content({ ...settled("skipped"), question: undefined }))).toBeNull();
  expect(threadNoticeOf(content({ ...settled("skipped"), settled: undefined }))).toBeNull();
  expect(threadNoticeOf(content({ ...settled("skipped"), settled: { how: "forgotten" } }))).toBeNull();
  expect(threadNoticeOf(content({ ...settled("answered"), settled: { how: "answered" } }))).toBeNull();
  const withId = { ...asked, question: { ...asked.question!, id: "q_1" } };
  expect(threadNoticeOf(content(withId))).toEqual(withId);
  // A stop carries no settlement.
  expect(threadNoticeOf(content({ ...notice, settled: { how: "skipped" } }))).toEqual(notice);
});

// A request its thread says is done (or cannot go on) while the thread works
// on: the wait for that one request ends; the model reads which request it was.
const judged: ThreadNotice = { ...notice, stop: "done", requests: ["Merge #41 once the pipeline passes.", "Update the changelog."] };

test("a request its thread says is done reads with each request, says the thread goes on, and what was last said", () => {
  expect(formatThreadNoticeText(judged, "Merged #41.")).toBe(
    '[Thread notice] Thread "Search timeout" (thr_1): says your request is done.\n' +
    "Your request: Merge #41 once the pipeline passes.\nYour request: Update the changelog.\n" +
    "The thread goes on working on other things.\nLast reply:\nMerged #41."
  );
  expect(formatThreadNoticeText({ ...judged, stop: "cannot", requests: ["Deploy."] }, "Needs your approval first.")).toBe(
    '[Thread notice] Thread "Search timeout" (thr_1): says your request cannot go on.\n' +
    "Your request: Deploy.\nThe thread goes on working on other things.\nLast reply:\nNeeds your approval first."
  );
});

test("a judged notice reads back with its requests", () => {
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(judged) })).toEqual(judged);
});


// The manager stop check's verdict, when there is one, is one line under how it stopped.
test("the stopped notice says what the manager stop check found", () => {
  const stopped: ThreadNotice = { ...notice, title: "Pick a plan", targetThreadId: "t1", stop: "stopped" };
  expect(formatThreadNoticeText({ ...stopped, verdict: "decision" }, "Pick one")).toBe(
    '[Thread notice] Thread "Pick a plan" (t1): stopped.\nManager stop check: its latest reply waits for a decision from the user.\nLast reply:\nPick one'
  );
  expect(formatThreadNoticeText({ ...stopped, verdict: "result" }, "Done.").split("\n")[1]).toBe("Manager stop check: its latest reply has a result for the user to read.");
  expect(formatThreadNoticeText({ ...stopped, verdict: "nothing" }, "Noted.").split("\n")[1]).toBe("Manager stop check: its latest reply leaves nothing for the user.");
  expect(formatThreadNoticeText(stopped, "Noted.")).toBe('[Thread notice] Thread "Pick a plan" (t1): stopped.\nLast reply:\nNoted.');
  // It reads back, and a word it does not know is dropped.
  const content = (n: unknown) => ({ type: "text" as const, text: "x", metadata: { threadNotice: n } });
  expect(threadNoticeOf(content({ ...stopped, verdict: "result" }))).toEqual({ ...stopped, verdict: "result" });
  expect(threadNoticeOf(content({ ...stopped, verdict: "maybe" }))).toEqual(stopped);
});

// A round the user drove with a thread directly, which the agent did not send:
// told without a wake, and saying so.
const direct: ThreadNotice = { handoffIds: [], kind: "thread", targetThreadId: "thr_1", featureId: null, title: "Search timeout", stop: "stopped", reason: null, verdict: "result", direct: true };

test("a round the user drove directly reads back, and the model reads that it was the user's own", () => {
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(direct) })).toEqual(direct);
  // Its body is what the user said, not the reply they have in front of them.
  expect(formatThreadNoticeText(direct, "This plan is far too complex.")).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): stopped.',
    "Manager stop check: its latest reply has a result for the user to read.",
    "The user wrote to this thread directly and has its reply in front of them; you did not send this round and were not woken for it. Whether anything in it needs you, now or later, is yours to judge; know it for what you tell the user and keep.",
    "The user said:",
    "This plan is far too complex."
  ].join("\n"));
  // Words they did not type (an attachment alone): no body at all.
  expect(formatThreadNoticeText(direct, null).split("\n")).toHaveLength(3);
  // What came after the agent's request was answered: its own line.
  const after: ThreadNotice = { ...direct, direct: undefined, after: true };
  delete after.direct;
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(after) })).toEqual(after);
  expect(formatThreadNoticeText(after, "Workers done: the plan is final.").split("\n").slice(1, 3)).toEqual([
    "Manager stop check: its latest reply has a result for the user to read.",
    "This came after the thread answered your request; you did not send this round, and nothing waits on you. Know it for what you tell the user and keep."
  ]);
  // The user's own round, a decision too: they have it in front of them, so
  // the agent is told it was not woken and judges what it needs.
  expect(formatThreadNoticeText({ ...direct, verdict: "decision" }, "The 12th or the 19th?").split("\n").slice(1, 3)).toEqual([
    "Manager stop check: its latest reply waits for a decision from the user.",
    "The user wrote to this thread directly and has its reply in front of them; you did not send this round and were not woken for it. Whether anything in it needs you, now or later, is yours to judge; know it for what you tell the user and keep."
  ]);
  expect(formatThreadNoticeText({ ...after, verdict: "decision" }, "Workers done: merge?").split("\n").slice(1, 3)).toEqual([
    "Manager stop check: its latest reply waits for a decision from the user.",
    "This came after the thread answered your request; you did not send this round. Tell the user now: the decision is theirs."
  ]);
  // Only `true` marks it: anything else reads as an ordinary notice.
  expect(threadNoticeOf({ type: "text", text: "x", metadata: { threadNotice: { ...direct, direct: "yes" } } })!.direct).toBeUndefined();
  expect(threadNoticeOf({ type: "text", text: "x", metadata: { threadNotice: { ...after, after: "yes" } } })!.after).toBeUndefined();
});

// A wait that ends because the thread needs the user, in a round the user
// started, is theirs to answer: told without a wake, saying so.
test("a needs-you end in the user's own round says the question is theirs, and still carries the reply", () => {
  const own: ThreadNotice = { handoffIds: ["hof_1"], kind: "thread", targetThreadId: "thr_1", featureId: null, title: "Search timeout", stop: "needs_you", reason: null, direct: true };
  expect(formatThreadNoticeText(own, "Ship it behind the flag, or wait for review?")).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): needs you.',
    "The user is talking with this thread directly and has this question in front of them; it is theirs to answer.",
    "Last reply:",
    "Ship it behind the flag, or wait for review?"
  ].join("\n"));
});
