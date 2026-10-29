import { afterEach, expect, test } from "bun:test";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { createMockLLM } from "./helpers/mock-llm.js";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import { renderManagerRequestCheckContext, threadEventsSince } from "../src/server/modules/manager-checks/context.js";
import { requestOutcomeFromDecision, readChatAnswer } from "../src/server/modules/manager-checks/request/answer.js";
import { judgementCandidatesOf, type JudgementCandidate } from "../src/server/modules/manager-checks/judge.js";
import { judgeManagerRequest } from "../src/server/modules/manager-checks/request/manager-request-check.js";
import type { ResolvedProviderConfig } from "../src/server/config.js";

let env: StoresEnv | null = null;
type AppendInput = Parameters<StoresEnv["agentStore"]["appendMessage"]>[0];
afterEach(() => { env?.cleanup(); env = null; });

// ---- the context the judge reads ----

test("renders its context: the request, what happened since, oldest first, and the latest reply", () => {
  const text = renderManagerRequestCheckContext({
    request: "Merge #41 once the pipeline passes.",
    requestAt: "2026-03-04T09:15:10.000Z",
    events: [
      { at: "2026-03-04T09:15:30.000Z", line: "Manager called feature_message_send({\"featureId\":\"feat_1\",\"message\":\"Merge #41\"})" },
      { at: "2026-03-04T09:16:00.000Z", line: "Worker report: merged #41" }
    ],
    latest: { text: "Merged #41; the pipeline passed.", at: "2026-03-04T09:16:07.000Z" }
  });
  expect(text).toBe([
    "Request sent to the thread (03-04 09:15):",
    "Merge #41 once the pipeline passes.",
    "",
    "Everything in the thread since, oldest first:",
    "[03-04 09:15] Manager called feature_message_send({\"featureId\":\"feat_1\",\"message\":\"Merge #41\"})",
    "[03-04 09:16] Worker report: merged #41",
    "",
    "The thread's latest reply (03-04 09:16):",
    "Merged #41; the pipeline passed."
  ].join("\n"));
});

test("with nothing between the request and the reply there is no events block", () => {
  const text = renderManagerRequestCheckContext({ request: "Tag 3.21", requestAt: "2026-03-04T09:15:10.000Z", events: [], latest: { text: "Tagged.", at: "2026-03-04T09:16:07.000Z" } });
  expect(text).toBe("Request sent to the thread (03-04 09:15):\nTag 3.21\n\nThe thread's latest reply (03-04 09:16):\nTagged.");
});

test("long history keeps the request and the latest reply within 60,000 characters, dropping the oldest events", () => {
  const events = Array.from({ length: 2000 }, (_, i) => ({ at: "2026-03-04T09:15:30.000Z", line: `Manager: step ${i} ${"x".repeat(60)}` }));
  const text = renderManagerRequestCheckContext({ request: "Merge it", requestAt: "2026-03-04T09:15:10.000Z", events, latest: { text: "Merged.", at: "2026-03-04T09:16:07.000Z" } });
  expect(text.length).toBeLessThanOrEqual(60_000);
  expect(text.startsWith("Request sent to the thread (03-04 09:15):\nMerge it\n")).toBe(true);
  expect(text.endsWith("The thread's latest reply (03-04 09:16):\nMerged.")).toBe(true);
  expect(text).toContain("step 1999 ");
  expect(text).not.toContain("step 0 ");
});

