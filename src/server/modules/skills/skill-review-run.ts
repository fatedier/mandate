import * as os from "node:os";
import { streamText, type JSONValue, type LanguageModel, type ModelMessage, type SystemModelMessage, type TimeoutConfiguration, type ToolSet } from "ai";
import { collectStream } from "../agent/stream-collector.js";
import { throwIfCutOff } from "../llm/output-limit-failure.js";
import { carryFirstOutput, firstOutputOf } from "../llm/first-output.js";
import { ToolRegistry, type ToolContext, type ToolDefinition } from "../agent/tool-registry.js";
import { assistantMessagesForModel } from "../agent/wake-message-adapter.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import type { ReasoningEffort } from "../../../shared/settings.js";
import { reasoningForAiSdk } from "../llm/reasoning.js";
import { ANTHROPIC_CACHE_CONTROL } from "../llm/anthropic-cache.js";
import { providerOptionsForCandidate } from "../agent/wake-llm-attempts.js";
import { assistantMessagesOnly } from "../agent/model-stream.js";
import { forReplay } from "../agent/reasoning-replay.js";
import { replayTargetFor, withCacheMarksFor, type ReplayCandidate } from "../agent/replay-target.js";
import type { AssistantContent } from "../../../shared/agent-message-types.js";
import { idleGuardedStreamOptions } from "../llm/stream-timeout.js";
import { LLM_STREAM_IDLE_TIMEOUT_MS, MEMORY_DREAM_STEP_LLM_TIMEOUT } from "../llm/timeouts.js";
import { llmAttemptMetadata, runLlmCandidates } from "../llm/run-candidates.js";
import { errorText } from "../../../shared/error-text.js";

/** A review's one limit: its steps, which bound a review that
 *  keeps reading without finishing (each step resends the growing record)
 *  and the queue it holds. A run that reaches it ends failed with nothing
 *  saved. No output cap (a whole skill's rewrite is one tool call) and no
 *  clock of its own: a step's model call has its own timeouts. */
export const REVIEW_LIMITS = { steps: 50 } as const;

export const REVIEW_FAILURES = {
  steps: (n: number) => `The review used its ${n} steps without finishing.`,
  filtered: "The provider filtered the review's reply."
} as const;

export interface ReviewCandidate {
  model: LanguageModel;
  provider?: string;
  modelName?: string;
  reasoningEffort?: ReasoningEffort;
  supportsReasoning?: boolean;
  recorder?: AgentLlmCallRecorder;
}

export interface ReviewRunInput {
  runId: string;
  /** The reviewed conversation: what the calls are recorded against. */
  threadId: string;
  /** How its calls are recorded; by default a review's, against the thread. */
  record?: { purpose: string; scopeType: string; scopeId: string };
  candidates: readonly ReviewCandidate[];
  system: string;
  opening: string;
  tools: readonly ToolDefinition[];
  /** The run's own state; its finish tool sets `finished`. */
  state: { finished: { reason: string } | null };
  limits?: { steps?: number };
  /** A step's SDK timeouts and how long its stream may go quiet; a test passes short ones. */
  llmTimeout?: TimeoutConfiguration<ToolSet>;
  streamIdleTimeoutMs?: number;
}

export type ReviewRunEnd = { ok: true; reason: string | null } | { ok: false; error: string };

/** Errors that end the run rather than send the step to the next model or
 *  a retry: a reply cut at the provider's own output limit (a part of a
 *  change is no change), one the provider filtered. Marked, not replaced, so the call's record keeps
 *  what the error carries of the reply (its first output, facts, usage). */
const ENDS_REVIEW = new WeakSet<object>();
function endsReview(error: Error, message?: string): Error {
  if (message !== undefined) {
    try {
      error.message = message;
    } catch {
      /* the message is the lesser part */
    }
  }
  ENDS_REVIEW.add(error);
  return error;
}

type Collected = Awaited<ReturnType<typeof collectStream>> & Pick<AssistantContent, "sdkAssistantMessages" | "writtenBy">;
type Turn = { message: ModelMessage } | { step: Pick<AssistantContent, "text" | "toolCalls" | "sdkAssistantMessages" | "writtenBy"> };

