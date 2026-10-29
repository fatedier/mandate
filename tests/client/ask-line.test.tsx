import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { AssistantMessage } from "@/routes/window/chat/AssistantMessage";
import { answeredQuestions, askedBy, askOpenKey, askState, openAskPausesFollow, skippedQuestions, withdrawnQuestions, type QuestionMarks } from "@/routes/window/chat/ask-lines";
import { toolResultsOf } from "@/routes/window/chat/transcript-rows";
import { describeCall, type ToolRunRow } from "@/routes/window/chat/tool-run-summary";
import type { AgentMessage } from "@/store/agent-chat";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

afterEach(() => runCleanups());

// A question that went through is not a tool call to the reader: it is one
// line where it was asked, which says whether it still waits for them.

const at = (second: number) => `2026-01-12T14:00:${String(second).padStart(2, "0")}.000Z`;
const base = { threadId: "thr-1", sourceThreadId: null, source: "user", wakeId: "w1" } as const;
type Call = { id: string; name: string; args?: Record<string, unknown> };
const step = (seq: number, text: string, calls: Call[]): AgentMessage => ({
  ...base, id: `a${seq}`, seq, role: "assistant", createdAt: at(seq),
  content: { type: "assistant", text, toolCalls: calls.map((c) => ({ toolCallId: c.id, toolName: c.name, args: c.args ?? {} })) }
} as AgentMessage);
const answer = (seq: number, callId: string, name: string, result: unknown, isError = false): AgentMessage => ({
  ...base, id: `t${seq}`, seq, role: "tool", createdAt: at(seq),
  content: { type: "tool_result", toolCallId: callId, toolName: name, result, isError }
} as AgentMessage);
const asks = (id: string, question: string): Call => ({ id, name: "ask_user", args: { question } });
const asked = (seq: number, callId: string, questionId: string, question: string) =>
  answer(seq, callId, "ask_user", { asked: true, questionId, question, options: [{ label: "Yes" }, { label: "Not yet" }] });

const PUSH = "Push fix/evict-order and open a pull request?";
const none: QuestionMarks = { open: new Set(), withdrawn: new Set(), skipped: new Set() };
const open = (...ids: string[]): QuestionMarks => ({ open: new Set(ids), withdrawn: new Set(), skipped: new Set() });

function render(messages: AgentMessage[], questions: QuestionMarks | undefined, over: { runTail?: AgentMessage[]; active?: string } = {}) {
  const [message] = messages.filter((m) => m.role === "assistant");
  const { host } = mount(
    <AssistantMessage
      message={message!}
      runTail={over.runTail}
      toolResultsByCallId={toolResultsOf(messages)}
      activeToolCallId={over.active ?? null}
      questions={questions}
    />
  );
  const lines = [...host.querySelectorAll<HTMLElement>('[data-slot="ask-line"]')].map((line) => ({
    state: line.dataset.state,
    label: line.querySelector('[data-slot="ask-line-label"]')!.textContent,
    question: line.querySelector('[data-slot="ask-line-question"]')!.textContent
  }));
  return { host, lines, run: host.querySelector<HTMLElement>('[data-slot="tool-run-line"]')?.textContent ?? null };
}

test("a question the turn asked is one line under its words, and its call leaves the run", () => {
  const { host, lines, run } = render([
    step(1, "The fix is in.", [{ id: "c1", name: "read_plan" }, asks("c2", PUSH)]),
    answer(2, "c1", "read_plan", { ok: true }),
    asked(3, "c2", "q_1", PUSH)
  ], open("q_1"));
  expect(lines).toEqual([{ state: "open", label: "Asked you", question: PUSH }]);
  // The run holds the other call alone: one call reads as what it did.
  expect(run).toContain("Read the plan");
  expect(run).not.toContain("Asked");
  // The line comes after the words and the run.
  const order = [...host.querySelectorAll("[data-slot]")].map((el) => el.getAttribute("data-slot")).filter((name) => name === "tool-run" || name === "ask-line");
  expect(order).toEqual(["tool-run", "ask-line"]);
});

test("a turn that only asked draws its line and no run", () => {
  const { host, lines } = render([step(1, "", [asks("c1", PUSH)]), asked(2, "c1", "q_1", PUSH)], open("q_1"));
  expect(lines).toEqual([{ state: "open", label: "Asked you", question: PUSH }]);
  expect(host.querySelector('[data-slot="tool-run"]') === null).toBe(true);
});