test("thread events: manager text and tool calls, results, workers' words, the agent's other requests and the user's own; no runtime context", () => {
  env = freshStoresEnv("md-request-check-events-");
  const thread = env.agentStore.createManagerThread("Release");
  const add = (input: AppendInput) => env!.agentStore.appendMessage(input);
  const request = add({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Merge #41", relay: { by: "global", spoken: false, handoffId: "hof_1", name: "Juno" } } });
  add({ threadId: thread.id, role: "user", source: "runtime-context", content: { type: "text", text: "[runtime_context] digest" } });
  add({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "On it.", toolCalls: [{ toolCallId: "c1", toolName: "feature_message_send", args: { featureId: "feat_1", message: "Merge #41" } }] } });
  add({ threadId: thread.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c1", toolName: "feature_message_send", result: { status: "started" } } });
  add({ threadId: thread.id, role: "user", source: "worker-report", content: { type: "text", text: "[Worker report] merged" } });
  add({ threadId: thread.id, role: "user", source: "feature-message", content: { type: "text", text: "Pipeline green." } });
  add({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "Also tag it", relay: { by: "global", spoken: false, handoffId: "hof_2", name: "Juno" } } });
  add({ threadId: thread.id, role: "user", source: "user", content: { type: "text", text: "never mind the tag" } });
  add({ threadId: thread.id, role: "user", source: "command-result", content: { type: "text", text: "exit 0" } });
  const reply = add({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "Merged.", toolCalls: [] } });
  const lines = threadEventsSince(env.agentStore, thread.id, request.seq, reply.seq).map((event) => event.line);
  expect(lines).toEqual([
    "Manager: On it.",
    "Manager called feature_message_send({\"featureId\":\"feat_1\",\"message\":\"Merge #41\"})",
    "feature_message_send result: {\"status\":\"started\"}",
    "Worker report: [Worker report] merged",
    "Worker message: Pipeline green.",
    "Another request from the agent: Also tag it",
    "User: never mind the tag",
    "Command result: exit 0"
  ]);
});

test("thread events cut each kind to its limit", () => {
  env = freshStoresEnv("md-request-check-cuts-");
  const thread = env.agentStore.createManagerThread("Release");
  const add = (input: AppendInput) => env!.agentStore.appendMessage(input);
  add({ threadId: thread.id, role: "assistant", source: "self", content: { type: "assistant", text: "m".repeat(2500), toolCalls: [{ toolCallId: "c1", toolName: "bash", args: { command: "a".repeat(900) } }] } });
  add({ threadId: thread.id, role: "tool", source: "self", content: { type: "tool_result", toolCallId: "c1", toolName: "bash", result: "r".repeat(400) } });
  add({ threadId: thread.id, role: "user", source: "worker-report", content: { type: "text", text: "w".repeat(1600) } });
  const [text, call, result, report] = threadEventsSince(env.agentStore, thread.id, 0, 99).map((event) => event.line);
  expect(text).toBe(`Manager: ${"m".repeat(2000)}`);
  expect(call!.length).toBe("Manager called bash(".length + 800 + 1);
  expect(result).toBe(`bash result: ${"r".repeat(300)}`);
  expect(report).toBe(`Worker report: ${"w".repeat(1500)}`);
});

// ---- reading the answer ----

const chatAnswers: { text: string; outcome: string | null }[] = [
  { text: "{\"status\": \"done\"}", outcome: "done" },
  { text: "```json\n{\"status\": \"cannot\"}\n```", outcome: "cannot" },
  { text: "Sure. {\"status\":\"working\"} Hope that helps.", outcome: "working" },
  { text: "The work is done.", outcome: null },
  { text: "{\"status\": \"finished\"}", outcome: null }
];
test.each(chatAnswers)("readChatAnswer($text) is $outcome", ({ text, outcome }) => {
  expect(readChatAnswer(text)).toBe(outcome as never);
});

const decisions: { probabilities: Record<string, number>; outcome: string }[] = [
  { probabilities: { done: 0.9, cannot: 0.05, working: 0.05 }, outcome: "done" },
  { probabilities: { done: 0.5, cannot: 0.35, working: 0.15 }, outcome: "done" },
  { probabilities: { done: 0.1, cannot: 0.82, working: 0.08 }, outcome: "cannot" },
  { probabilities: { done: 0.4, cannot: 0.3, working: 0.3 }, outcome: "working" },
  { probabilities: { done: 0.2, cannot: 0.1, working: 0.7 }, outcome: "working" }
];
test.each(decisions)("requestOutcomeFromDecision($probabilities) is $outcome", ({ probabilities, outcome }) => {
  expect(requestOutcomeFromDecision(probabilities)).toBe(outcome as never);
});

// ---- asking the models ----

/** The reply and request a judgement is about, as its call keeps them. */
const SUBJECT = { replySeq: 412, replyAt: "2026-07-14T09:05:00.000Z", handoffId: "hnd_Tq3wZr8Kp1", requestAt: "2026-07-14T08:50:00.000Z" };

function recorder(logRequests: "metadata" | "full" = "metadata") {
  return new AgentLlmCallRecorder({ store: env!.store, logRequests, provider: "gw", model: "m", baseURL: "", apiMode: "streamText" });
}
function chat(texts: Array<string | Error>, logRequests: "metadata" | "full" = "metadata"): { candidate: JudgementCandidate; model: ReturnType<typeof createMockLLM> } {
  const model = createMockLLM(texts.map((t) => (t instanceof Error ? { error: t } : { text: t, finishReason: "stop" as const })), { mode: "stream" });
  return { model, candidate: { kind: "chat", model, provider: "openai-compatible", supportsReasoning: false, recorder: recorder(logRequests) } };
}
/** A decision provider answering through an injected fetch: no network. */
function decisionServer(reply: (body: Record<string, unknown>) => Response, logRequests: "metadata" | "full" = "metadata") {
  const seen: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  const candidate: JudgementCandidate = {
    kind: "decision", baseURL: "https://gw.example/v1", apiKey: "sk-gw", model: "vendor/judge-1", recorder: recorder(logRequests),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.json() as Record<string, unknown>;
      seen.push({ url: request.url, auth: request.headers.get("authorization"), body });
      return reply(body);
    }
  };
  return { seen, candidate };
}
const answered = (probabilities: Record<string, number>) => Response.json({
  id: "gen-dec-1", model: "vendor/judge-1",
  answers: { status: { type: "choice", choice: "done", confidence: 1, probabilities } },
  usage: { input_tokens: 10, output_tokens: 1 }
});

