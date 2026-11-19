import { streamText, type ModelMessage, type TimeoutConfiguration, type ToolSet } from "ai";
import { AGENT_WAKE_STEP_LLM_TIMEOUT, LLM_STREAM_IDLE_TIMEOUT_MS } from "../llm/timeouts.js";
import { withoutAnthropicCacheMarks } from "../llm/anthropic-cache.js";
import { idleGuardedStreamOptions } from "../llm/stream-timeout.js";
import type { AgentLlmCallRecorder } from "../activity/llm-call-recorder.js";
import type { ToolCall } from "../agent/agent-store.js";
import { collectStream } from "../agent/stream-collector.js";
import { candidateCallOptions, type WakeLlmCandidate } from "../agent/wake-llm-attempts.js";
import type { StepPrompt } from "../agent/wake-loop.js";
import { REQUEST_SKILL_REVIEW_TOOL_NAME } from "./request-skill-review-tool.js";
import { MANAGE_SKILL_TOOL_NAME } from "./manage-skill-schema.js";

/** What the agent reads after a finished piece of work. */
export const SKILL_NUDGE_NOTE = "[runtime_context]\nThe work above is finished. If this kind of work will come back and no skill covers it yet, or it taught something a skill does not hold, call `request_skill_review` for the conversation where it was done. Otherwise do nothing: no reply is needed.";

/** A turn of this many tool calls finished a piece of work of its own. */
export const SKILL_NUDGE_MIN_TOOL_CALLS = 10;

/** Recorded as this purpose; Activity counts it with the skill reviews. */
export const SKILL_NUDGE_PURPOSE = "skill_review_nudge";

const SKILL_WRITERS = new Set([REQUEST_SKILL_REVIEW_TOOL_NAME, MANAGE_SKILL_TOOL_NAME]);

/** What is known of a turn as it ended. */
export interface EndedTurn {
  status: "finished" | "error" | "canceled" | "stuck" | "cut_off";
  scope: string | null;
  /** A duty thread's round: its checks are its schedule's. */
  duty: boolean;
  /** Its tool calls, by name. */
  toolNames: readonly string[];
  /** A worker reported its work done to this turn. */
  workDone: boolean;
}

/**
 * Whether a turn finished a piece of work the agent may want kept as a
 * skill: a manager's or the personal agent's turn, not a duty round, that a
 * worker's done report reached or that made SKILL_NUDGE_MIN_TOOL_CALLS tool
 * calls, and that neither asked for a review nor changed a skill itself.
 */
export function finishedWork(turn: EndedTurn): boolean {
  if (turn.status !== "finished") return false;
  if (turn.scope !== "manager" && turn.scope !== "personal") return false;
  if (turn.duty) return false;
  if (turn.toolNames.some((name) => SKILL_WRITERS.has(name))) return false;
  return turn.workDone || turn.toolNames.length >= SKILL_NUDGE_MIN_TOOL_CALLS;
}

export interface SkillNudgeDeps {
  endedTurn(threadId: string, wakeId: string, status: "finished" | "error" | "canceled" | "stuck"): EndedTurn | null;
  /** The thread's next step's prompt (its cache is the turn's), marked as
   *  a step marks it. */
  stepPromptFor(threadId: string): Promise<Pick<StepPrompt, "system" | "tools" | "candidates" | "messagesFor">>;
  send(input: { threadId: string; candidate: WakeLlmCandidate; system: StepPrompt["system"]; tools: ToolSet; messages: ModelMessage[] }): Promise<{ toolCalls: ToolCall[] }>;
  /** Carries out a review request as the thread's own tool call. */
  requestReview(threadId: string, wakeId: string, call: ToolCall): Promise<void>;
}

/**
 * After a finished piece of work, one call on the thread's own prompt, as its
 * next step would send it, with SKILL_NUDGE_NOTE after it: the agent may ask
 * for a skill review. Only that request is carried out; the rest of the reply
 * is dropped, and nothing is written to the conversation. It goes the moment
 * the turn ends, before anyone knows whether the thread goes quiet, so it
 * leaves the thread's cache seal and idle clock alone and writes nothing the
 * seal writes: it reads what the turn's last step wrote, marked as that step
 * marked it, and nothing from the turn's last reply on is marked (the seal
 * marks the reply for an hour; a five-minute entry there would only be
 * refreshed for five minutes by it).
 */
export function createSkillNudge(deps: SkillNudgeDeps): { afterTurn(threadId: string, info: { wakeId: string; status: "finished" | "error" | "canceled" | "stuck" }): Promise<void> } {
  return {
    async afterTurn(threadId, info) {
      const ended = deps.endedTurn(threadId, info.wakeId, info.status);
      if (!ended || !finishedWork(ended)) return;
      const prompt = await deps.stepPromptFor(threadId);
      const candidate = prompt.candidates[0];
      if (!candidate) return;
      const messages: ModelMessage[] = [...readOnlyFromReply(prompt.messagesFor(candidate)), { role: "user", content: [{ type: "text", text: SKILL_NUDGE_NOTE }] }];
      const reply = await deps.send({ threadId, candidate, system: prompt.system, tools: prompt.tools, messages });
      for (const call of reply.toolCalls) {
        if (call.toolName === REQUEST_SKILL_REVIEW_TOOL_NAME) await deps.requestReview(threadId, info.wakeId, call);
      }
    }
  };
}

/** The step's messages with no cache mark from the last assistant message
 *  on: the marks before it are where the turn's last step wrote. */
function readOnlyFromReply(messages: ModelMessage[]): ModelMessage[] {
  const reply = messages.findLastIndex((message) => message.role === "assistant");
  return reply < 0 ? messages : [...messages.slice(0, reply), ...withoutAnthropicCacheMarks(messages.slice(reply))];
}

/** Sends the nudge as a call of its own, as a seal is sent: the step's call
 *  options, no retries, a step's time limits; recorded in its thread. */
export function createSkillNudgeSender(deps: {
  recorderFor(candidate: WakeLlmCandidate): AgentLlmCallRecorder | null;
  threadScope(threadId: string): string | null;
  now(): number;
  timeout?: TimeoutConfiguration<ToolSet>;
}): SkillNudgeDeps["send"] {
  return async (input) => {
    const recorder = deps.recorderFor(input.candidate);
    const callId = recorder?.startCall({
      purpose: SKILL_NUDGE_PURPOSE,
      scopeType: "agent_thread",
      scopeId: input.threadId,
      metadata: { threadScope: deps.threadScope(input.threadId) }
    }) ?? null;
    const startedAt = deps.now();
    const idle = idleGuardedStreamOptions({ model: input.candidate.model, timeout: deps.timeout ?? AGENT_WAKE_STEP_LLM_TIMEOUT, idleMs: LLM_STREAM_IDLE_TIMEOUT_MS });
    try {
      const stream = streamText({
        ...candidateCallOptions(input.candidate, input.threadId, { askSummary: false }),
        system: input.system,
        tools: input.tools,
        messages: input.messages,
        maxRetries: 0,
        ...idle.options
      });
      const collected = await collectStream(stream.fullStream);
      recorder?.finishCall(callId, { status: "succeeded", result: collected, usage: collected.usage, latencyMs: deps.now() - startedAt });
      return { toolCalls: collected.toolCalls };
    } catch (error) {
      recorder?.finishCall(callId, { status: "failed", error, latencyMs: deps.now() - startedAt });
      throw error;
    } finally {
      idle.cleanup();
    }
  };
}
