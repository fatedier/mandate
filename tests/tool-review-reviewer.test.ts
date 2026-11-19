import { afterEach, expect, test } from "bun:test";
import { AgentLlmCallRecorder } from "../src/server/modules/activity/llm-call-recorder.js";
import type { JudgementCandidate } from "../src/server/modules/manager-checks/judge.js";
import type { ToolCallSpec } from "../src/server/modules/agent/wake-loop.js";
import { REVIEW_UNAVAILABLE, reviewCalls, type ReviewedCall } from "../src/server/modules/tool-review/reviewer.js";
import { freshStoresEnv, type StoresEnv } from "./helpers/fixtures.js";
import { createMockLLM, createScriptedStreamLLM } from "./helpers/mock-llm.js";
import { llmCallDetails } from "./helpers/llm-calls.js";

// The review asks a screen about every call of a step, then a second look
// about the calls the screen flags. A screen that cannot answer sends the
// call on; a second look that cannot answer holds it, saying it was not
// checked: the review never lets a call through unchecked.

let env: StoresEnv | null = null;
afterEach(() => { env?.cleanup(); env = null; });

const bash = (command: string, id: string): ToolCallSpec => ({ toolCallId: id, toolName: "bash", args: { command } });
const reviewed = (call: ToolCallSpec): ReviewedCall => ({ call, context: { full: async () => `FULL ${call.toolCallId}`, trimmed: `TRIMMED ${call.toolCallId}` } });

function recorder() {
  return new AgentLlmCallRecorder({ store: env!.store, logRequests: "metadata", provider: "gw", model: "m", baseURL: "", apiMode: "streamText" });
}
function chat(texts: Array<string | Error>) {
  const model = createMockLLM(texts.map((t) => (t instanceof Error ? { error: t } : { text: t, finishReason: "stop" as const })), { mode: "stream" });
  const candidate: JudgementCandidate = { kind: "chat", model, provider: "openai-compatible", supportsReasoning: false, recorder: recorder() };
  return { model, candidate };
}
/** A decision provider answering through an injected fetch: no network. */
function decisions(reply: (body: { questions: Record<string, unknown>; state: string }) => Response) {
  const seen: Array<{ questions: Record<string, { instructions: string; criteria: Record<string, string> }>; state: string }> = [];
  const candidate: JudgementCandidate = {
    kind: "decision", baseURL: "https://gw.example/v1", apiKey: "sk-gw", model: "vendor/judge-1", recorder: recorder(),
    fetch: async (input, init) => {
      const body = await new Request(input, init).json() as { questions: Record<string, { instructions: string; criteria: Record<string, string> }>; state: string };
      seen.push(body);
      return reply(body);
    }
  };
  return { seen, candidate };
}
const answers = (probabilities: Record<string, number>) => Response.json({
  id: "gen-dec-1", model: "vendor/judge-1",
  answers: Object.fromEntries(Object.entries(probabilities).map(([key, yes]) => [key, { type: "choice", choice: yes >= 0.5 ? "yes" : "no", probabilities: { yes, no: 1 - yes } }])),
  usage: { input_tokens: 10, output_tokens: 1 }
});

test("one request screens the whole step and only flagged calls get a second look", async () => {
  env = freshStoresEnv("md-tool-review-screen-");
  const { seen, candidate: screen } = decisions((body) => {
    const [first, second] = Object.keys(body.questions);
    return answers({ [first!]: 0.02, [second!]: 0.4 });
  });
  const second = chat(['{"hold": false, "reason": "Reads only."}']);
  const calls = [reviewed(bash("cat notes.md", "c1")), reviewed(bash("kubectl get pods", "c2"))];
  const verdicts = await reviewCalls({ threadId: "thr_1", calls, ownModel: null }, { screen: [screen], secondLook: [second.candidate] });
  expect(seen).toHaveLength(1);
  expect(Object.keys(seen[0]!.questions)).toHaveLength(2);
  expect(seen[0]!.state).toContain("TRIMMED c1");
  expect(seen[0]!.state).toContain("TRIMMED c2");
  const question = Object.values(seen[0]!.questions)[0]!;
  expect(question.instructions).toContain("Weigh the call by what a mistake would cost.");
  expect(Object.keys(question.criteria)).toEqual(["yes", "no"]);
  // Only c2 (0.4 ≥ 0.1) went on, with its full context.
  expect(second.model.streamCalls).toHaveLength(1);
  expect(JSON.stringify(second.model.streamCalls[0]!.prompt)).toContain("FULL c2");
  expect([...verdicts]).toEqual([["c1", { held: false }], ["c2", { held: false }]]);
});

