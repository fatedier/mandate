import { describe, expect, test } from "bun:test";
import {
  decideLlmFailure,
  isContentRefusalLlmError,
  isNonFallbackLlmError,
  isRetryableLlmError,
  isUnreachableLlmError
} from "../src/server/modules/llm/retry-policy.js";

/**
 * When a provider answers an error object down the streaming channel, the SDK
 * matches it against the delta schema, fails, and throws `AI_TypeValidationError`
 * — an object carrying only `{name, message}`. The provider's real status lives
 * as JSON *text* inside that message, so reading `error.status` finds nothing
 * and the decision falls through to prose matching.
 *
 * This shape, with an embedded `code: "500"`, is a common way for a transient
 * failure to arrive, and prose matching alone leaves it unretried.
 */
const wrap = (providerMessage: string, code = "500") =>
  `Type validation failed: Value: {"error":{"message":${JSON.stringify(providerMessage)},` +
  `"type":null,"param":null,"code":"${code}"}}.\nError message: [\n  {\n    "code": "invalid_union"`;

const TRANSIENT = wrap(
  "litellm.APIError: An error occurred while processing your request. You can retry " +
    "your request, or contact us through our help center at help.openai.com if the error " +
    "persists. Please include the request ID 5e6f7a8b-9c0d-4e1f-8a2b-4c5d6e7f8a9b in your message."
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
    // `code: "500"` identifies it.
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
    // A gateway may stamp every upstream error 500, so the status alone
    // cannot separate "the server is unhappy" from "your content is rejected".
    // Retrying identical content fails identically.
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
    // it. A rare shape, but the branch is wrong.
    const err = Object.assign(new Error("nothing quotable here"), { status: null, code: 503 });
    expect(isRetryableLlmError(err)).toBe(true);
  });

  test("a user cancellation is never retryable", () => {
    expect(isRetryableLlmError(new Error("WakeCanceledError: Stopped by user."))).toBe(false);
  });
});

