import { expect, test } from "bun:test";
import type { AgentMessageContent, AgentMessageSource } from "../src/shared/agent-message-types.js";
import { featureMessageNoteMetadata, featureMessageReplyMetadata, featureMessageRequestMetadata } from "../src/shared/feature-message.js";
import {
  answersMetadata, answersOf, controlMetadata, openQuestionsOf, openWhenWrittenMetadata, withoutQueuedAnswers,
  type QuestionOption, type QuestionRow
} from "../src/shared/questions.js";

const AT = "2026-01-12T14:00:00.000Z";

function asked(id: string, question: string, options: QuestionOption[] = [], over: Record<string, unknown> = {}): QuestionRow {
  return {
    role: "tool", source: "self", createdAt: AT,
    content: { type: "tool_result", toolCallId: `call_${id}`, toolName: "ask_user", result: { asked: true, questionId: id, question, options }, ...over }
  };
}

function withdrew(id: string, over: Record<string, unknown> = {}): QuestionRow {
  return {
    role: "tool", source: "self", createdAt: AT,
    content: { type: "tool_result", toolCallId: `call_w_${id}`, toolName: "withdraw_question", result: { withdrawn: true, questionId: id }, ...over }
  };
}

function said(text: string, over: Partial<Extract<AgentMessageContent, { type: "text" }>> = {}, source: AgentMessageSource = "user"): QuestionRow {
  return { role: "user", source, createdAt: AT, content: { type: "text", text, ...over } };
}

const ids = (rows: QuestionRow[]) => openQuestionsOf(rows).map((q) => q.id);

test("a question is open from the moment it is asked, with the answers it suggests", () => {
  expect(openQuestionsOf([asked("q_1", "Push the branch?")])).toEqual([{ id: "q_1", question: "Push the branch?", options: [], askedAt: AT }]);
  const options = [{ label: "Push now", description: "The tests pass." }, { label: "Hold it" }];
  expect(openQuestionsOf([asked("q_1", "Push the branch?", options)])[0]!.options).toEqual(options);
});

test("a message the user types answers nothing: it may be about something else, and only they know", () => {
  expect(ids([asked("q_1", "Push?"), asked("q_2", "Tag?"), said("Yes to both")])).toEqual(["q_1", "q_2"]);
});

test("a pick answers only the question it names", () => {
  const pick = said("Push now", { metadata: answersMetadata([{ id: "q_1", question: "Push?" }]) });
  expect(answersOf(pick.content)).toEqual([{ id: "q_1", question: "Push?" }]);
  expect(ids([asked("q_1", "Push?"), asked("q_2", "Tag?"), pick])).toEqual(["q_2"]);
});

test("what the user says aloud answers nothing, as what they type; a pick made while talking does", () => {
  expect(ids([asked("q_1", "Push?"), said("Yes", {}, "voice")])).toEqual(["q_1"]);
  expect(ids([asked("q_1", "Push?"), said("Push it", { metadata: answersMetadata([{ id: "q_1", question: "Push?" }]) }, "voice")])).toEqual([]);
  // The agent's own spoken words are not the user's.
  const spokenByAgent: QuestionRow = { role: "assistant", source: "voice", createdAt: AT, content: { type: "assistant", text: "Shall I push?" } };
  expect(ids([asked("q_1", "Push?"), spokenByAgent])).toEqual(["q_1"]);
});

test("what the agent sends on the user's behalf answers the question it names, and nothing else", () => {
  const relay = { by: "global" as const, spoken: false, handoffId: "hof_1", name: "Juno" };
  expect(ids([asked("q_1", "Push?"), asked("q_2", "Tag?"), said('"Push it."', { relay, metadata: answersMetadata([{ id: "q_1", question: "Push?" }]) })])).toEqual(["q_2"]);
  expect(ids([asked("q_1", "Push?"), said('"Look at the logs."', { relay })])).toEqual(["q_1"]);
});

test("the note of what the user told a worker directly answers nothing, nor a worker's reply or a request", () => {
  const note = said("The user wrote to your worker…", { metadata: featureMessageNoteMetadata({ featureId: "f1", featureName: "evict", by: "user", text: "Push it.", attachments: 0 }) }, "feature-message");
  expect(ids([asked("q_1", "Push?"), note])).toEqual(["q_1"]);
  const reply = said("Done.", { metadata: featureMessageReplyMetadata({ featureId: "f1" }) }, "feature-message");
  const request = said("Do it.", { metadata: featureMessageRequestMetadata() }, "feature-message");
  expect(ids([asked("q_1", "Push?"), reply, request])).toEqual(["q_1"]);
});

test("a worker's report, an alarm, a monitor firing, a notice and a page note answer nothing", () => {
  const sources: AgentMessageSource[] = ["worker-report", "alarm", "monitor", "watch", "thread-notice", "runtime-context", "manager", "restart-recovery", "page-input", "page-result"];
  for (const source of sources) {
    expect([source, ids([asked("q_1", "Push?"), said("[something happened]", {}, source)])]).toEqual([source, ["q_1"]]);
  }
});

test("a withdrawal takes back one question, and only when it went through", () => {
  expect(ids([asked("q_1", "Push?"), asked("q_2", "Tag?"), withdrew("q_1")])).toEqual(["q_2"]);
  expect(ids([asked("q_1", "Push?"), withdrew("q_1", { isError: true, error: "refused" })])).toEqual(["q_1"]);
  expect(ids([asked("q_1", "Push?"), withdrew("q_1", { result: { error: "not an open question of this conversation: q_1" } })])).toEqual(["q_1"]);
  expect(ids([asked("q_1", "Push?"), withdrew("q_1", { result: { withdrawn: false, questionId: "q_1" } })])).toEqual(["q_1"]);
});

