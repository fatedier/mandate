import { expect, test } from "bun:test";
import { formatThreadNoticeText, threadNoticeMetadata, threadNoticeOf, type ThreadNotice } from "../src/shared/thread-notice.js";

const notice: ThreadNotice = { handoffIds: ["hof_1"], kind: "thread", targetThreadId: "thr_1", workerId: null, title: "Search timeout", stop: "stopped", reason: null };

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
  expect(formatThreadNoticeText({ ...notice, kind: "worker", workerId: "wkr_1", title: "login", stop: "needs_you" }, null)).toBe(
    "[Thread notice] Worker login (wkr_1): needs you.\nIt has said nothing since you began waiting."
  );
  expect(formatThreadNoticeText({ ...notice, stop: "archived", reason: "the thread was archived" }, null)).toBe(
    '[Thread notice] Thread "Search timeout" (thr_1): archived.\nthe thread was archived\nIt has said nothing since you began waiting.'
  );
});

const asked: ThreadNotice = {
  ...notice, stop: "asked",
  question: { id: "q_ab12cd", text: "Push fix/evict-order and open a pull request?", options: [{ label: "Push and open the PR", description: "The tests pass." }, { label: "Hold it" }] }
};

test("a question a followed thread asked reads with its suggested answers, and says the wait goes on", () => {
  expect(formatThreadNoticeText(asked, null)).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): asked the user a question.',
    "Question (q_ab12cd): Push fix/evict-order and open a pull request?",
    "Suggested answers:",
    "1. Push and open the PR: The tests pass.",
    "2. Hold it",
    // In a round the personal agent started, its prompt says what to do (the user is
    // not in that thread, so it asks them): no line of its own.
    "The thread goes on working, and so does your wait on it."
  ].join("\n"));
  // No suggested answers: no list of them. What the thread last said is not part of it.
  expect(formatThreadNoticeText({ ...asked, question: { id: "q_2", text: "Which branch?", options: [] } }, "An earlier reply.")).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): asked the user a question.',
    "Question (q_2): Which branch?",
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

test("a question from a thread the agent waits on nothing in says so: the user's now, or theirs in front of them in their own round", () => {
  const unwaited: ThreadNotice = { ...asked, handoffIds: [], noWait: true };
  expect(formatThreadNoticeText(unwaited, null)).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): asked the user a question.',
    "Question (q_ab12cd): Push fix/evict-order and open a pull request?",
    "Suggested answers:",
    "1. Push and open the PR: The tests pass.",
    "2. Hold it",
    "You were not waiting on this thread: it asked the user on its own. Tell the user now: the question is theirs."
  ].join("\n"));
  const own: ThreadNotice = { ...unwaited, direct: true };
  expect(formatThreadNoticeText(own, null).split("\n").slice(-2)).toEqual([
    "2. Hold it",
    "The user is talking with this thread directly and has this question in front of them; it is theirs to answer."
  ]);
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(unwaited) })).toEqual(unwaited);
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(own) })).toEqual(own);
});

test("the question reads back from the metadata; a notice of a question that carries none, or none with an id, is no notice", () => {
  const content = (n: unknown) => ({ type: "text" as const, text: "x", metadata: { threadNotice: n } });
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(asked) })).toEqual(asked);
  expect(threadNoticeOf(content({ ...asked, question: undefined }))).toBeNull();
  expect(threadNoticeOf(content({ ...asked, question: { id: "q_1", text: 7, options: [] } }))).toBeNull();
  expect(threadNoticeOf(content({ ...asked, question: { text: "Which branch?", options: [] } }))).toBeNull();
  // Options that are not options are dropped; the question stands.
  expect(threadNoticeOf(content({ ...asked, question: { id: "q_1", text: "Which branch?", options: [{ description: "no label" }, "main", { label: "main" }] } }))!.question)
    .toEqual({ id: "q_1", text: "Which branch?", options: [{ label: "main" }] });
  // A stop carries no question.
  expect(threadNoticeOf(content({ ...notice, question: asked.question }))).toEqual(notice);
});

test("an asked question shows its id, the one send_to_thread's answers takes", () => {
  expect(formatThreadNoticeText(asked, null).split("\n")[1]).toBe("Question (q_ab12cd): Push fix/evict-order and open a pull request?");
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
  expect(threadNoticeOf(content(asked))).toEqual(asked);
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
  expect(formatThreadNoticeText({ ...judged, stop: "cannot", requests: ["Publish the docs."] }, "Needs your approval first.")).toBe(
    '[Thread notice] Thread "Search timeout" (thr_1): says your request cannot go on.\n' +
    "Your request: Publish the docs.\nThe thread goes on working on other things.\nLast reply:\nNeeds your approval first."
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

// What a thread said after it answered the agent's request, no one's word
// since: told quietly unless it waits for the user's decision.
const after: ThreadNotice = { handoffIds: [], kind: "thread", targetThreadId: "thr_1", workerId: null, title: "Search timeout", stop: "stopped", reason: null, verdict: "result", after: true };

test("what came after the agent's request reads back, and the model reads it as such", () => {
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(after) })).toEqual(after);
  expect(formatThreadNoticeText(after, "Workers done: the plan is final.").split("\n").slice(1, 3)).toEqual([
    "Manager stop check: its latest reply has a result for the user to read.",
    "This came after the thread answered your request; you did not send this round, and nothing waits on you. Know it for what you tell the user and keep."
  ]);
  expect(formatThreadNoticeText({ ...after, verdict: "decision" }, "Workers done: merge?").split("\n").slice(1, 3)).toEqual([
    "Manager stop check: its latest reply waits for a decision from the user.",
    "This came after the thread answered your request; you did not send this round. Tell the user now: the decision is theirs."
  ]);
  // Only `true` marks it: anything else reads as an ordinary notice.
  expect(threadNoticeOf({ type: "text", text: "x", metadata: { threadNotice: { ...after, after: "yes" } } })!.after).toBeUndefined();
  expect(threadNoticeOf({ type: "text", text: "x", metadata: { threadNotice: { ...after, after: undefined, direct: "yes" } } })!.direct).toBeUndefined();
});