test("the line goes quiet once the question is answered, and says so when it was taken back", () => {
  const messages = [step(1, "", [asks("c1", PUSH), asks("c2", "Tag it too?")]), asked(2, "c1", "q_1", PUSH), asked(3, "c2", "q_2", "Tag it too?")];
  // Neither is open any more; the second was withdrawn.
  const { host, lines } = render(messages, { open: new Set(), withdrawn: new Set(["q_2"]), skipped: new Set() });
  expect(lines).toEqual([
    // Said in words too, not by the colour alone.
    { state: "answered", label: "Asked you · answered", question: PUSH },
    { state: "withdrawn", label: "Asked you · withdrawn", question: "Tag it too?" }
  ]);
  // Struck through: a question nobody needs to answer any more.
  expect([...host.querySelectorAll('[data-slot="ask-line-question"]')].map((el) => el.tagName)).toEqual(["SPAN", "S"]);
  // Where the conversation's open questions are not known (an archived
  // thread's page), a question reads as answered.
  expect(render(messages, undefined).lines.map((line) => line.state)).toStrictEqual(["answered", "answered"]);
});

test("questions asked in a later step of the row are lines too, in the order asked", () => {
  const first = step(1, "Two things.", [asks("c1", PUSH)]);
  const second = step(3, "", [asks("c2", "Tag it too?")]);
  const { lines } = render([first, asked(2, "c1", "q_1", PUSH), second, asked(4, "c2", "q_2", "Tag it too?")], open("q_1", "q_2"), { runTail: [second] });
  expect(lines.map((line) => [line.state, line.question])).toEqual([["open", PUSH], ["open", "Tag it too?"]]);
});

test("a question that was refused, and one still being asked, stay calls in the run", () => {
  const refused = render([step(1, "", [asks("c1", PUSH)]), answer(2, "c1", "ask_user", null, true)], none);
  expect(refused.lines).toEqual([]);
  expect(refused.run).toContain("Asked you");
  expect(refused.run).toContain(PUSH);
  const running = render([step(1, "", [asks("c1", PUSH)])], none, { active: "c1" });
  expect(running.lines).toEqual([]);
  expect(running.run).toContain("Asking you");
});

test("a withdrawal in the row that asked is said by the line alone; anywhere else it is a call of its turn", () => {
  const taken = (seq: number, callId: string, questionId: string) => answer(seq, callId, "withdraw_question", { withdrawn: true, questionId });
  const withdrawn: QuestionMarks = { open: new Set(), withdrawn: new Set(["q_1"]), skipped: new Set() };
  // Asked and taken back in one stretch of work: the line says both.
  const asking = step(1, "", [asks("c1", PUSH)]);
  const taking = step(3, "", [{ id: "c2", name: "withdraw_question", args: { questionId: "q_1" } }]);
  const together = render([asking, asked(2, "c1", "q_1", PUSH), taking, taken(4, "c2", "q_1")], withdrawn, { runTail: [taking] });
  expect(together.lines).toEqual([{ state: "withdrawn", label: "Asked you · withdrawn", question: PUSH }]);
  expect(together.run).toBeNull();
  // Taken back in a later row: there it is what the turn did.
  const later = render([taking, taken(4, "c2", "q_1")], withdrawn);
  expect(later.lines).toEqual([]);
  expect(later.run).toContain("Withdrew a question");
  // One that was refused took nothing back, and stays a call beside its question's line.
  const refused = render([asking, asked(2, "c1", "q_1", PUSH), taking, answer(4, "c2", "withdraw_question", { error: "not an open question of this conversation: q_1" })], open("q_1"), { runTail: [taking] });
  expect(refused.lines.map((line) => line.state)).toStrictEqual(["open"]);
  expect(refused.run).toContain("Withdrew a question");
});

test("only what the ask tool accepted is a question", () => {
  const call = { toolCallId: "c1", toolName: "ask_user", args: { question: PUSH } };
  const accepted = { result: { asked: true, questionId: "q_1", question: PUSH, options: [] }, createdAt: at(2) };
  expect(askedBy(call, accepted)).toEqual({ id: "q_1", question: PUSH, options: [], askedAt: at(2) });
  expect(askedBy(call, { ...accepted, isError: true })).toBeNull();
  expect(askedBy(call, null)).toBeNull();
  expect(askedBy(call, { result: { asked: false, questionId: "q_1", question: PUSH } })).toBeNull();
  // Another tool whose result has the same shape asked nothing.
  expect(askedBy({ ...call, toolName: "update_plan" }, accepted)).toBeNull();
});

