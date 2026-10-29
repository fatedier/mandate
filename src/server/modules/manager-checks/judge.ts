import type { LanguageModel } from "ai";
import { OpenRouter } from "@openrouter/sdk";
import { HTTPClient, type Fetcher } from "@openrouter/sdk/lib/http.js";
import type { ResolvedProviderConfig } from "../../config.js";
import type { ReasoningEffort } from "../../../shared/settings.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import { createAgentProvider } from "../agent/llm-provider.js";
import { agentProviderConfigFromResolved } from "../../runtime/agent-provider-config.js";
import { callTextModelForProvider } from "../llm/text-model.js";
import { reasoningForAiSdk } from "../llm/reasoning.js";
import { llmAttemptMetadata, runLlmCandidates, type LlmAttempt } from "../llm/run-candidates.js";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import { logError } from "../../platform/logger.js";
import { readChatChoice } from "./answer.js";
import type { JudgementNotUsed, JudgementRecordDto, JudgementSubjectDto } from "../../../shared/api/activity.js";

export type { JudgementNotUsed };

/** Asks a route's models, in order, one choice about a thread's latest reply
 *  (manager request check: is the request's work done; manager stop check: what does it
 *  leave the user): a chat model with the prompt and a JSON answer, a
 *  decision model with the same definitions as one choice question over
 *  OpenRouter's Decisions API. Every attempt is an llm-call row; the one
 *  that answers keeps the answer and what it was about in its metadata. */

export type JudgementCandidate =
  | {
      kind: "chat";
      model: LanguageModel;
      provider: string;
      reasoningEffort?: ReasoningEffort;
      supportsReasoning?: boolean;
      recorder: AgentLlmCallRecorder;
    }
  | {
      kind: "decision";
      /** The provider's base URL. The Decisions API is at its origin,
       *  `<origin>/api/alpha/decisions`; read when the step is asked, so an
       *  address that cannot be read fails that step alone. */
      baseURL: string;
      apiKey: string;
      model: string;
      recorder: AgentLlmCallRecorder;
      /** How requests go out; absent, the platform's fetch (tests inject one). */
      fetch?: Fetcher;
    };

/** What a judgement reads, and what it is about (kept with its answer). */
export interface JudgementInput<S extends JudgementSubjectDto = JudgementSubjectDto> {
  threadId: string;
  context: string;
  subject: S;
}

/** An answer, and how its caller says it was not acted on: both are kept in
 *  the call that gave it. */
export interface Judged<T extends string> {
  answer: T;
  notUsed(reason: JudgementNotUsed): void;
}

/** One choice a judgement asks for: the call's purpose (its llm-call rows),
 *  the prompt, the options its JSON answer may name (in the prompt's order),
 *  and how a decision model's probabilities read as one of them. */
export interface JudgementChoice<T extends string> {
  purpose: string;
  promptPath: string;
  options: readonly T[];
  fromDecision: (probabilities: Record<string, number>) => T;
}

/** A judgement is short; a model that takes longer is given up on. */
const JUDGEMENT_TIMEOUT_MS = 60_000;

/** An answer that is not one of the options: the next model is asked.
 *  The answer goes to the call's record as its response, never into the
 *  error, which is kept even when requests are logged as metadata only. */
class UnreadableAnswerError extends Error {
  constructor(readonly result: unknown, what: string) {
    super(`${what} got no readable answer`);
    this.name = "UnreadableAnswerError";
  }
}

/** "manager_request_check" → "manager request check": how logs and errors name a judgement. */
const nameOf = (purpose: string) => purpose.replace(/_/g, " ");

/** The option chosen, kept in the call that gave it, or null when no model
 *  gave one (none set, or all failed). */
export async function judgeChoice<T extends string>(
  candidates: readonly JudgementCandidate[],
  input: JudgementInput,
  choice: JudgementChoice<T>,
  opts: { timeoutMs?: number } = {}
): Promise<Judged<T> | null> {
  if (candidates.length === 0) return null;
  const timeoutMs = opts.timeoutMs ?? JUDGEMENT_TIMEOUT_MS;
  try {
    return await runLlmCandidates({
      candidates,
      // Any failure the policy does not retry moves on: each step asks in its
      // own way (a chat model, or the Decisions API), so one step's rejected
      // request says nothing of the next, and a judgement costs little.
      onFailure: (failure) => (failure.decision === "retry" && !(failure.error instanceof UnreadableAnswerError) ? undefined : "fallback"),
      attempt: (candidate, at) => attempt(candidate, at, input, choice, timeoutMs)
    });
  } catch (err) {
    logError(`${nameOf(choice.purpose)} for thread ${input.threadId}`, err);
    return null;
  }
}

