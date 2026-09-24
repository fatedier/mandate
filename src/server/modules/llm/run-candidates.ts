import {
  decideLlmFailure,
  errorMessage,
  LLM_ATTEMPTS_PER_CANDIDATE,
  retryDelayMs,
  type LlmAttempt,
  type LlmFailureDecision
} from "./retry-policy.js";

export type { LlmAttempt, LlmFailureDecision };

export interface LlmFailure extends LlmAttempt {
  error: unknown;
  /** What the shared policy decided for this error. */
  decision: LlmFailureDecision;
  /** Whether this error may move to the next candidate at all. */
  canFallback: boolean;
}

/**
 * The one loop every multi-model LLM call goes through: try each candidate in
 * order, give a retryable failure one more attempt on the same model, move on
 * when the policy says so, and throw the last error when nothing is left.
 *
 * Each caller keeps what is genuinely its own inside `attempt` — how the call is
 * made, streamed and recorded — and can overrule a decision in `onFailure`
 * (the wake loop never retries a stream that already showed the user text).
 * `onFailure` may throw to end the run with a different error. A "retry" it
 * returns is honoured only within the per-candidate limit.
 */
export async function runLlmCandidates<C, T>(input: {
  candidates: readonly C[];
  attempt: (candidate: C, at: LlmAttempt) => Promise<T>;
  onFailure?: (failure: LlmFailure) => LlmFailureDecision | void;
  /** Once aborted, a failed attempt ends the run: no retry, no fallback. */
  signal?: AbortSignal;
  /** How to wait before a retry. Defaults to a plain timer. */
  wait?: (ms: number) => Promise<void>;
}): Promise<T> {
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown = null;
  for (let candidateIndex = 0; candidateIndex < input.candidates.length; candidateIndex++) {
    const candidate = input.candidates[candidateIndex]!;
    const hasNext = candidateIndex < input.candidates.length - 1;
    for (let attempt = 1; attempt <= LLM_ATTEMPTS_PER_CANDIDATE; attempt++) {
      const at: LlmAttempt = { candidateIndex, attempt, hasNext };
      try {
        return await input.attempt(candidate, at);
      } catch (error) {
        lastError = error;
        if (input.signal?.aborted) throw error;
        const policy = decideLlmFailure(error, at);
        const decision = input.onFailure?.({ ...at, error, ...policy }) ?? policy.decision;
        if (decision === "retry" && attempt < LLM_ATTEMPTS_PER_CANDIDATE) {
          await wait(retryDelayMs(attempt));
          // A wait that does not observe the signal (the default timer) can
          // outlive an abort; the retry must not.
          if (input.signal?.aborted) throw error;
          continue;
        }
        // A retry past the limit falls through to what the policy allows.
        const fallback = decision === "fallback" || (decision === "retry" && policy.canFallback);
        if (fallback && hasNext) break;
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(errorMessage(lastError) || "LLM call failed");
}

/**
 * Metadata for a call that is not the first candidate's first attempt, so the
 * activity log can tell retries and fallbacks from ordinary calls.
 * `fallbackAttempt` is true only on a later candidate: a retry of the primary
 * model is still a primary call, and the Activity summary groups on exactly
 * this flag.
 */
export function llmAttemptMetadata(
  at: LlmAttempt,
  fields: Record<string, unknown>
): Record<string, unknown> {
  if (at.candidateIndex === 0 && at.attempt === 1) return {};
  return {
    fallbackAttempt: at.candidateIndex > 0,
    candidateIndex: at.candidateIndex,
    attempt: at.attempt,
    ...fields
  };
}
