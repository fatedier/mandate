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

test("formatErrorMessage extracts provider error events", () => {
  expect(formatErrorMessage({
    type: "error",
    sequence_number: 2,
    error: {
      type: "service_unavailable_error",
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded. Please try again later.",
      param: null
    }
  })).toBe("Our servers are currently overloaded. Please try again later. (server_is_overloaded)");
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