test("a call the second look holds comes back with its reason", async () => {
  env = freshStoresEnv("md-tool-review-hold-");
  const { candidate: screen } = decisions((body) => answers(Object.fromEntries(Object.keys(body.questions).map((key) => [key, 0.9]))));
  const second = chat(['Here: {"hold": true, "reason": "Deletes the shared bucket others read from."}']);
  const verdicts = await reviewCalls({ threadId: "thr_1", calls: [reviewed(bash("aws s3 rb s3://shared --force", "c1"))], ownModel: null }, { screen: [screen], secondLook: [second.candidate] });
  expect(verdicts.get("c1")).toEqual({ held: true, reason: "Deletes the shared bucket others read from." });
  const system = JSON.stringify(second.model.streamCalls[0]!.prompt[0]!.content);
  expect(system).toContain("Whatever the user's rules say needs their word needs it, whatever the loss.");
});

test("a hold without its reason is no answer: the next model is asked", async () => {
  env = freshStoresEnv("md-tool-review-no-reason-");
  const first = chat(['{"hold": true, "reason": ""}']);
  const next = chat(['{"hold": true, "reason": "Drops the production table."}']);
  const verdicts = await reviewCalls({ threadId: "thr_1", calls: [reviewed(bash("psql -c 'drop table orders'", "c1"))], ownModel: null }, { screen: [], secondLook: [first.candidate, next.candidate] });
  expect(verdicts.get("c1")).toEqual({ held: true, reason: "Drops the production table." });
});

test("an unreadable or failed screen sends the call on rather than letting it through", async () => {
  env = freshStoresEnv("md-tool-review-unreadable-");
  // The decision model fails; the chat model after it answers nothing readable.
  const { candidate: broken } = decisions(() => new Response("upstream down", { status: 500 }));
  const unreadable = chat(["I think it is probably fine."]);
  const second = chat(['{"hold": false, "reason": "Within its work."}']);
  const verdicts = await reviewCalls({ threadId: "thr_1", calls: [reviewed(bash("make deploy", "c1"))], ownModel: null }, { screen: [broken, unreadable.candidate], secondLook: [second.candidate] });
  expect(unreadable.model.streamCalls).toHaveLength(1);
  expect(second.model.streamCalls).toHaveLength(1);
  expect(verdicts.get("c1")).toEqual({ held: false });

  // Every screen fails: the call goes on.
  const { candidate: down } = decisions(() => new Response("upstream down", { status: 500 }));
  const afterFailure = chat(['{"hold": false, "reason": "Within its work."}']);
  await reviewCalls({ threadId: "thr_1", calls: [reviewed(bash("make deploy", "c3"))], ownModel: null }, { screen: [down], secondLook: [afterFailure.candidate] });
  expect(afterFailure.model.streamCalls).toHaveLength(1);

  // An answer that leaves a call out sends that call on.
  const { candidate: partial } = decisions((body) => answers({ [Object.keys(body.questions)[0]!]: 0.01 }));
  const forMissing = chat(['{"hold": false, "reason": "Fine."}']);
  await reviewCalls({ threadId: "thr_1", calls: [reviewed(bash("ls", "c4")), reviewed(bash("make deploy", "c5"))], ownModel: null }, { screen: [partial], secondLook: [forMissing.candidate] });
  expect(forMissing.model.streamCalls).toHaveLength(1);
  expect(JSON.stringify(forMissing.model.streamCalls[0]!.prompt)).toContain("FULL c5");
});

test("when every model fails the call is held as not checked, within the timeout", async () => {
  env = freshStoresEnv("md-tool-review-unavailable-");
  const failing = chat([new Error("bad gateway")]);
  // The thread's own model hangs: the review gives up on it at its deadline.
  const hanging: JudgementCandidate = { kind: "chat", model: createScriptedStreamLLM([[{ type: "hang" }]]), provider: "openai-compatible", supportsReasoning: false, recorder: recorder() };
  const startedAt = Date.now();
  const verdicts = await reviewCalls(
    { threadId: "thr_1", calls: [reviewed(bash("git push --force", "c1"))], ownModel: hanging },
    { screen: [], secondLook: [failing.candidate], reviewTimeoutMs: 100 }
  );
  expect(verdicts.get("c1")).toEqual({ held: true, unavailable: true, reason: REVIEW_UNAVAILABLE });
  expect(Date.now() - startedAt).toBeLessThan(2000);
});

