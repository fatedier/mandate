import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { decisionQuestion, type JudgementCandidate } from "../src/server/modules/manager-checks/judge.js";
import { readChatChoice } from "../src/server/modules/manager-checks/answer.js";
import { STOP_OPTIONS, stopOutcomeFromDecision } from "../src/server/modules/manager-checks/stop/answer.js";
import { judgeManagerStop, managerStopCheckContext } from "../src/server/modules/manager-checks/stop/manager-stop-check.js";
import { renderPromptFile } from "../src/server/platform/prompts/prompt-template.js";
import stopPromptPath from "../src/server/modules/manager-checks/prompts/manager-stop-check.md" with { type: "file" };

let env: StoresEnv | null = null;
type AppendInput = Parameters<StoresEnv["agentStore"]["appendMessage"]>[0];
afterEach(() => { env?.cleanup(); env = null; });
/** The reply a judgement is about, as its call keeps it. */
const SUBJECT = { replySeq: 7, replyAt: "2026-07-14T09:05:00.000Z" };

function recorder() {
  return new AgentLlmCallRecorder({ store: env!.store, logRequests: "metadata", provider: "gw", model: "m", baseURL: "", apiMode: "streamText" });
}
function chat(texts: string[]): { candidate: JudgementCandidate; model: ReturnType<typeof createMockLLM> } {
  const model = createMockLLM(texts.map((text) => ({ text, finishReason: "stop" as const })), { mode: "stream" });
  return { model, candidate: { kind: "chat", model, provider: "openai-compatible", supportsReasoning: false, recorder: recorder() } };
}

// ---- reading the answer ----

test("a chat model's JSON choice is read; anything else is no answer", async () => {
  expect(readChatChoice("{\"status\": \"decision\"}", STOP_OPTIONS)).toBe("decision");
  expect(readChatChoice("```json\n{\"status\": \"result\"}\n```", STOP_OPTIONS)).toBe("result");
  expect(readChatChoice("{\"status\": \"done\"}", STOP_OPTIONS)).toBeNull();
  expect(readChatChoice("It waits for you.", STOP_OPTIONS)).toBeNull();
  env = freshStoresEnv("md-stop-check-chat-");
  const { model, candidate } = chat(["{\"status\": \"result\"}"]);
  expect((await judgeManagerStop([candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("result");
  const prompt = model.streamCalls[0]!.prompt;
  expect(prompt[0]!.role).toBe("system");
  expect(JSON.stringify(prompt[0]!.content)).toContain("A work thread has stopped: nothing in it runs or will wake by itself.");
});

const decisions: { probabilities: Record<string, number>; outcome: string }[] = [
  { probabilities: { decision: 0.5, result: 0.35, nothing: 0.15 }, outcome: "decision" },
  { probabilities: { decision: 0.1, result: 0.85, nothing: 0.05 }, outcome: "result" },
  { probabilities: { decision: 0.4, result: 0.3, nothing: 0.3 }, outcome: "nothing" },
  { probabilities: { nothing: 1 }, outcome: "nothing" }
];
test.each(decisions)("decision probabilities $probabilities give $outcome", ({ probabilities, outcome }) => {
  expect(stopOutcomeFromDecision(probabilities)).toBe(outcome as never);
});

test("the decision question's criteria are the prompt's three lines, and its instruction its opening", () => {
  const question = decisionQuestion(renderPromptFile(stopPromptPath), STOP_OPTIONS);
  expect(Object.keys(question.criteria)).toEqual(["decision", "result", "nothing"]);
  expect(question.criteria.decision!.startsWith("The latest reply cannot go further until the user chooses")).toBe(true);
  expect(question.criteria.nothing!.startsWith("Anything else:")).toBe(true);
  expect(question.instructions).toContain("Read the latest message the user, or the agent acting for them, sent to the thread");
});

test("each attempt is a manager_stop_check call row on the thread", async () => {
  env = freshStoresEnv("md-stop-check-rows-");
  const first = chat(["No idea."]);
  const second = chat(["{\"status\": \"nothing\"}"]);
  expect((await judgeManagerStop([first.candidate, second.candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("nothing");
  const rows = env.store.listLlmCalls(10).filter((call) => call.purpose === "manager_stop_check");
  expect(rows.map((row) => [row.scopeType, row.scopeId, row.status]).sort()).toEqual([["agent_thread", "thr_1", "failed"], ["agent_thread", "thr_1", "succeeded"]]);
  expect(await judgeManagerStop([], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT })).toBeNull();
});

// ---- the context the judge reads ----

test("the context head names the latest message from the user or Your agent; what came after follows, then the reply", () => {
  env = freshStoresEnv("md-stop-check-context-");
  const thread = env.agentStore.createManagerThread("Release");
  const add = (input: AppendInput) => env!.agentStore.appendMessage(input);
  add({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "An older ask" } });
  add({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Pick the release date", relay: { by: "global", spoken: false, handoffId: "hof_1", name: "Juno" } } });
  add({ threadId: thread.id, role: "user", source: "worker-report", content: { type: "text", text: "[Worker report] calendar read" } });
  const reply = add({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Two dates are free: the 12th or the 19th?" } });
  const ctx = managerStopCheckContext(env.agentStore, thread.id, { seq: reply.seq, text: "Two dates are free: the 12th or the 19th?", at: reply.createdAt });
  expect(ctx.startsWith("Latest message to the thread from the user, or the agent acting for them (")).toBe(true);
  expect(ctx).toContain("Pick the release date");
  expect(ctx).not.toContain("An older ask");
  expect(ctx).toContain("Worker report: [Worker report] calendar read");
  expect(ctx.endsWith("Two dates are free: the 12th or the 19th?")).toBe(true);
});

test("a thread nobody wrote to is read from its start, with no head", () => {
  env = freshStoresEnv("md-stop-check-context-none-");
  const thread = env.agentStore.createManagerThread("Nightly");
  const add = (input: AppendInput) => env!.agentStore.appendMessage(input);
  add({ threadId: thread.id, role: "user", source: "worker-report", content: { type: "text", text: "[Worker report] build green" } });
  const reply = add({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "The nightly build is green." } });
  const ctx = managerStopCheckContext(env.agentStore, thread.id, { seq: reply.seq, text: "The nightly build is green.", at: reply.createdAt });
  expect(ctx.startsWith("Everything in the thread, oldest first:\n")).toBe(true);
  expect(ctx).toContain("Worker report: [Worker report] build green");
});

test("the manager stop check's answer is kept in its call, with its options and the reply it was about", async () => {
  env = freshStoresEnv("md-stop-check-record-");
  const judged = await judgeManagerStop([chat(["{\"status\": \"decision\"}"]).candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT });
  judged!.notUsed("archived");
  const row = env.store.listLlmCalls(10).find((call) => call.purpose === "manager_stop_check")!;
  expect(row.metadata?.judgement).toEqual({ options: ["decision", "result", "nothing"], answer: "decision", subject: SUBJECT, notUsed: "archived" });
});