test("the questions a conversation took back are read from its withdrawals that went through", () => {
  expect([...withdrawnQuestions([
    step(1, "", [{ id: "c1", name: "withdraw_question" }, { id: "c2", name: "withdraw_question" }, { id: "c3", name: "withdraw_question" }]),
    answer(2, "c1", "withdraw_question", { withdrawn: true, questionId: "q_1" }),
    answer(3, "c2", "withdraw_question", { error: "not an open question of this conversation: q_9" }),
    answer(4, "c3", "withdraw_question", { withdrawn: true, questionId: "q_3" }, true)
  ])]).toEqual(["q_1"]);
});

test("taking a question back reads as that; a question on its way reads as being asked", () => {
  const row = (name: string, args: Record<string, unknown>, isRunning = false): ToolRunRow =>
    ({ call: { toolCallId: "c1", toolName: name, args }, result: isRunning ? null : { result: { ok: true } }, isRunning });
  const phrase = (r: ToolRunRow) => { const p = describeCall(r); return [p.lead, p.detail, p.leadIsToolName]; };
  expect(phrase(row("withdraw_question", { questionId: "q_1" }))).toEqual(["Withdrew a question", "", false]);
  expect(phrase(row("withdraw_question", { questionId: "q_1" }, true))).toEqual(["Withdrawing a question", "", false]);
  expect(phrase(row("ask_user", { question: PUSH }))).toEqual(["Asked you", PUSH, false]);
  expect(phrase(row("ask_user", { question: PUSH }, true))).toEqual(["Asking you", PUSH, false]);
});

test("the questions the user skipped are read from the skip rows only; a message that closed one under the old rule reads as answering it", () => {
  const row = (id: string, source: string, closedQuestions: unknown) => ({
    id, threadId: "t", seq: 1, role: "user", source, sourceThreadId: null, wakeId: null, createdAt: "2026-01-12T14:00:00.000Z",
    content: { type: "text", text: "…", metadata: { closedQuestions } }
  } as AgentMessage);
  const skipped = skippedQuestions([row("s1", "question-skip", ["q_1"]), row("u1", "user", ["q_2"]), row("s2", "question-skip", "q_3")]);
  expect([...skipped]).toEqual(["q_1"]);
  const marks: QuestionMarks = { open: new Set(["q_4"]), withdrawn: new Set(["q_5"]), skipped: new Set(["q_1", "q_4", "q_5"]) };
  expect(["q_1", "q_2", "q_4", "q_5"].map((id) => askState(id, marks))).toEqual(["skipped", "answered", "open", "withdrawn"]);
});

// Once a question is answered (or skipped, or taken back) its line opens in
// place: the whole question as the chat draws it, its suggested answers, and
// the user's own answer marked. One still open stays a plain line: its card
// above the composer shows it whole.

const MD = "Push `fix/evict-order` and open a **pull request**? See [the changelog](https://example.com/changelog).";
const MD_WORDS = "Push fix/evict-order and open a pull request? See the changelog.";
const askedWith = (seq: number, callId: string, questionId: string, question: string) =>
  answer(seq, callId, "ask_user", { asked: true, questionId, question, options: [{ label: "Push it", description: "Open the pull request, do not merge" }, { label: "Not yet" }] });
const marks = (over: Partial<QuestionMarks> = {}): QuestionMarks => ({ open: new Set(), withdrawn: new Set(), skipped: new Set(), ...over });
function renderOne(questions: QuestionMarks, over: { expanded?: Set<string>; onChange?: (id: string, open: boolean) => void } = {}) {
  const messages = [step(1, "", [asks("c1", MD)]), askedWith(2, "c1", "q_1", MD)];
  const { host } = mount(
    <MemoryRouter>
      <AssistantMessage
        message={messages[0]!}
        toolResultsByCallId={toolResultsOf(messages)}
        activeToolCallId={null}
        questions={questions}
        {...(over.expanded ? { expandedToolIds: over.expanded } : {})}
        {...(over.onChange ? { onToolExpandedChange: over.onChange } : {})}
      />
    </MemoryRouter>
  );
  const line = host.querySelector<HTMLElement>('[data-slot="ask-line"]')!;
  const toggle = line.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const body = () => line.querySelector<HTMLElement>('[data-slot="ask-line-body"]');
  const options = () => [...line.querySelectorAll<HTMLElement>('[data-slot="ask-line-option"]')].map((o) => [o.textContent, o.dataset.picked === "true"]);
  return { line, toggle, body, options };
}