test("each attempt is recorded as tool_review with its stage", async () => {
  env = freshStoresEnv("md-tool-review-records-");
  const { candidate: screen } = decisions((body) => answers(Object.fromEntries(Object.keys(body.questions).map((key) => [key, 0.3]))));
  const second = chat([new Error("bad gateway"), '{"hold": true, "reason": "Pushes over main."}']);
  const own = chat(['{"hold": true, "reason": "Pushes over main."}']);
  await reviewCalls(
    { threadId: "thr_1", calls: [{ ...reviewed(bash("git push --force origin main", "c1")), fastPath: "flag:git push" }], ownModel: own.candidate },
    { screen: [screen], secondLook: [second.candidate] }
  );
  const rows = llmCallDetails(env.store, 10).filter((row) => row.purpose === "tool_review");
  const screenRow = rows.find((row) => row.metadata?.stage === "screen")!;
  expect(screenRow.metadata?.calls).toEqual([{ toolCallId: "c1", toolName: "bash", probability: 0.3, verdict: "flagged", fastPath: "flag:git push" }]);
  const looks = rows.filter((row) => row.metadata?.stage === "second_look");
  expect(looks.map((row) => row.status).sort()).toEqual(["failed", "succeeded"]);
  expect(looks.find((row) => row.status === "succeeded")!.metadata).toMatchObject({ toolCallId: "c1", toolName: "bash", verdict: "held", fastPath: "flag:git push" });
});

// A deadline bounds a request that ignores cancellation, and an answer after it
// is not taken; a probability outside 0..1 is no answer; a failed attempt keeps which call it was.
test("the screen's deadline holds even when a request ignores cancellation", async () => {
  env = freshStoresEnv("md-tool-review-deadline-");
  const hung: JudgementCandidate = { kind: "decision", baseURL: "https://gw.example/v1", apiKey: "k", model: "vendor/judge-1", recorder: recorder(), fetch: () => new Promise<Response>(() => {}) };
  const late: JudgementCandidate = {
    kind: "decision", baseURL: "https://gw.example/v1", apiKey: "k", model: "vendor/judge-1", recorder: recorder(),
    fetch: async (input, init) => {
      const body = await new Request(input, init).json() as { questions: Record<string, unknown> };
      await new Promise((resolve) => setTimeout(resolve, 150));
      return answers(Object.fromEntries(Object.keys(body.questions).map((key) => [key, 0.01])));
    }
  };
  for (const screen of [hung, late]) {
    const second = chat(['{"hold": true, "reason": "Force-pushes main."}']);
    const startedAt = Date.now();
    const verdicts = await reviewCalls({ threadId: "thr_1", calls: [reviewed(bash("git push --force", "c1"))], ownModel: null }, { screen: [screen], secondLook: [second.candidate], screenTimeoutMs: 30, reviewTimeoutMs: 2000 });
    expect(Date.now() - startedAt).toBeLessThan(1500);
    // The screen gave no answer in time, so the call went on.
    expect(verdicts.get("c1")).toEqual({ held: true, reason: "Force-pushes main." });
  }
});

test("a probability outside 0 to 1 is no answer", async () => {
  env = freshStoresEnv("md-tool-review-bad-probability-");
  const { candidate: screen } = decisions((body) => Response.json({
    id: "gen", model: "vendor/judge-1",
    answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "choice", choice: "no", probabilities: { yes: -0.2, no: 1.2 } }])),
    usage: { input_tokens: 10, output_tokens: 1 }
  }));
  const second = chat(['{"hold": false, "reason": "Fine."}']);
  await reviewCalls({ threadId: "thr_1", calls: [reviewed(bash("make deploy", "c1"))], ownModel: null }, { screen: [screen], secondLook: [second.candidate] });
  expect(second.model.streamCalls).toHaveLength(1);
});

test("a failed attempt's record still says which call it was about", async () => {
  env = freshStoresEnv("md-tool-review-failed-record-");
  const prose = chat(["Looks risky to me.", "Also risky."]);
  await reviewCalls(
    { threadId: "thr_1", calls: [{ ...reviewed(bash("rm -rf build", "c1")), fastPath: "program:rm" }], ownModel: null },
    { screen: [], secondLook: [prose.candidate] }
  );
  const failed = llmCallDetails(env.store, 10).filter((row) => row.purpose === "tool_review" && row.status === "failed");
  expect(failed[0]?.metadata).toMatchObject({ stage: "second_look", toolCallId: "c1", toolName: "bash", fastPath: "program:rm" });
});

test("a call one screen flagged stays flagged when a sibling's request fails and the next screen passes both", async () => {
  env = freshStoresEnv("md-tool-review-sticky-flag-");
  const first = chat(['{"high": true}', new Error("bad gateway")]);
  const next = chat(['{"high": false}', '{"high": false}']);
  const second = chat(['{"hold": true, "reason": "Deletes the release tag."}']);
  const verdicts = await reviewCalls(
    { threadId: "thr_1", calls: [reviewed(bash("git push origin :refs/tags/v1", "c1")), reviewed(bash("ls", "c2"))], ownModel: null },
    { screen: [first.candidate, next.candidate], secondLook: [second.candidate] }
  );
  expect(verdicts.get("c1")).toEqual({ held: true, reason: "Deletes the release tag." });
  expect(verdicts.get("c2")).toEqual({ held: false });
});

