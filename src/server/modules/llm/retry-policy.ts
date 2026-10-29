import { formatErrorMessage } from "../../platform/errors.js";
import { embeddedProviderError } from "../../../shared/error-reason.js";

/**
 * Attempts per candidate model, the first included: a retryable failure gets
 * one more try on the same model before the next candidate, whether or not a
 * fallback exists.
 *
 * This used to be 1 whenever a fallback was configured, which sent every
 * transient blip to the fallback. After a first-model failure, the same
 * model's next call within seconds usually succeeds for a rate limit or an
 * overload, and those failures return quickly — while a fallback, even the
 * same model through another provider, is slower and starts with a colder
 * prompt cache. Timeouts stay excluded below: the
 * failed attempt has already waited long. A provider the network
 * cannot reach gets more (UNREACHABLE_RETRY_DELAYS_MS).
 */
export const LLM_ATTEMPTS_PER_CANDIDATE = 2;

/**
 * The waits before each retry of a call that never reached its provider (see
 * isUnreachableLlmError). That is the network, not the provider: it is back
 * within seconds (a laptop waking, Wi-Fi switching) or not for a long time. So
 * three retries spread over about 22 s, then the call fails and its caller's
 * own schedule takes over — a dream run that fails waits its 6 hours. Without
 * this, a call made while the network is down fails on every
 * candidate at once.
 */
export const UNREACHABLE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

/** Attempts on one candidate model, the first included, given its last error. */
export function llmAttemptsFor(error: unknown): number {
  return isUnreachableLlmError(error) ? 1 + UNREACHABLE_RETRY_DELAYS_MS.length : LLM_ATTEMPTS_PER_CANDIDATE;
}

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
  if (retryable && at.attempt < llmAttemptsFor(error)) return { decision: "retry", canFallback };
  return { decision: canFallback ? "fallback" : "throw", canFallback };
}

/**
 * The provider rejected the content itself, not the request's shape or its own
 * capacity. Sending the same bytes again gets the same answer.
 *
 * This has to be a separate question from the status because a gateway
 * normalises: it may stamp every upstream failure `500`, so
 * a permanent content refusal and a transient server error arrive
 * wearing the same code. Only the provider's own sentence separates them.
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

/** Bun's sentence for a socket it could not open, in every version probed. */
const NO_SOCKET_SENTENCE = "Was there a typo in the url or port?";

/** Bun's own fetch error for a socket it could not open. 1.4.2 gives every
 *  such error the code FailedToOpenSocket. 1.4.3 gives the connect's errno
 *  (EHOSTUNREACH, ENETUNREACH, EAFNOSUPPORT…) as the code and again at the
 *  head of the message. The code and the message must agree: an error that
 *  only quotes the sentence, as a provider's answer may, is not this. */
function isUnopenedSocketError(error: Record<string, unknown>): boolean {
  const { code, message } = error;
  if (typeof code !== "string") return false;
  return code === "FailedToOpenSocket" || message === `${code}: ${NO_SOCKET_SENTENCE}`;
}

/**
 * The call never reached its provider: the host's name did not resolve, or no
 * route led to it. As Bun's fetch reports them (probed on Bun 1.4.2 and 1.4.3):
 * a failed lookup says `getaddrinfo ENOTFOUND <host>`, and the wrappers on the
 * way here keep saying it; no route says only "Was there a typo in the url or
 * port?", so its fetch error is what tells (isUnopenedSocketError), and the AI
 * SDK and the stream collector can leave that error two causes down. A
 * refused connection is not this: the host was reached, and nothing listened.
 */
export function isUnreachableLlmError(error: unknown): boolean {
  if (errorMessage(error).includes("getaddrinfo")) return true;
  // A few levels, never a loop: a cause chain can point back at itself.
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if (isUnopenedSocketError(current as Record<string, unknown>)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * OpenAI's cybersecurity safety check flagged the request (`cyber_policy`).
 * A cyber_policy rejection is not always repeated for the same request, so it
 * gets the one retry a transient error gets, although gateways mark it 400
 * and not retryable.
 */
export function isCyberPolicyLlmError(error: unknown): boolean {
  if (error && typeof error === "object" && (error as Record<string, unknown>).code === "cyber_policy") return true;
  const message = errorMessage(error).toLowerCase();
  return message.includes("cyber_policy") || message.includes("high-risk cyber activity");
}

export function isRetryableLlmError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  if (isCyberPolicyLlmError(error)) return true;
  if (isContentRefusalLlmError(error)) return false;
  if (isUnreachableLlmError(error)) return true;
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
    "gateway timeout",
    // collectStream's: a response the provider failed or never completed.
    "the provider ended the response with an error",
    "the response ended before the provider finished it"
  ].some((needle) => message.includes(needle));
}

export function isTimeoutLlmError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const status = errorStatus(error);
  return status === 408 || status === 504 || message.includes("timeout") || message.includes("timed out");
}

export function isNonFallbackLlmError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return isInputRejectedLlmError(error) || ["invalid request", "bad request"].some((needle) => message.includes(needle));
}

/** The provider rejected the input itself — too long, or a role or image the
 *  model does not take — rather than how the request was put. */
export function isInputRejectedLlmError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "context length",
    "context window",
    "maximum context",
    "too many tokens",
    "unsupported role",
    "unsupported image"
  ].some((needle) => message.includes(needle));
}

/** The wait before retry number `attempt` (1-based) after `error`. */
export function retryDelayMs(attempt: number, error?: unknown): number {
  if (error !== undefined && isUnreachableLlmError(error)) {
    return UNREACHABLE_RETRY_DELAYS_MS[Math.min(attempt, UNREACHABLE_RETRY_DELAYS_MS.length) - 1]!;
  }
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
