import type { ReviewContext } from "./context.js";
import type { ToolCallSpec } from "../agent/wake-loop.js";
import { callTextModelForProvider } from "../llm/text-model.js";
import { reasoningForAiSdk } from "../llm/reasoning.js";
import { llmAttemptMetadata, runLlmCandidates, type LlmAttempt } from "../llm/run-candidates.js";
import { readJsonAnswer } from "../manager-checks/answer.js";
import { decisionQuestion, requestDecisions, type JudgementCandidate } from "../manager-checks/judge.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import { logError } from "../../platform/logger.js";
import screenPromptPath from "./prompts/screen.md" with { type: "file" };
import secondLookPromptPath from "./prompts/second-look.md" with { type: "file" };

/**
 * The tool-call review's two stages. A screen reads the step's calls at
 * once (their trimmed contexts) and flags the ones that could cost the user
 * something hard to put right; a second look reads each flagged call's full
 * context and holds it only when nothing the user said or wrote wants it.
 * The screen is wide by design: one that cannot answer sends the call on. A
 * second look that cannot answer holds the call as not checked, so the
 * review never lets a call through unread.
 */
export type ReviewVerdict = { held: false } | { held: true; reason: string; unavailable?: true };

/** A decision model's probability of "high-risk" from which the call goes on. */
export const SCREEN_THRESHOLD = 0.1;
export const SCREEN_TIMEOUT_MS = 5_000;
/** Both stages together: what a step may wait for its review. */
export const REVIEW_TIMEOUT_MS = 20_000;
/** What a call held because no model could review it tells the agent. */
export const REVIEW_UNAVAILABLE = "Held back: the tool-call review could not run, so this call was not checked. Go on with work that needs no such call, and try it again later.";

export interface ReviewedCall {
  call: ToolCallSpec;
  context: ReviewContext;
  /** Why the fast path did not skip it, kept with its records. */
  fastPath?: string;
}

export interface ReviewDeps {
  screen: readonly JudgementCandidate[];
  secondLook: readonly JudgementCandidate[];
  screenTimeoutMs?: number;
  reviewTimeoutMs?: number;
}

interface Review {
  threadId: string;
  calls: ReviewedCall[];
  ownModel: JudgementCandidate | null;
  signal?: AbortSignal;
}

const PURPOSE = "tool_review";

/** An answer that is not one: the next model is asked. */
class UnreadableAnswerError extends Error {
  constructor(readonly result: unknown) {
    super("the tool-call review got no readable answer");
    this.name = "UnreadableAnswerError";
  }
}

export async function reviewCalls(input: Review, deps: ReviewDeps): Promise<Map<string, ReviewVerdict>> {
  const verdicts = new Map<string, ReviewVerdict>();
  if (input.calls.length === 0) return verdicts;
  const startedAt = Date.now();
  const reviewDeadline = startedAt + (deps.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS);
  const screenDeadline = Math.min(reviewDeadline, startedAt + (deps.screenTimeoutMs ?? SCREEN_TIMEOUT_MS));
  const flagged = await screen(input, deps.screen, screenDeadline);
  // The second look writes the reason a held call carries: chat models only,
  // the thread's own model last.
  const chain = [...deps.secondLook, ...(input.ownModel ? [input.ownModel] : [])].filter((candidate) => candidate.kind === "chat");
  const looks = await Promise.all(input.calls.map(async (item): Promise<[string, ReviewVerdict]> => [
    item.call.toolCallId,
    flagged.has(item.call.toolCallId) ? await secondLook(input, item, chain, reviewDeadline) : { held: false }
  ]));
  for (const [id, verdict] of looks) verdicts.set(id, verdict);
  return verdicts;
}

/** The ids of the calls that go on to a second look: all of them when no
 *  screen answers. A flag stays: a call one screen flagged goes on even when
 *  a sibling's request failed and the next screen passes them all. */
async function screen(input: Review, candidates: readonly JudgementCandidate[], deadline: number): Promise<Set<string>> {
  const all = new Set(input.calls.map((item) => item.call.toolCallId));
  if (candidates.length === 0) return all;
  const prompt = renderPromptFile(screenPromptPath);
  const flaggedEarlier = new Set<string>();
  try {
    const flagged = await runLlmCandidates({
      candidates,
      signal: input.signal,
      // Each step asks in its own way, and a review cannot wait for retries.
      onFailure: () => "fallback",
      attempt: (candidate, at) => (candidate.kind === "decision"
        ? screenByDecision(candidate, at, input, prompt, deadline)
        : screenByChat(candidate, at, input, prompt, deadline, flaggedEarlier))
    });
    return new Set([...flagged, ...flaggedEarlier]);
  } catch (err) {
    logError(`tool-call review screen for thread ${input.threadId}`, err);
    return all;
  }
}

