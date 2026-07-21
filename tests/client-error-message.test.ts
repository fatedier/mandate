import { expect, test } from "bun:test";
import { formatUserFacingError } from "../src/client/lib/error-message.js";

test("formatUserFacingError extracts nested provider errors from JSON strings", () => {
  const message = formatUserFacingError(JSON.stringify({
    type: "error",
    sequence_number: 2,
    error: {
      type: "service_unavailable_error",
      code: "server_is_overloaded",
      message: "Our servers are currently overloaded. Please try again later.",
      param: null
    }
  }));

  expect(message).toBe("Our servers are currently overloaded. Please try again later.");
});

test("formatUserFacingError hides placeholder object stacks from old wake errors", () => {
  const message = formatUserFacingError(JSON.stringify({
    name: "Error",
    message: "[object Object]",
    stack: "Error: [object Object]\n    at runLlmCandidates (/tmp/server.js:1:1)"
  }));

  expect(message).toBe("Model provider returned an unreadable error. Please retry.");
  expect(message).not.toContain("stack");
  expect(message).not.toContain("[object Object]");
});

test("formatUserFacingError keeps only the useful first line from stack strings", () => {
  expect(formatUserFacingError("OpenAI Codex API HTTP 500 Internal Server Error\n    at x"))
    .toBe("OpenAI Codex API HTTP 500 Internal Server Error");
});

test("formatUserFacingError truncates long fallback messages", () => {
  const message = formatUserFacingError(`OpenAI Codex API HTTP 500 ${"x".repeat(300)}`);
  expect(message.length).toBeLessThanOrEqual(183);
  expect(message.endsWith("...")).toBe(true);
});
