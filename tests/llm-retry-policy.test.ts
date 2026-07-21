import { describe, expect, test } from "bun:test";
import {
  isContentRefusalLlmError,
  isNonFallbackLlmError,
  isRetryableLlmError
} from "../src/server/modules/llm/retry-policy.js";

/**
 * When a provider answers an error object down the streaming channel, the SDK
 * matches it against the delta schema, fails, and throws `AI_TypeValidationError`
 * — an object carrying only `{name, message}`. The provider's real status lives
 * as JSON *text* inside that message, so reading `error.status` finds nothing
 * and the decision falls through to prose matching.
 *
 * Measured over 30 days on the author's store: 887 failed calls, 159 not
 * retried, of which 125 were exactly this shape with an embedded `code: "500"`.
 */
const wrap = (providerMessage: string, code = "500") =>
  `Type validation failed: Value: {"error":{"message":${JSON.stringify(providerMessage)},` +
  `"type":null,"param":null,"code":"${code}"}}.\nError message: [\n  {\n    "code": "invalid_union"`;

const TRANSIENT = wrap(
  "litellm.APIError: An error occurred while processing your request. You can retry " +
    "your request, or contact us through our help center at help.openai.com if the error " +
    "persists. Please include the request ID 9173cf5d-ea04-4bf1-ae8d-9824894cfcdf in your message."
);

const REFUSAL = wrap(
  "litellm.APIError: This content was flagged for possible cybersecurity risk. If this " +
    "seems wrong, try rephrasing your request. To get authorized for security work, join " +
    "the Trusted Access for Cyber program: https://chatgpt.com/cyber"
);

describe("isRetryableLlmError — status embedded in the message", () => {
  test("retries a wrapped provider 500 whose prose matches no keyword", () => {
    // The prose says "You can retry your request" and contains none of
    // overloaded / rate limit / internal server error. Only the embedded
    // `code: "500"` identifies it. 56 calls in 30 days.
    expect(isRetryableLlmError(new Error(TRANSIENT))).toBe(true);
  });

  test("still retries the wrapped 500 whose prose DOES match a keyword", () => {
    // The keyword list is kept as a second route, not replaced: providers that
    // send no code at all are still covered by it.
    const overloaded = wrap("litellm.APIError: Our servers are currently overloaded. Please try again later.");
    expect(isRetryableLlmError(new Error(overloaded))).toBe(true);
  });

  test("reads the embedded code only when the object carries no status of its own", () => {
    // An AI_APICallError carries the real status. That must win: the message of
    // such an error may quote an unrelated payload.
    const err = Object.assign(new Error(wrap("whatever", "500")), { status: 400 });
    expect(isRetryableLlmError(err)).toBe(false);
  });
});

describe("isRetryableLlmError — a gateway that stamps everything 500", () => {
  test("does NOT retry a content refusal, though it is wrapped as a 500", () => {
    // litellm normalises every upstream error to 500, so the status alone
    // cannot separate "the server is unhappy" from "your content is rejected".
    // Retrying identical content fails identically — 59 calls in 30 days.
    expect(isRetryableLlmError(new Error(REFUSAL))).toBe(false);
  });

  test("a content refusal is still allowed to fall back to another model", () => {
    // Refusal is a property of this provider and this content, not of the
    // request's validity: a different provider may well accept it.
    expect(isNonFallbackLlmError(new Error(REFUSAL))).toBe(false);
  });

  test("classifies the refusal by the provider's own message, not the wrapper", () => {
    expect(isContentRefusalLlmError(new Error(REFUSAL))).toBe(true);
    expect(isContentRefusalLlmError(new Error(TRANSIENT))).toBe(false);
  });
});

describe("isRetryableLlmError — regressions the change must not cause", () => {
  test("a real 429 on the error object is still retryable", () => {
    const err = Object.assign(new Error("No deployments available for selected model, Try again in 30 seconds."), {
      status: 429,
      code: 429
    });
    expect(isRetryableLlmError(err)).toBe(true);
  });

  test("a 400 stays non-retryable", () => {
    expect(isRetryableLlmError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
  });

  test("a null status does not mask a usable code", () => {
    // `Number(null)` is 0 and `Number.isInteger(0)` is true, so a null `status`
    // used to end the candidate scan and report 0 — swallowing the `code` behind
    // it. No call in the measured window hit this, but the branch is wrong.
    const err = Object.assign(new Error("nothing quotable here"), { status: null, code: 503 });
    expect(isRetryableLlmError(err)).toBe(true);
  });

  test("a user cancellation is never retryable", () => {
    expect(isRetryableLlmError(new Error("WakeCanceledError: Stopped by user."))).toBe(false);
  });
});
