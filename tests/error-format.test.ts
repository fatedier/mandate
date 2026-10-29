import { expect, test } from "bun:test";
import { formatErrorMessage, toUserFacingError } from "../src/server/platform/errors.js";

test("formatErrorMessage expands plain error objects", () => {
  expect(formatErrorMessage({ message: { code: 400, detail: "bad request" } })).toContain("bad request");
});

test("formatErrorMessage falls back to cause when Error message is object placeholder", () => {
  const err = new Error("[object Object]", { cause: { status: 500, body: "upstream failed" } });
  expect(formatErrorMessage(err)).toContain("upstream failed");
});

test("formatErrorMessage does not return [object Object] for plain objects", () => {
  expect(formatErrorMessage({ status: 429, message: "[object Object]" })).toContain("429");
});

test("formatErrorMessage does not expose placeholder Error stacks as user messages", () => {
  expect(formatErrorMessage(new Error("[object Object]"), "LLM call failed")).toBe("LLM call failed");
});

test("formatErrorMessage compacts DOMException metadata", () => {
  expect(formatErrorMessage(new DOMException("The operation timed out.", "TimeoutError")))
    .toBe("The operation timed out. (TimeoutError code=23)");
});

test("toUserFacingError classifies provider overloads with a short message", () => {
  const error = toUserFacingError({
    type: "error",
    sequence_number: 2,
    error: {
      type: "service_unavailable_error",
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded. Please try again later.",
      param: null
    }
  }, "LLM call failed");

  expect(error).toMatchObject({
    category: "provider_overloaded",
    code: "server_is_overloaded",
    message: "Model provider is overloaded. Please retry shortly.",
    retryable: true
  });
  expect(error.detail).toContain("Our servers are currently overloaded");
});

test("toUserFacingError hides unreadable object placeholders", () => {
  const error = toUserFacingError(new Error("[object Object]"), "LLM call failed");
  expect(error.message).toBe("LLM call failed");
  expect(error.message).not.toContain("[object Object]");
});

test("toUserFacingError classifies structured HTTP error fields", () => {
  const err = new Error("OpenAI Codex API HTTP 500 Internal Server Error") as Error & {
    status: number;
    code: string;
  };
  err.status = 500;
  err.code = "codex_http_500";

  expect(toUserFacingError(err, "LLM call failed")).toMatchObject({
    category: "provider_error",
    code: "codex_http_500",
    message: "Model provider returned an error. Please retry shortly.",
    retryable: true
  });
});

// OpenAI's cybersecurity check: a gateway marks it 400, which
// read as "rejected the request, check the configuration". The provider's
// own sentence says what happened, and the flag is not always repeated.
test("toUserFacingError: a cyber_policy flag keeps the provider's sentence and stays retryable", () => {
  const error = Object.assign(
    new Error("This request has been flagged for potentially high-risk cyber activity. Learn more here: https://platform.openai.com/docs/guides/safety-checks/cybersecurity (cyber_policy)"),
    { code: "cyber_policy", status: 400, cause: { code: "cyber_policy", type: "invalid_request", statusCode: 400, isRetryable: false } }
  );
  const shown = toUserFacingError(error);
  expect(shown).toMatchObject({ category: "content_flagged", code: "cyber_policy", retryable: true });
  expect(shown.message).toContain("flagged for potentially high-risk cyber activity");
});

// A request the provider refused says why, in the provider's own words: a
// general sentence and a guess about images would hide "unsupported image".
test("toUserFacingError: a rejected request carries the provider's own words", () => {
  const wrapped = 'gateway.BadRequestError: UpstreamException - {"error":{"message":"input[3].image[0]: this image is not one of the formats taken: webp, png, jpeg, gif. (request_id: req-0001)","type":"invalid_request_error","param":null,"code":"provider_invalid_request"}}';
  const shown = toUserFacingError(Object.assign(new Error(wrapped), { statusCode: 400 }));
  expect(shown.category).toBe("invalid_request");
  expect(shown.message).toBe("Model provider rejected the request: input[3].image[0]: this image is not one of the formats taken: webp, png, jpeg, gif. (request_id: req-0001) (provider_invalid_request)");
  expect(toUserFacingError(Object.assign(new Error("the model named is not served here"), { statusCode: 400 })).message)
    .toBe("Model provider rejected the request: the model named is not served here.");
});

test("toUserFacingError: a provider's long words are cut; none at all keeps the general sentence", () => {
  const long = toUserFacingError(Object.assign(new Error(`bad field: ${"x".repeat(1000)}`), { statusCode: 400 }));
  expect(long.message.startsWith("Model provider rejected the request: bad field: xxx")).toBe(true);
  expect(long.message.length <= 400).toBe(true);
  expect(toUserFacingError({ statusCode: 400 }, "LLM call failed").message)
    .toBe("Model provider rejected the request. Check the model, provider configuration, or input.");
});