async function attempt<T extends string>(
  candidate: JudgementCandidate,
  at: LlmAttempt,
  input: JudgementInput,
  choice: JudgementChoice<T>,
  timeoutMs: number
): Promise<Judged<T>> {
  const prompt = renderPromptFile(choice.promptPath);
  const startedAt = Date.now();
  const metadata = {
    kind: candidate.kind,
    ...llmAttemptMetadata(at, { kind: candidate.kind, model: candidate.kind === "decision" ? candidate.model : undefined })
  };
  const callId = candidate.recorder.startCall({
    purpose: choice.purpose,
    scopeType: "agent_thread",
    scopeId: input.threadId,
    requestPayload: candidate.kind === "chat"
      ? { system: prompt, messages: [{ role: "user", content: input.context }] }
      : { question: decisionQuestion(prompt, choice.options), state: input.context },
    metadata
  });
  try {
    const { outcome, result, probabilities } = candidate.kind === "chat"
      ? await askChat(candidate, prompt, input.context, choice, timeoutMs)
      : await askDecision(candidate, prompt, input.context, choice, timeoutMs);
    // The answer goes into the metadata, which every logging mode but off
    // keeps (the response itself only full logging does).
    const judgement: JudgementRecordDto = {
      options: [...choice.options],
      answer: outcome,
      ...(probabilities ? { probabilities } : {}),
      subject: input.subject
    };
    candidate.recorder.finishCall(callId, { status: "succeeded", result, metadata: { ...metadata, judgement }, latencyMs: Date.now() - startedAt });
    return {
      answer: outcome,
      notUsed: (reason) => candidate.recorder.mergeMetadata(callId, { judgement: { notUsed: reason } })
    };
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

async function askChat<T extends string>(
  candidate: Extract<JudgementCandidate, { kind: "chat" }>,
  prompt: string,
  context: string,
  choice: JudgementChoice<T>,
  timeoutMs: number
) {
  const result = await callTextModelForProvider(candidate.provider, {
    model: candidate.model,
    system: prompt,
    messages: [{ role: "user", content: context }],
    reasoning: reasoningForAiSdk(candidate.reasoningEffort, candidate.supportsReasoning),
    maxRetries: 0,
    timeout: { totalMs: timeoutMs }
  }, candidate.supportsReasoning);
  const outcome = readChatChoice(result.text, choice.options);
  if (!outcome) throw new UnreadableAnswerError(result, nameOf(choice.purpose));
  return { outcome, result, probabilities: null };
}

async function askDecision<T extends string>(
  candidate: Extract<JudgementCandidate, { kind: "decision" }>,
  prompt: string,
  context: string,
  choice: JudgementChoice<T>,
  timeoutMs: number
) {
  const client = new OpenRouter({
    apiKey: candidate.apiKey,
    ...(candidate.fetch ? { httpClient: new HTTPClient({ fetcher: candidate.fetch }) } : {})
  });
  const response = await client.alpha.decisions.create(
    { decisionsRequest: { model: candidate.model, state: context, questions: { status: decisionQuestion(prompt, choice.options) } } },
    // The operation names its own server: the client's is not read.
    { serverURL: new URL(candidate.baseURL).origin, retries: { strategy: "none" }, timeoutMs }
  );
  const answer = response.answers.status;
  const probabilities = answer && "probabilities" in answer && answer.probabilities && typeof answer.probabilities === "object"
    ? answer.probabilities as Record<string, number>
    : null;
  if (!probabilities) throw new UnreadableAnswerError(decisionForLog(response), nameOf(choice.purpose));
  return { outcome: choice.fromDecision(probabilities), result: decisionForLog(response), probabilities };
}

/** A decision's answer as a call's log reads a model's result: its id and
 *  model under `response`, the whole answer as the body (the log keeps only
 *  what a text model's result carries). */
function decisionForLog(response: { id?: string; model?: string }) {
  return { ...response, response: { id: response.id, modelId: response.model, body: response } };
}

/** The prompt as one choice question: its opening paragraph, read as an
 *  instruction, and its definitions of the options as the criteria. */
export function decisionQuestion(prompt: string, options: readonly string[]) {
  const lines = prompt.split("\n").map((line) => line.trim()).filter(Boolean);
  const criteria: Record<string, string> = {};
  for (const line of lines) {
    const match = /^- ([a-z_]+): (.+)$/.exec(line);
    if (match && options.includes(match[1]!)) criteria[match[1]!] = match[2]![0]!.toUpperCase() + match[2]!.slice(1);
  }
  return {
    type: "choice" as const,
    instructions: (lines[0] ?? "").replace("You read", "Read"),
    criteria
  };
}

/** A route's steps as candidates: a decision model by its provider's origin
 *  and key, a chat model as every other call builds it. */
export function judgementCandidatesOf(
  chain: readonly ResolvedProviderConfig[],
  recorderFor: (step: ResolvedProviderConfig) => AgentLlmCallRecorder
): JudgementCandidate[] {
  return chain.map((step): JudgementCandidate => {
    if (step.kind === "decision") {
      return { kind: "decision", baseURL: step.baseURL, apiKey: step.apiKey, model: step.model, recorder: recorderFor(step) };
    }
    const provider = createAgentProvider(agentProviderConfigFromResolved(step));
    return {
      kind: "chat",
      model: provider.model,
      provider: provider.meta.provider,
      reasoningEffort: step.reasoningEffort,
      supportsReasoning: step.supportsReasoning,
      recorder: recorderFor(step)
    };
  });
}