test("a chat candidate reads the prompt as its system message and the context as the one user message", async () => {
  env = freshStoresEnv("md-request-check-chat-");
  const { model, candidate } = chat(["{\"status\": \"done\"}"]);
  expect((await judgeManagerRequest([candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("done");
  const prompt = model.streamCalls[0]!.prompt;
  expect(prompt[0]!.role).toBe("system");
  expect(JSON.stringify(prompt[0]!.content)).toContain("An agent sent a request to a work thread and is waiting to hear how the work it is about ends.");
  expect(prompt.slice(1).map((m) => [m.role, JSON.stringify(m.content)])).toEqual([["user", JSON.stringify([{ type: "text", text: "CONTEXT" }])]]);
});

test("a decision candidate posts one choice question to <origin>/api/alpha/decisions with the provider's key", async () => {
  env = freshStoresEnv("md-request-check-decision-");
  const { seen, candidate } = decisionServer(() => answered({ done: 0.1, cannot: 0.85, working: 0.05 }));
  expect((await judgeManagerRequest([candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("cannot");
  expect(seen[0]!.url).toBe("https://gw.example/api/alpha/decisions");
  expect(seen[0]!.auth).toBe("Bearer sk-gw");
  const body = seen[0]!.body as { model: string; state: string; questions: { status: { type: string; instructions: string; criteria: Record<string, string> } } };
  expect([body.model, body.state, body.questions.status.type]).toEqual(["vendor/judge-1", "CONTEXT", "choice"]);
  expect(body.questions.status.instructions).toContain("Read the request and everything that happened in the thread since");
  expect(Object.keys(body.questions.status.criteria)).toEqual(["done", "cannot", "working"]);
  expect(body.questions.status.criteria.done!.startsWith("The latest reply reports the result")).toBe(true);
  expect(body.questions.status.criteria.working!.startsWith("Anything else:")).toBe(true);
});

test("a 404 from the decisions endpoint moves on to the next candidate", async () => {
  env = freshStoresEnv("md-request-check-404-");
  const { seen, candidate: decision } = decisionServer(() => new Response("not here", { status: 404 }));
  const { candidate } = chat(["{\"status\": \"done\"}"]);
  expect((await judgeManagerRequest([decision, candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("done");
  // The endpoint was asked, and refused: not a request that never left.
  expect(seen.length).toBe(1);
});

test("prose from a chat model moves on to the next candidate; when every one fails the answer is null", async () => {
  env = freshStoresEnv("md-request-check-prose-");
  const first = chat(["The work is done."]);
  const second = chat(["{\"status\": \"working\"}"]);
  expect((await judgeManagerRequest([first.candidate, second.candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("working");
  const only = chat(["No idea."]);
  expect(await judgeManagerRequest([only.candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT })).toBeNull();
  expect(await judgeManagerRequest([], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT })).toBeNull();
});

test("a decision step whose address cannot be read fails as its own attempt; the other steps still answer", async () => {
  env = freshStoresEnv("md-request-check-bad-url-");
  const step = { kind: "decision", baseURL: "", apiKey: "k", model: "vendor/judge-1" } as unknown as ResolvedProviderConfig;
  const [broken] = judgementCandidatesOf([step], () => recorder());
  expect((await judgeManagerRequest([chat(["{\"status\": \"done\"}"]).candidate, broken!], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("done");
  expect((await judgeManagerRequest([broken!, chat(["{\"status\": \"working\"}"]).candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("working");
});

test("a request the Decisions API rejects moves on to the next step, which asks in its own way", async () => {
  env = freshStoresEnv("md-request-check-400-");
  const { seen, candidate: decision } = decisionServer(() => Response.json({ error: { code: 400, message: "Bad Request: model does not support Decisions" } }, { status: 400 }));
  expect((await judgeManagerRequest([decision, chat(["{\"status\": \"done\"}"]).candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("done");
  expect(seen.length).toBe(1);
});

test("an unreadable answer stays out of the error record; full logging keeps it as the response", async () => {
  env = freshStoresEnv("md-request-check-unreadable-");
  await judgeManagerRequest([chat(["No idea, see ghp_secret123."]).candidate], { threadId: "thr_meta", context: "CONTEXT", subject: SUBJECT });
  await judgeManagerRequest([chat(["No idea, see the logs."], "full").candidate], { threadId: "thr_full", context: "CONTEXT", subject: SUBJECT });
  const rows = env.store.listLlmCalls(10).filter((call) => call.purpose === "manager_request_check");
  const meta = rows.find((row) => row.scopeId === "thr_meta")!;
  const full = rows.find((row) => row.scopeId === "thr_full")!;
  expect([meta.status, JSON.stringify(meta).includes("ghp_secret123")]).toEqual(["failed", false]);
  expect(JSON.stringify(meta.error)).toContain("no readable answer");
  expect([full.status, JSON.stringify([full.response, full.output]).includes("No idea, see the logs.")]).toEqual(["failed", true]);
});

test("full logging keeps a decision model's answer, its probabilities included", async () => {
  env = freshStoresEnv("md-request-check-decision-log-");
  const { candidate } = decisionServer(() => answered({ done: 0.1, cannot: 0.85, working: 0.05 }), "full");
  expect((await judgeManagerRequest([candidate], { threadId: "thr_full", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("cannot");
  const row = env.store.listLlmCalls(10).find((call) => call.purpose === "manager_request_check")!;
  expect(row.status).toBe("succeeded");
  expect(JSON.stringify(row.response)).toContain("\"cannot\":0.85");
  expect((row.response as { response?: { id?: string; modelId?: string } }).response).toMatchObject({ id: "gen-dec-1", modelId: "vendor/judge-1" });
});

// ---- what a judgement keeps ----

test("the answer is kept in the call that gave it, with its options and what it was about, under metadata-only logging", async () => {
  env = freshStoresEnv("md-request-check-record-");
  const first = chat(["The work is done."]);
  const second = chat(["{\"status\": \"done\"}"]);
  expect((await judgeManagerRequest([first.candidate, second.candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT }))?.answer).toBe("done");
  const rows = env.store.listLlmCalls(10).filter((call) => call.purpose === "manager_request_check");
  const answered = rows.find((row) => row.status === "succeeded")!;
  expect(answered.metadata?.judgement).toEqual({ options: ["done", "cannot", "working"], answer: "done", subject: SUBJECT });
  // What the call was written with at its start stays beside it.
  expect(answered.metadata).toMatchObject({ kind: "chat", fallbackAttempt: true, candidateIndex: 1 });
  // The attempt that gave no answer keeps none.
  expect(rows.find((row) => row.status === "failed")!.metadata?.judgement).toBeUndefined();
});

test("a decision model's answer is kept with its probabilities", async () => {
  env = freshStoresEnv("md-request-check-record-decision-");
  const { candidate } = decisionServer(() => answered({ done: 0.1, cannot: 0.85, working: 0.05 }));
  await judgeManagerRequest([candidate], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT });
  const row = env.store.listLlmCalls(10).find((call) => call.purpose === "manager_request_check")!;
  expect(row.metadata?.judgement).toEqual({
    options: ["done", "cannot", "working"], answer: "cannot", probabilities: { done: 0.1, cannot: 0.85, working: 0.05 }, subject: SUBJECT
  });
});

test("with logging off nothing is written, and marking an answer not used is harmless", async () => {
  env = freshStoresEnv("md-request-check-off-");
  const model = createMockLLM([{ text: "{\"status\": \"done\"}", finishReason: "stop" }], { mode: "stream" });
  const off = new AgentLlmCallRecorder({ store: env.store, logRequests: "off", provider: "gw", model: "m", baseURL: "", apiMode: "streamText" });
  const judged = await judgeManagerRequest([{ kind: "chat", model, provider: "openai-compatible", supportsReasoning: false, recorder: off }], { threadId: "thr_1", context: "CONTEXT", subject: SUBJECT });
  expect(judged?.answer).toBe("done");
  judged!.notUsed("stopped");
  expect(env.store.listLlmCalls(10).filter((call) => call.purpose === "manager_request_check")).toEqual([]);
});