test("a result that is not an accepted question opens nothing", () => {
  expect(ids([asked("q_1", "Push?", [], { isError: true, error: "bad arguments" })])).toEqual([]);
  expect(ids([asked("q_1", "Push?", [], { result: { asked: false, questionId: "q_1", question: "Push?" } })])).toEqual([]);
  expect(ids([asked("q_1", "Push?", [], { result: { asked: true, question: "Push?" } })])).toEqual([]);
  expect(ids([asked("q_1", "Push?", [], { result: "asked: true, questionId: q_1" })])).toEqual([]);
  // Another tool whose result happens to have the shape.
  expect(ids([asked("q_1", "Push?", [], { toolName: "bash" })])).toEqual([]);
  // An option with no label is dropped; the question stands.
  expect(openQuestionsOf([asked("q_1", "Push?", [], { result: { asked: true, questionId: "q_1", question: "Push?", options: [{ description: "x" }, { label: "Yes" }, "No"] } })])[0]!.options).toEqual([{ label: "Yes" }]);
});

test("queued answers close a question before they land", () => {
  const open = openQuestionsOf([asked("q_1", "Push?"), asked("q_2", "Tag?")]);
  // A typed message waits behind the turn: it answers nothing.
  expect(withoutQueuedAnswers(open, [{ answers: [] }]).map((q) => q.id)).toEqual(["q_1", "q_2"]);
  expect(withoutQueuedAnswers(open, [{ answers: [{ id: "q_1", question: "Push?" }] }]).map((q) => q.id)).toEqual(["q_2"]);
  expect(withoutQueuedAnswers(open, []).map((q) => q.id)).toEqual(["q_1", "q_2"]);
});

test("the same id seen twice is one question, as it was last asked", () => {
  expect(openQuestionsOf([asked("q_1", "Push?"), asked("q_2", "Tag?"), asked("q_1", "Push the branch?")]).map((q) => [q.id, q.question]))
    .toEqual([["q_2", "Tag?"], ["q_1", "Push the branch?"]]);
});

test("a mark that names no question is no mark: the message answers nothing", () => {
  const empty = said("Yes", { metadata: { answers: [] } });
  expect(answersOf(empty.content)).toEqual([]);
  expect(ids([asked("q_1", "Push?"), empty])).toEqual(["q_1"]);
  const junk = said("Yes", { metadata: { answers: [{ question: "no id" }, 7, null] } });
  expect(ids([asked("q_1", "Push?"), junk])).toEqual(["q_1"]);
});

// A message taken in while the asker's turn ran lands later, after whatever
// that turn went on to do. Typed, it answers nothing, whatever stood; a pick
// that waited answers what it names.
test("a message that waited behind a running turn answers what it names, and a typed one nothing", () => {
  const waited = (stood: string[], over: Record<string, unknown> = {}) => said("Yes, go ahead with the rename.", { metadata: { ...openWhenWrittenMetadata(stood), ...over } });
  expect(ids([asked("q_1", "Rename it?"), asked("q_2", "Push to main now?"), waited(["q_1"])])).toEqual(["q_1", "q_2"]);
  expect(ids([asked("q_1", "Rename it?"), asked("q_2", "Push to main now?"), waited(["q_1", "q_2"], answersMetadata([{ id: "q_1", question: "Rename it?" }]))])).toEqual(["q_2"]);
  const open = openQuestionsOf([asked("q_1", "Rename it?"), asked("q_2", "Push to main now?")]);
  expect(withoutQueuedAnswers(open, [{ answers: [], openWhenWritten: ["q_1"] }]).map((q) => q.id)).toEqual(["q_1", "q_2"]);
  expect(withoutQueuedAnswers(open, [{ answers: [], openWhenWritten: ["q_1"] }, { answers: [{ id: "q_2", question: "Push to main now?" }] }]).map((q) => q.id)).toEqual(["q_1"]);
});

test("what a control sends for the user is not their answer, even naming a question", () => {
  // Continue, pressed under a turn that stopped at its limit: the questions it asked still stand.
  expect(ids([asked("q_1", "Push to main now?"), said("Continue", { metadata: { ...controlMetadata("continue"), ...answersMetadata([{ id: "q_1", question: "Push to main now?" }]) } })])).toEqual(["q_1"]);
});

test("a message that closed questions under an earlier rule keeps what it closed, and only that", () => {
  // Typed when a message answered every open question: what it closed then
  // is kept on it, out of the model's sight.
  const kept = said("Yes to both", { metadata: { closedQuestions: ["q_1", "q_2"] } });
  expect(ids([asked("q_1", "Push?"), asked("q_2", "Tag?"), asked("q_3", "Ship?"), kept])).toEqual(["q_3"]);
  // A mark that is not a list of ids closes nothing; nor one on a control's message.
  for (const closedQuestions of ["q_1", [7], { id: "q_1" }, null]) {
    expect(ids([asked("q_1", "Push?"), said("x", { metadata: { closedQuestions } })])).toEqual(["q_1"]);
  }
  expect(ids([asked("q_1", "Push?"), said("Continue", { metadata: { ...controlMetadata("continue"), closedQuestions: ["q_1"] } })])).toEqual(["q_1"]);
});
