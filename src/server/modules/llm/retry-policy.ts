import { formatErrorMessage } from "../../platform/errors.js";
import { embeddedProviderError } from "../../../shared/error-reason.js";

/**
 * Attempts per candidate model, the first included: a retryable failure gets
 * one more try on the same model before the next candidate, whether or not a
 * fallback exists.
 *
 * This used to be 1 whenever a fallback was configured, which sent every
 * transient blip to the fallback. Measured on production traffic
 * (2026-05-23 → 09-15): after a first-model failure, the same model's next
 * call within 5 s succeeded for 92% of rate limits and 82% of overloads, and
 * those failures cost about 1 s and 5 s at the median — while the configured
 * fallback (the same model through another provider) ran at 21 s against 10 s
 * with a 73% cache hit rate against 96%. Timeouts stay excluded below: the
 * failed attempt has already waited 90 s at the median.
 */
export const LLM_ATTEMPTS_PER_CANDIDATE = 2;

export interface LlmAttempt {
  /** Index into the candidate list; 0 is the configured primary model. */
  candidateIndex: number;
  /** 1-based, counted per candidate. */
  attempt: number;
  /** Another candidate exists after this one. */
  hasNext: boolean;
}

export type LlmFailureDecision = "retry" | "fallback" | "throw";

/** What to do after one attempt failed: retry the same model, move to the next
 *  candidate, or give up. `canFallback` is whether this error may move to the
 *  next candidate at all — false for a request the next model would reject too. */
export function decideLlmFailure(
  error: unknown,
  at: LlmAttempt
): { decision: LlmFailureDecision; canFallback: boolean } {
  const requestRejected = isNonFallbackLlmError(error);
  const canFallback = at.hasNext && !requestRejected;
  // A rejected request is checked here too, not only for fallback: a gateway
  // that stamps every failure 500 makes "context length exceeded" look
  // retryable by status, and the same bytes would be rejected again.
  const retryable = isRetryableLlmError(error) && !isTimeoutLlmError(error) && !requestRejected;
  if (retryable && at.attempt < LLM_ATTEMPTS_PER_CANDIDATE) return { decision: "retry", canFallback };
  return { decision: canFallback ? "fallback" : "throw", canFallback };
}

/**
 * The provider rejected the content itself, not the request's shape or its own
 * capacity. Sending the same bytes again gets the same answer.
 *
 * This has to be a separate question from the status because a gateway
 * normalises: litellm stamps every upstream failure `500`, so on this codebase's
 * traffic a permanent content refusal and a transient server error arrive
 * wearing the same code. Only the provider's own sentence separates them, and
 * over 30 days that was 59 refusals against 66 genuinely transient calls inside
 * one indistinguishable `code: "500"` bucket.
 *
 * Deliberately not part of `isNonFallbackLlmError`: a refusal is a property of
 * this provider and this content, so another model is still worth trying.
 */
export function isContentRefusalLlmError(error: unknown): boolean {
  const provider = embeddedProviderError(errorMessage(error))?.message ?? errorMessage(error);
  const message = provider.toLowerCase();
  return [
    "flagged for possible",
    "cybersecurity risk",
    "content policy",
    "safety policy",
    "violates our",
    "refused to"
  ].some((needle) => message.includes(needle));
}

export function isRetryableLlmError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  if (isContentRefusalLlmError(error)) return false;
  const status = errorStatus(error);
  if (status && [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status)) return true;
  return [
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "socket hang up",
    "network",
    "overloaded",
    "rate limit",
    "temporarily unavailable",
    "internal server error",
    "bad gateway",
    "service unavailable",
    "gateway timeout"
  ].some((needle) => message.includes(needle));
}

export function isTimeoutLlmError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const status = errorStatus(error);
  return status === 408 || status === 504 || message.includes("timeout") || message.includes("timed out");
}

export function isNonFallbackLlmError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "context length",
    "context window",
    "maximum context",
    "too many tokens",
    "unsupported role",
    "unsupported image",
    "invalid request",
    "bad request"
  ].some((needle) => message.includes(needle));
}

export function retryDelayMs(attempt: number): number {
  const base = Math.min(250 * 2 ** Math.max(0, attempt - 1), 2000);
  return base + Math.floor(Math.random() * Math.min(base, 250));
}

export function errorMessage(error: unknown): string {
  return formatErrorMessage(error, "");
}

function errorStatus(error: unknown): number | null {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const value of [record.status, record.statusCode, record.code]) {
      // `Number(null)` is 0 and `Number.isInteger(0)` is true, so a null field
      // used to end the scan and report 0 — swallowing a usable value behind it.
      // `Number("")` is 0 for the same reason.
      if (value === null || value === undefined || value === "") continue;
      const n = Number(value);
      if (Number.isInteger(n)) return n;
    }
  }

  // The provider's status, when the SDK's type validation buried it as JSON text
  // inside the message. Last, so an error carrying its own status always wins:
  // that message may quote a payload from something else entirely.
  const embeddedCode = embeddedProviderError(errorMessage(error))?.code;
  if (embeddedCode) {
    const n = Number(embeddedCode);
    if (Number.isInteger(n)) return n;
  }
  return null;
}