// The user's direct chat with a thread, told once it went quiet: when, how
// many messages, what they said and where the thread stands. Word for word.
const chat: ThreadNotice = {
  handoffIds: [], kind: "thread", targetThreadId: "thr_1", workerId: null, title: "Search timeout", stop: "chat", reason: null,
  chat: { from: "2026-11-17T10:04:10.000Z", to: "2026-11-17T10:22:06.000Z", messages: 2 }, words: "Shorter, please.\n\nShip it."
};

test("a direct chat reads word for word, with the times as the agent reads them, and survives a read-back", () => {
  const time = (at: string) => `<${at.slice(11, 16)}>`;
  expect(formatThreadNoticeText(chat, "Shipped behind the flag.", { time })).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): the user talked with it directly from <10:04> to <10:22> (2 messages) and has seen its replies; you were not told of these rounds as they happened. Keep what it changed, as on your page and the tasks. Tell the user only what still needs them; otherwise no reply is needed.',
    "The user said:",
    "Shorter, please.",
    "",
    "Ship it.",
    "Its latest reply:",
    "Shipped behind the flag."
  ].join("\n"));
  expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(chat) })).toEqual(chat);
  // One message; a reply that waits for the user's decision says so last.
  const one = formatThreadNoticeText({ ...chat, chat: { ...chat.chat!, messages: 1 }, verdict: "decision" }, "The 12th or the 19th?", { time }).split("\n");
  expect(one[0]).toContain("(1 message)");
  expect(one.at(-1)).toBe("Manager stop check: its latest reply waits for a decision from the user.");
  // A result is no line of its own; no reply, no reply section.
  expect(formatThreadNoticeText({ ...chat, verdict: "result" }, "Done.", { time }).split("\n").at(-1)).toBe("Done.");
  expect(formatThreadNoticeText(chat, null, { time })).not.toContain("Its latest reply");
  // Without a time format the times are as stored.
  expect(formatThreadNoticeText(chat, null)).toContain("from 2026-11-17T10:04:10.000Z to 2026-11-17T10:22:06.000Z");
  // A chat without its span is no notice.
  expect(threadNoticeOf({ type: "text", text: "x", metadata: { threadNotice: { ...chat, chat: { from: "x" } } } })).toBeNull();
});

// A wait that ends because the thread needs the user, in a round the user
// started, is theirs to answer: told without a wake, saying so.
test("a needs-you end in the user's own round says the question is theirs, and still carries the reply", () => {
  const own: ThreadNotice = { handoffIds: ["hof_1"], kind: "thread", targetThreadId: "thr_1", workerId: null, title: "Search timeout", stop: "needs_you", reason: null, direct: true };
  expect(formatThreadNoticeText(own, "Ship it behind the flag, or wait for review?")).toBe([
    '[Thread notice] Thread "Search timeout" (thr_1): needs you.',
    "The user is talking with this thread directly and has this question in front of them; it is theirs to answer.",
    "Last reply:",
    "Ship it behind the flag, or wait for review?"
  ].join("\n"));
});

test("duty notices read word for word and survive a read-back", () => {
  const base = { handoffIds: [], kind: "thread" as const, targetThreadId: "thr_d", workerId: null, title: "greenhouse watch", reason: null };
  const report = { ...base, stop: "stopped" as const, duty: "report" as const };
  expect(formatThreadNoticeText(report, "the report")).toBe('[Thread notice] Duty thread "greenhouse watch" (thr_d): reports.\nReport:\nthe report');
  const own = { ...base, stop: "stopped" as const, duty: "owner_round" as const, words: "what do you know?" };
  expect(formatThreadNoticeText(own, "the reply")).toBe('[Thread notice] Duty thread "greenhouse watch" (thr_d): the user wrote to it directly and has its reply in front of them; you did not send this round and nothing waits on you. Keep it in mind for your page and for what you tell the user.\nThe user said:\nwhat do you know?\nIts reply:\nthe reply');
  const failed = { ...base, stop: "failed" as const, duty: "failed" as const, reason: "the model was unreachable" };
  expect(formatThreadNoticeText(failed, "halfway")).toBe('[Thread notice] Duty thread "greenhouse watch" (thr_d): its round failed.\nthe model was unreachable\nLast reply:\nhalfway');
  for (const notice of [report, own, failed]) {
    expect(threadNoticeOf({ type: "text", text: "x", metadata: threadNoticeMetadata(notice) })).toEqual(notice);
  }
});