function replayCandidate(candidate: ReviewCandidate): ReplayCandidate {
  return {
    model: candidate.model,
    meta: { provider: candidate.provider, model: candidate.modelName, reasoningEffort: candidate.reasoningEffort, supportsReasoning: candidate.supportsReasoning }
  };
}

/**
 * One review: the opening, then steps until the model calls `finish` or
 * stops calling tools. Its tools change nothing until the run ends: the
 * caller writes the staged change when this returns ok. Every step is
 * recorded as a `skill_review` call; the models are tried in order as the
 * dream's are.
 */
export async function runReview(input: ReviewRunInput): Promise<ReviewRunEnd> {
  const limits = { ...REVIEW_LIMITS, ...input.limits };
  const registry = new ToolRegistry();
  for (const tool of input.tools) registry.register(tool);
  const system: SystemModelMessage = { role: "system", content: input.system, providerOptions: { anthropic: { cacheControl: ANTHROPIC_CACHE_CONTROL } } };
  const history: Turn[] = [{ message: { role: "user", content: input.opening } }];
  const messagesFor = (candidate: ReviewCandidate): ModelMessage[] => {
    const { target } = replayTargetFor(replayCandidate(candidate));
    return withCacheMarksFor(replayCandidate(candidate), history.flatMap((turn) => ("step" in turn ? assistantMessagesForModel(turn.step, target) : [turn.message])));
  };

  for (let step = 1; step <= limits.steps; step += 1) {
    let collected: Collected;
    try {
      collected = await runLlmCandidates({
        candidates: input.candidates,
        onFailure: (failure) => {
          if (typeof failure.error === "object" && failure.error !== null && ENDS_REVIEW.has(failure.error)) throw failure.error;
        },
        attempt: (candidate, at) => attemptStep(input, candidate, at, { system, messages: messagesFor(candidate), tools: registry.tools, step, maxSteps: limits.steps })
      });
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
    history.push({ step: {
      ...(collected.text ? { text: collected.text } : {}),
      toolCalls: collected.toolCalls.map(({ toolCallId, toolName, args }) => ({ toolCallId, toolName, args })),
      ...(collected.sdkAssistantMessages ? { sdkAssistantMessages: collected.sdkAssistantMessages } : {}),
      ...(collected.writtenBy ? { writtenBy: collected.writtenBy } : {})
    } });
    if (collected.toolCalls.length === 0) {
      // A step its model says does not end the turn (a Codex commentary)
      // goes on to the next, as an agent's turn does.
      if (collected.endTurn === false) continue;
      return { ok: true, reason: input.state.finished?.reason ?? (collected.text.trim() || null) };
    }
    for (const call of collected.toolCalls) {
      const output = await callTool(input.tools, call, { threadId: input.runId, wakeId: input.runId, scope: { kind: "manager", managerDir: os.homedir(), projectWorkingDirs: [] } });
      history.push({ message: { role: "tool", content: [{ type: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output }] } });
    }
    if (input.state.finished) return { ok: true, reason: input.state.finished.reason };
  }
  return { ok: false, error: REVIEW_FAILURES.steps(limits.steps) };
}

/**
 * One tool call, its result handed back whole: a review's results are its
 * own pages (a transcript page, a skill of up to 40,000 characters, a
 * file read within what the model is given inline), sized for the model,
 * so none is spooled to a file. Its tools read the database or a file, and
 * memory_search's embedder has its own timeout.
 */
async function callTool(tools: readonly ToolDefinition[], call: { toolCallId: string; toolName: string; args: unknown }, ctx: ToolContext) {
  const tool = tools.find((t) => t.name === call.toolName);
  if (!tool) return { type: "error-text" as const, value: `unknown tool: ${call.toolName}` };
  const parsed = tool.parameters.safeParse(call.args);
  if (!parsed.success) {
    return { type: "error-text" as const, value: `parameter validation failed: ${parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ")}` };
  }
  try {
    const result: unknown = await tool.handler(parsed.data, ctx);
    return typeof result === "string"
      ? { type: "text" as const, value: result }
      : { type: "json" as const, value: JSON.parse(JSON.stringify(result ?? null)) as JSONValue };
  } catch (error) {
    return { type: "error-text" as const, value: errorText(error) };
  }
}

async function attemptStep(
  input: ReviewRunInput,
  candidate: ReviewCandidate,
  at: Parameters<typeof llmAttemptMetadata>[0],
  call: { system: SystemModelMessage; messages: ModelMessage[]; tools: ToolSet; step: number; maxSteps: number }
): Promise<Collected> {
  const started = Date.now();
  const metadata = {
    runId: input.runId,
    step: call.step,
    maxSteps: call.maxSteps,
    ...llmAttemptMetadata(at, { provider: candidate.provider, model: candidate.modelName, reasoningEffort: candidate.reasoningEffort, supportsReasoning: candidate.supportsReasoning })
  };
  const record = input.record ?? { purpose: "skill_review", scopeType: "agent_thread", scopeId: input.threadId };
  const callId = candidate.recorder?.startCall({
    purpose: record.purpose,
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    requestPayload: { system: input.system, toolNames: Object.keys(call.tools), step: call.step, maxSteps: call.maxSteps, messages: call.messages },
    metadata
  }) ?? null;
  const idle = idleGuardedStreamOptions({
    model: candidate.model,
    timeout: input.llmTimeout ?? MEMORY_DREAM_STEP_LLM_TIMEOUT,
    idleMs: input.streamIdleTimeoutMs ?? LLM_STREAM_IDLE_TIMEOUT_MS
  });
  try {
    const stream = streamText({
      model: candidate.model,
      reasoning: reasoningForAiSdk(candidate.reasoningEffort, candidate.supportsReasoning),
      providerOptions: providerOptionsForCandidate(undefined, replayCandidate(candidate), input.runId, false),
      system: call.system,
      messages: call.messages,
      tools: call.tools,
      maxRetries: 0,
      ...idle.options
    });
    // A reply the provider withheld is no answer: the run ends, nothing
    // saved. Seen on its way through, so it counts even when the collector
    // fails first on a reply with no output and no usage (a retryable error).
    let filtered = false;
    const watched = (async function* () {
      for await (const part of stream.fullStream) {
        const reason = (part as { type?: string; finishReason?: unknown }).finishReason;
        if (reason === "content-filter") filtered = true;
        yield part;
      }
    })();
    let collected: Awaited<ReturnType<typeof collectStream>>;
    try {
      collected = await collectStream(watched);
    } catch (error) {
      if (filtered && error instanceof Error) throw endsReview(error, REVIEW_FAILURES.filtered);
      throw error;
    }
    if (filtered || collected.finishReason === "content-filter") {
      // A whole reply withheld: its error carries what the reply showed, as the collector's do.
      const error = Object.assign(new Error(REVIEW_FAILURES.filtered), { facts: collected.facts, usageSoFar: collected.usage });
      carryFirstOutput(error, firstOutputOf(collected));
      throw endsReview(error);
    }
    try {
      throwIfCutOff(collected);
    } catch (cut) {
      throw endsReview(cut as Error);
    }
    const sdkAssistantMessages = assistantMessagesOnly(await stream.responseMessages).map(forReplay);
    const writtenBy = candidate.modelName ? { provider: candidate.provider ?? "", model: candidate.modelName } : undefined;
    candidate.recorder?.finishCall(callId, { status: "succeeded", result: collected, usage: collected.usage, metadata, latencyMs: Date.now() - started });
    return { ...collected, ...(sdkAssistantMessages.length ? { sdkAssistantMessages } : {}), ...(writtenBy ? { writtenBy } : {}) };
  } catch (error) {
    candidate.recorder?.finishCall(callId, { status: "failed", error, metadata, latencyMs: Date.now() - started });
    throw error;
  } finally {
    idle.cleanup();
  }
}