test("an answer that arrives past the deadline is not taken, even when its timer had no turn to run", async () => {
  env = freshStoresEnv("md-tool-review-stalled-");
  const slow = chat(['{"high": false}']);
  const doStream = slow.model.doStream.bind(slow.model);
  // The model holds the event loop past the screen's deadline, then passes the call.
  slow.model.doStream = async (options) => {
    const until = Date.now() + 100;
    while (Date.now() < until) { /* busy */ }
    return doStream(options);
  };
  const second = chat(['{"hold": true, "reason": "Rewrites the shared config."}']);
  const verdicts = await reviewCalls(
    { threadId: "thr_1", calls: [reviewed(bash("cp new.conf /etc/shared.conf", "c1"))], ownModel: null },
    { screen: [slow.candidate], secondLook: [second.candidate], screenTimeoutMs: 30, reviewTimeoutMs: 2000 }
  );
  expect(verdicts.get("c1")).toEqual({ held: true, reason: "Rewrites the shared config." });
});

test("a stop reaches the screen's request", async () => {
  env = freshStoresEnv("md-tool-review-stop-");
  let aborted = false;
  const screen: JudgementCandidate = {
    kind: "decision", baseURL: "https://gw.example/v1", apiKey: "k", model: "vendor/judge-1", recorder: recorder(),
    fetch: (input, init) => new Promise<Response>((_, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
    })
  };
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 30);
  const startedAt = Date.now();
  await reviewCalls({ threadId: "thr_1", calls: [reviewed(bash("git push", "c1"))], ownModel: null, signal: stop.signal }, { screen: [screen], secondLook: [], screenTimeoutMs: 5000 });
  expect(aborted).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(1000);
});

test("a stop does not wait for a flagged call's context to be built", async () => {
  env = freshStoresEnv("md-tool-review-stop-context-");
  const stop = new AbortController();
  const item: ReviewedCall = { call: bash("git push", "c1"), context: { trimmed: "TRIMMED c1", full: () => new Promise<string>(() => {}) } };
  const second = chat(['{"hold": true, "reason": "Pushes."}']);
  setTimeout(() => stop.abort(), 30);
  const startedAt = Date.now();
  await reviewCalls({ threadId: "thr_1", calls: [item], ownModel: null, signal: stop.signal }, { screen: [], secondLook: [second.candidate], reviewTimeoutMs: 5000 });
  expect(Date.now() - startedAt).toBeLessThan(1000);
});

test("a stop before the second look builds no context for it", async () => {
  env = freshStoresEnv("md-tool-review-stop-before-");
  const stop = new AbortController();
  const screen: JudgementCandidate = {
    kind: "decision", baseURL: "https://gw.example/v1", apiKey: "k", model: "vendor/judge-1", recorder: recorder(),
    fetch: (input, init) => new Promise<Response>((_, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })
  };
  let built = 0;
  const item: ReviewedCall = { call: bash("git push", "c1"), context: { trimmed: "TRIMMED c1", full: async () => { built += 1; return "FULL c1"; } } };
  setTimeout(() => stop.abort(), 30);
  await reviewCalls({ threadId: "thr_1", calls: [item], ownModel: null, signal: stop.signal }, { screen: [screen], secondLook: [chat(['{"hold": false, "reason": "Fine."}']).candidate] });
  expect(built).toBe(0);
});

test("a review out of time builds no context for its second look", async () => {
  env = freshStoresEnv("md-tool-review-late-context-");
  const hung: JudgementCandidate = { kind: "decision", baseURL: "https://gw.example/v1", apiKey: "k", model: "vendor/judge-1", recorder: recorder(), fetch: () => new Promise<Response>(() => {}) };
  let built = 0;
  const item: ReviewedCall = { call: bash("git push", "c1"), context: { trimmed: "TRIMMED c1", full: async () => { built += 1; return "FULL c1"; } } };
  const verdicts = await reviewCalls({ threadId: "thr_1", calls: [item], ownModel: null }, { screen: [hung], secondLook: [chat(['{"hold": false, "reason": "Fine."}']).candidate], screenTimeoutMs: 1000, reviewTimeoutMs: 20 });
  expect(built).toBe(0);
  expect(verdicts.get("c1")).toEqual({ held: true, unavailable: true, reason: REVIEW_UNAVAILABLE });
});
