import { formatErrorMessage } from "../../platform/errors.js";
import { embeddedProviderError } from "../../../shared/error-reason.js";

export function maxAttemptsForLlmCandidateCount(candidateCount: number): number {
  return candidateCount > 1 ? 1 : 2;
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