describe("isUnreachableLlmError — the network, not the provider", () => {
  test("a host that did not resolve, as Bun's fetch reports it", () => {
    const error = Object.assign(new TypeError("getaddrinfo ENOTFOUND api.kilo.ai"), { code: "ENOTFOUND" });
    expect(isUnreachableLlmError(error)).toBe(true);
    expect(isRetryableLlmError(error)).toBe(true);
  });

  test("no route to the host, as Bun's fetch reports it", () => {
    const error = Object.assign(new TypeError("Was there a typo in the url or port?"), { code: "FailedToOpenSocket" });
    expect(isUnreachableLlmError(error)).toBe(true);
    expect(isRetryableLlmError(error)).toBe(true);
  });

  test("no route to the host, wrapped by the AI SDK and the stream collector", () => {
    // Probed on Bun 1.4.2: the code is only on the innermost cause.
    const fetchError = Object.assign(new TypeError("Was there a typo in the url or port?"), { code: "FailedToOpenSocket" });
    const apiCall = Object.assign(new Error("Cannot connect to API: Was there a typo in the url or port?"), { name: "AI_APICallError", cause: fetchError });
    const collected = Object.assign(new Error(apiCall.message), { cause: apiCall });
    expect(isUnreachableLlmError(collected)).toBe(true);
    expect(isRetryableLlmError(collected)).toBe(true);
  });

  // Bun 1.4.3 reports a socket it could not open by its errno, in the code and
  // at the head of the message (probed: EHOSTUNREACH, EAFNOSUPPORT); 1.4.2 said
  // FailedToOpenSocket for all of them. The sentence is what both share.
  test("no route to the host, as Bun 1.4.3's fetch reports it, by whichever errno", () => {
    for (const code of ["EHOSTUNREACH", "ENETUNREACH", "EAFNOSUPPORT"]) {
      const error = Object.assign(new TypeError(`${code}: Was there a typo in the url or port?`), { code });
      expect([code, isUnreachableLlmError(error), isRetryableLlmError(error)]).toEqual([code, true, true]);
    }
  });

  test("no route to the host on Bun 1.4.3, wrapped by the AI SDK and the stream collector", () => {
    const fetchError = Object.assign(new TypeError("EHOSTUNREACH: Was there a typo in the url or port?"), { code: "EHOSTUNREACH" });
    const apiCall = Object.assign(new Error("Cannot connect to API: EHOSTUNREACH: Was there a typo in the url or port?"), { name: "AI_APICallError", cause: fetchError });
    // A collector that says something of its own: only the causes still hold the sentence.
    const collected = Object.assign(new Error("The provider could not be reached."), { cause: apiCall });
    expect(isUnreachableLlmError(collected)).toBe(true);
    expect(isRetryableLlmError(collected)).toBe(true);
    expect(decideLlmFailure(collected, { candidateIndex: 0, attempt: 3, hasNext: true }).decision).toBe("retry");
  });

  test("a failed lookup quoted inside a wrapper's message", () => {
    expect(isUnreachableLlmError(new Error("Cannot connect to API: getaddrinfo EAI_AGAIN api.kilo.ai"))).toBe(true);
  });

  test("something that answered is not unreachable", () => {
    expect(isUnreachableLlmError(Object.assign(new Error("Service Unavailable"), { status: 503 }))).toBe(false);
    expect(isUnreachableLlmError(new Error("read ECONNRESET"))).toBe(false);
    expect(isUnreachableLlmError(Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" }))).toBe(false);
  });

  // Only Bun's own fetch error counts: its errno as the code, and that code at
  // the head of the sentence. An answer that merely quotes the sentence, as an
  // HTTP error or as an error sent inside the stream, is not it.
  test("an answer that only quotes Bun's sentence is not unreachable", () => {
    const quoted401 = Object.assign(new Error("Upstream said: Was there a typo in the url or port?"), { name: "AI_APICallError", statusCode: 401 });
    const collected401 = Object.assign(new Error(quoted401.message), { cause: quoted401 });
    expect(isUnreachableLlmError(collected401)).toBe(false);
    // Not retried at all: a 401 is not transient.
    expect(decideLlmFailure(collected401, { candidateIndex: 0, attempt: 1, hasNext: true }).decision).toBe("fallback");
    // Sent inside the stream: a code of its own, no status field.
    const inBand = Object.assign(new Error("EHOSTUNREACH: Was there a typo in the url or port?"), { code: "401" });
    expect(isUnreachableLlmError(inBand)).toBe(false);
    // The sentence with an errno in front, but no code to pair it with.
    expect(isUnreachableLlmError(new Error("EHOSTUNREACH: Was there a typo in the url or port?"))).toBe(false);
    // A code that is not the one at the head of the message.
    expect(isUnreachableLlmError(Object.assign(new Error("EHOSTUNREACH: Was there a typo in the url or port?"), { code: "ENETUNREACH" }))).toBe(false);
  });

  // A refused connection reached the host: not the three long retries. Bun
  // 1.4.3 puts ECONNREFUSED in its message, so the policy's old needle now
  // matches and it gets the one short retry every transient error gets; on
  // 1.4.2 the message named no errno and it got none.
  test("a refused connection on Bun 1.4.3 is not unreachable, and is retried once", () => {
    const refused = Object.assign(new TypeError("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED" });
    expect(isUnreachableLlmError(refused)).toBe(false);
    expect(decideLlmFailure(refused, { candidateIndex: 0, attempt: 1, hasNext: true }).decision).toBe("retry");
    expect(decideLlmFailure(refused, { candidateIndex: 0, attempt: 2, hasNext: true }).decision).toBe("fallback");
  });
});

// A cyber_policy rejection is not always repeated for the same request, so it
// gets the one retry a transient error gets and then moves to the next
// candidate, like a 500, although the gateway marks it 400 and not retryable.
test("a cyber_policy refusal is retried once on its model, then falls back, then fails", () => {
  const error = Object.assign(new Error("This request has been flagged for potentially high-risk cyber activity. Learn more here: https://platform.openai.com/docs/guides/safety-checks/cybersecurity (cyber_policy)"), { code: "cyber_policy", status: 400 });
  expect(decideLlmFailure(error, { candidateIndex: 0, attempt: 1, hasNext: true }).decision).toBe("retry");
  expect(decideLlmFailure(error, { candidateIndex: 0, attempt: 2, hasNext: true }).decision).toBe("fallback");
  expect(decideLlmFailure(error, { candidateIndex: 1, attempt: 1, hasNext: false }).decision).toBe("retry");
  expect(decideLlmFailure(error, { candidateIndex: 1, attempt: 2, hasNext: false }).decision).toBe("throw");
  // Its sentence is not a content refusal's (which is not retried).
  expect(isContentRefusalLlmError(error)).toBe(false);
});

test("a response the provider failed or never completed (collectStream's errors) is retried", () => {
  expect(isRetryableLlmError(new Error("The provider ended the response with an error (finish_reason: error)."))).toBe(true);
  expect(isRetryableLlmError(new Error("The response ended before the provider finished it: no output and no usage."))).toBe(true);
});
