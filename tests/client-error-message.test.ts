import { describe, expect, test } from "bun:test";
import { formatUserFacingError } from "../src/client/lib/error-message.js";
import { errorText } from "../src/shared/error-text.js";

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

describe("errorText", () => {
  // It replaced 46 hand-written `err instanceof Error ? err.message : String(err)`
  // ternaries, so it must answer exactly what they did — including the
  // cases extractErrorMessage would "improve".
  const inline = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const cases: unknown[] = [
    new Error("boom"),
    new Error(""),
    new TypeError("  padded  "),
    new Error('{"error":{"message":"nested"}}'),
    "plain string",
    "first line\n    at stack frame",
    undefined,
    null,
    42,
    { message: "not an Error" }
  ];

  test("matches the inline ternary for every kind of thrown value", () => {
    expect(cases.map((value) => errorText(value))).toEqual(cases.map(inline));
  });

  test("a fallback replaces only non-Error values", () => {
    expect(errorText(new Error("real"), "fallback")).toBe("real");
    expect(errorText("thrown string", "fallback")).toBe("fallback");
    expect(errorText(undefined, "fallback")).toBe("fallback");
  });
});