/** One request for the whole step: a question per call, keyed `call_<n>`.
 *  With one call the state is its trimmed context as evaluated; with more,
 *  each context stands under its key and each question names it. */
async function screenByDecision(
  candidate: Extract<JudgementCandidate, { kind: "decision" }>,
  at: LlmAttempt,
  input: Review,
  prompt: string,
  deadline: number
): Promise<Set<string>> {
  const timeoutMs = remaining(deadline);
  const keyed = input.calls.map((item, i) => ({ key: `call_${i + 1}`, item }));
  const single = keyed.length === 1;
  const question = decisionQuestion(prompt, ["yes", "no"]);
  const questions = Object.fromEntries(keyed.map(({ key }) => [key, single ? question : { ...question, instructions: `For the call under "## ${key}": ${question.instructions}` }]));
  const state = single ? keyed[0]!.item.context.trimmed : keyed.map(({ key, item }) => `## ${key}\n${item.context.trimmed}`).join("\n\n");
  const asked = { calls: keyed.map(({ item }) => callMetadata(item)) };
  return recorded(candidate, at, input, "screen", { question: questions, state }, asked, deadline, async () => {
    const { probabilities, result } = await requestDecisions(candidate, state, questions, timeoutMs, input.signal);
    const flagged = new Set<string>();
    const calls = keyed.map(({ key, item }) => {
      const answered = probabilities[key]?.yes;
      const probability = typeof answered === "number" && answered >= 0 && answered <= 1 ? answered : undefined;
      // An answer missing for a call, or not a probability, sends that call on.
      const goesOn = probability === undefined || probability >= SCREEN_THRESHOLD;
      if (goesOn) flagged.add(item.call.toolCallId);
      return { ...callMetadata(item), ...(probability === undefined ? {} : { probability }), verdict: goesOn ? "flagged" : "passed" };
    });
    return { value: flagged, result, metadata: { calls } };
  });
}

/** A chat model asked about each call on its own; an answer it does not give
 *  in the form asked sends that call on. */
async function screenByChat(
  candidate: Extract<JudgementCandidate, { kind: "chat" }>,
  at: LlmAttempt,
  input: Review,
  prompt: string,
  deadline: number,
  flaggedEarlier: Set<string>
): Promise<Set<string>> {
  const settled = await Promise.allSettled(input.calls.map((item) => recorded(candidate, at, input, "screen", chatPayload(prompt, item.context.trimmed), { calls: [callMetadata(item)] }, deadline, async () => {
    const result = await askChat(candidate, prompt, item.context.trimmed, deadline, input.signal);
    const high = readJsonAnswer(result.text)?.high;
    const goesOn = high !== false;
    return { value: goesOn, result, metadata: { calls: [{ ...callMetadata(item), verdict: goesOn ? "flagged" : "passed" }] } };
  })));
  // What this model flagged is kept before a failure moves on to the next one.
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled" && outcome.value) flaggedEarlier.add(input.calls[i]!.call.toolCallId);
  });
  const failure = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (failure) throw failure.reason;
  return new Set(input.calls.filter((_, i) => (settled[i] as PromiseFulfilledResult<boolean>).value).map((item) => item.call.toolCallId));
}

async function secondLook(input: Review, item: ReviewedCall, chain: readonly JudgementCandidate[], deadline: number): Promise<ReviewVerdict> {
  const unavailable: ReviewVerdict = { held: true, unavailable: true, reason: REVIEW_UNAVAILABLE };
  if (chain.length === 0) return unavailable;
  const prompt = renderPromptFile(secondLookPromptPath);
  try {
    // Built now, for a flagged call only: the user's saved decisions are looked up here.
    // Out of time already (the screen took it): no lookup is started.
    if (Date.now() >= deadline) return unavailable;
    const full = await beforeDeadline(untilStopped(() => item.context.full(), input.signal), deadline);
    return await runLlmCandidates({
      candidates: chain,
      signal: input.signal,
      onFailure: () => "fallback",
      attempt: (candidate, at) => {
        if (candidate.kind !== "chat") throw new Error("the second look asks chat models only");
        return recorded(candidate, at, input, "second_look", chatPayload(prompt, full), callMetadata(item), deadline, async () => {
          const result = await askChat(candidate, prompt, full, deadline, input.signal);
          const answer = readJsonAnswer(result.text);
          const reason = typeof answer?.reason === "string" ? answer.reason.trim() : "";
          // A hold is read only with its reason: the agent is told why.
          if (typeof answer?.hold !== "boolean" || (answer.hold && !reason)) throw new UnreadableAnswerError(result);
          const verdict: ReviewVerdict = answer.hold ? { held: true, reason } : { held: false };
          return { value: verdict, result, metadata: { ...callMetadata(item), verdict: answer.hold ? "held" : "allowed" } };
        });
      }
    });
  } catch (err) {
    logError(`tool-call review second look for thread ${input.threadId}`, err);
    return unavailable;
  }
}