test("an answered question's line opens to the whole question, drawn as the chat draws it, and its answers, the one picked marked as the user's", async () => {
  const { line, toggle, body, options } = renderOne(marks({ answers: new Map([["q_1", "Push it"]]) }));
  expect(line.querySelector('[data-slot="ask-line-question"]')!.textContent).toBe(MD_WORDS);
  expect([toggle!.getAttribute("aria-expanded"), body() === null]).toEqual(["false", true]);
  await act(async () => { toggle!.click(); });
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");
  const full = body()!.querySelector<HTMLElement>('[data-slot="ask-line-full"]')!;
  expect([full.querySelector("code")?.textContent, full.querySelector("strong")?.textContent, full.querySelector("a")?.getAttribute("href")]).toEqual(["fix/evict-order", "pull request", "https://example.com/changelog"]);
  expect(options()).toEqual([["Push it · Your answerOpen the pull request, do not merge", true], ["Not yet", false]]);
  expect(body()!.querySelector('[data-slot="ask-line-answer"]') === null).toBe(true);
  await act(async () => { toggle!.click(); });
  expect(toggle!.getAttribute("aria-expanded")).toBe("false");
});

test("an answer the user typed stands under the suggestions as theirs, none of them marked", async () => {
  const { toggle, body, options } = renderOne(marks({ answers: new Map([["q_1", "Push it, with the v3 tag"]]) }));
  await act(async () => { toggle!.click(); });
  expect(options().map(([, picked]) => picked)).toEqual([false, false]);
  expect(body()!.querySelector('[data-slot="ask-line-answer"]')!.textContent).toBe("Your answerPush it, with the v3 tag");
});

test("a question skipped or taken back opens to itself and its suggestions, with no answer", async () => {
  for (const questions of [marks({ skipped: new Set(["q_1"]) }), marks({ withdrawn: new Set(["q_1"]) })]) {
    const { toggle, body, options } = renderOne(questions);
    await act(async () => { toggle!.click(); });
    expect([body()!.querySelector('[data-slot="ask-line-full"]')!.textContent, options().length, body()!.textContent!.includes("Your answer")]).toEqual([MD_WORDS, 2, false]);
    runCleanups();
  }
});

test("a question still open is a plain line: nothing to open", () => {
  const { line, toggle } = renderOne(marks({ open: new Set(["q_1"]) }));
  expect([toggle === null, line.querySelector("button") === null]).toEqual([true, true]);
});

test("whether the line is open is the transcript's to keep: drawn open from it, and a click asks it to close", async () => {
  const changes: Array<[string, boolean]> = [];
  const { toggle, body } = renderOne(marks(), { expanded: new Set([askOpenKey("q_1")]), onChange: (id, open) => changes.push([id, open]) });
  expect([toggle!.getAttribute("aria-expanded"), body() !== null]).toEqual(["true", true]);
  await act(async () => { toggle!.click(); });
  expect(changes).toStrictEqual([[askOpenKey("q_1"), false]]);
});

test("what the user answered each question with is read from their messages that name it", () => {
  const user = (seq: number, text: string, ids: string[]): AgentMessage => ({
    ...base, id: `u${seq}`, seq, role: "user", createdAt: at(seq),
    content: { type: "text", text, metadata: { answers: ids.map((id) => ({ id, question: "?" })) } }
  } as AgentMessage);
  expect([...answeredQuestions([user(1, "Push it", ["q_1"]), user(2, "Both: yes", ["q_2", "q_3"]), user(3, "Thanks.", [])])]).toEqual([["q_1", "Push it"], ["q_2", "Both: yes"], ["q_3", "Both: yes"]]);
});

test("an answered question's line, open where it is drawn, holds the reader's place as an open fold does; a still-open question, a closed line or a line not drawn holds nothing", () => {
  const messages = [step(1, "", [asks("c1", PUSH), asks("c2", "Tag it too?")]), asked(2, "c1", "q_1", PUSH), asked(3, "c2", "q_2", "Tag it too?")];
  const rows = [{ kind: "msg" as const, message: messages[0]! }];
  const results = toolResultsOf(messages);
  expect(openAskPausesFollow(rows, results, new Set([askOpenKey("q_1")]), new Set())).toBe(true);
  expect(openAskPausesFollow(rows, results, new Set(), new Set())).toBe(false);
  // Still open: its line does not open, so its mark holds nothing.
  expect(openAskPausesFollow(rows, results, new Set([askOpenKey("q_2")]), new Set(["q_2"]))).toBe(false);
  // A mark whose line is not drawn.
  expect(openAskPausesFollow(rows, results, new Set([askOpenKey("q_gone")]), new Set())).toBe(false);
});