async function askChat(
  candidate: Extract<JudgementCandidate, { kind: "chat" }>,
  system: string,
  context: string,
  deadline: number,
  signal: AbortSignal | undefined
) {
  return callTextModelForProvider(candidate.provider, {
    model: candidate.model,
    system,
    messages: [{ role: "user", content: context }],
    reasoning: reasoningForAiSdk(candidate.reasoningEffort, candidate.supportsReasoning),
    maxRetries: 0,
    timeout: { totalMs: remaining(deadline) },
    ...(signal ? { abortSignal: signal } : {})
  }, candidate.supportsReasoning);
}

/** One attempt as an llm-call row: its stage and the calls it is about from
 *  the start (a failure keeps them too), what it answered once it does (all
 *  kept in every logging mode but off). The deadline bounds the attempt
 *  itself, so a request that ignores cancellation, or answers late, fails. */
async function recorded<T>(
  candidate: JudgementCandidate,
  at: LlmAttempt,
  input: Review,
  stage: "screen" | "second_look",
  requestPayload: unknown,
  about: Record<string, unknown>,
  deadline: number,
  ask: () => Promise<{ value: T; result: unknown; metadata: Record<string, unknown> }>
): Promise<T> {
  const metadata = {
    kind: candidate.kind,
    stage,
    ...about,
    ...llmAttemptMetadata(at, { kind: candidate.kind, model: candidate.kind === "decision" ? candidate.model : undefined })
  };
  const startedAt = Date.now();
  const callId = candidate.recorder.startCall({ purpose: PURPOSE, scopeType: "agent_thread", scopeId: input.threadId, requestPayload, metadata });
  try {
    const { value, result, metadata: answered } = await beforeDeadline(ask(), deadline);
    candidate.recorder.finishCall(callId, { status: "succeeded", result, metadata: { ...metadata, ...answered }, latencyMs: Date.now() - startedAt });
    return value;
  } catch (err) {
    candidate.recorder.finishCall(callId, {
      status: "failed",
      error: err,
      ...(err instanceof UnreadableAnswerError ? { result: err.result } : {}),
      latencyMs: Date.now() - startedAt
    });
    throw err;
  }
}

function chatPayload(system: string, context: string) {
  return { system, messages: [{ role: "user", content: context }] };
}

function callMetadata(item: ReviewedCall) {
  return { toolCallId: item.call.toolCallId, toolName: item.call.toolName, ...(item.fastPath ? { fastPath: item.fastPath } : {}) };
}

/** The promise's value if it settles before the deadline; a timeout error
 *  otherwise, whatever the promise does after. */
/** What `start` gives, or a failure as soon as the step is stopped; a step
 *  stopped already starts nothing. */
function untilStopped<T>(start: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return start();
  if (signal.aborted) return Promise.reject(new Error("the step was stopped"));
  const promise = start();
  return new Promise<T>((resolve, reject) => {
    const stopped = () => reject(new Error("the step was stopped"));
    signal.addEventListener("abort", stopped, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", stopped); resolve(value); },
      (err: unknown) => { signal.removeEventListener("abort", stopped); reject(err); }
    );
  });
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("the tool-call review ran out of time")), Math.max(0, deadline - Date.now()));
  });
  try {
    const value = await Promise.race([promise, expired]);
    // A value that won the race while the timer had no turn to run (the
    // event loop held) still came too late.
    if (Date.now() > deadline) throw new Error("the tool-call review ran out of time");
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** What is left of a deadline; an attempt with nothing left fails at once. */
function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("the tool-call review ran out of time");
  return ms;
}
